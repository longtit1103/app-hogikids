"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import type { ActionResult } from "@/lib/actions/action-result";
import { kiemQuyenXemGiaVon } from "@/lib/actions/cong-gia-von";
import { dangPhucHoi, LOI_DANG_PHUC_HOI } from "@/lib/backup/khoa-bao-tri";
import { kiemKhongPhucHoiTrongTx, LoiDangPhucHoiTrongTx } from "@/lib/backup/kiem-khong-phuc-hoi-trong-tx";
import type { CostImportRow } from "@/lib/import/cost-excel";
import { ghiNhatKy } from "@/lib/nhat-ky/ghi-nhat-ky";
import { HANH_DONG } from "@/lib/nhat-ky/hanh-dong";
import { prisma } from "@/lib/prisma";
import { congAction } from "@/lib/quyen/cong-action";

const money = z.coerce.number().int().min(0).max(1_000_000_000);
const thresholdValue = z.coerce.number().int().min(0).max(1_000_000);

const importRowSchema = z.object({
  sku: z.string().min(1),
  costPrice: money,
  lowStockThreshold: thresholdValue.nullable(),
});

export type CostDiff = {
  sku: string;
  matchedVariants: number;
  oldCost: number;
  newCost: number;
  oldThreshold: number | null;
  newThreshold: number | null;
  status: "OK" | "MULTI" | "NOT_FOUND";
};

/** Lãi đơn dùng giá vốn hiện hành → đổi giá vốn phải làm mới cả 3 màn. */
function revalidateViews(): void {
  revalidatePath("/san-pham");
  revalidatePath("/ton-kho");
  revalidatePath("/don-hang");
}

/**
 * P2025 = "record not found" của Prisma — CHỈ mã này mới là "không tìm thấy biến thể". Lỗi khác (mất
 * kết nối, nhật ký hỏng…) mà đội lốt "không tìm thấy" thì chủ shop tưởng biến thể đã bị gỡ, trong
 * khi thứ cần làm là thử lại. Log đủ phía server; câu cho client là chữ cố định, không lộ message thô.
 * Module-private (file "use server" chỉ được export async function).
 */
function loiSuaBienThe(e: unknown, tenAction: string, cauLoiHeThong: string): ActionResult {
  // Lượt phục hồi bắt đầu giữa transaction (đã cuộn lại) — câu "đang phục hồi", không phải lỗi hệ thống.
  if (e instanceof LoiDangPhucHoiTrongTx) return { ok: false, error: LOI_DANG_PHUC_HOI };
  if ((e as { code?: string })?.code === "P2025") return { ok: false, error: "Không tìm thấy biến thể" };
  console.error(`${tenAction} failed`, e);
  return { ok: false, error: cauLoiHeThong };
}

export async function updateVariantCost(variantId: string, costPrice: number): Promise<ActionResult> {
  const cong = await congAction("san-pham:sua");
  if (!cong.ok) return cong;
  const giaVon = await kiemQuyenXemGiaVon(cong.nguoiDung);
  if (!giaVon.ok) return giaVon;
  if (dangPhucHoi()) return { ok: false, error: LOI_DANG_PHUC_HOI };
  const parsed = money.safeParse(costPrice);
  if (!parsed.success) return { ok: false, error: "Giá vốn không hợp lệ", field: "costPrice" };
  try {
    await prisma.$transaction(async (tx) => {
      await tx.variant.update({ where: { id: variantId }, data: { costPrice: parsed.data } });
      kiemKhongPhucHoiTrongTx(); // sau khoá dòng (UPDATE) — cờ bật giữa chừng ⇒ cuộn lại
      await ghiNhatKy(tx, {
        actor: cong.nguoiDung,
        hanhDong: HANH_DONG.GIA_VON_SUA,
        doiTuong: { loai: "Variant", id: variantId },
      });
      kiemKhongPhucHoiTrongTx(); // câu cuối, ngay trước COMMIT
    });
    revalidateViews();
    return { ok: true, data: undefined };
  } catch (e) {
    return loiSuaBienThe(e, "updateVariantCost", "Không lưu được giá vốn — lỗi hệ thống, thử lại sau.");
  }
}

/** threshold = null → dùng ngưỡng mặc định (Setting). */
export async function updateVariantThreshold(variantId: string, threshold: number | null): Promise<ActionResult> {
  // Ngưỡng tồn không phải dữ liệu giá vốn ⇒ chỉ cần `san-pham:sua` (không kèm quyền xem giá vốn).
  const cong = await congAction("san-pham:sua");
  if (!cong.ok) return cong;
  if (dangPhucHoi()) return { ok: false, error: LOI_DANG_PHUC_HOI };
  const parsed = thresholdValue.nullable().safeParse(threshold);
  if (!parsed.success) return { ok: false, error: "Ngưỡng không hợp lệ", field: "threshold" };
  try {
    await prisma.$transaction(async (tx) => {
      await tx.variant.update({ where: { id: variantId }, data: { lowStockThreshold: parsed.data } });
      await ghiNhatKy(tx, {
        actor: cong.nguoiDung,
        hanhDong: HANH_DONG.NGUONG_TON_SUA,
        doiTuong: { loai: "Variant", id: variantId },
      });
    });
    revalidateViews();
    return { ok: true, data: undefined };
  } catch (e) {
    return loiSuaBienThe(e, "updateVariantThreshold", "Không lưu được ngưỡng tồn — lỗi hệ thống, thử lại sau.");
  }
}

/**
 * Áp giá vốn cho TẤT CẢ biến thể của 1 sản phẩm (fast path thời trang: 1 mẫu chung giá vốn).
 * Client tự tính & confirm khi có biến thể đang có giá khác trước khi gọi (user chốt: ghi đè có xác nhận).
 * Đặt giá tuyệt đối → chạy lại idempotent.
 */
export async function updateProductCost(
  productId: string,
  costPrice: number,
): Promise<ActionResult<{ updated: number }>> {
  const cong = await congAction("san-pham:sua");
  if (!cong.ok) return cong;
  const giaVon = await kiemQuyenXemGiaVon(cong.nguoiDung);
  if (!giaVon.ok) return giaVon;
  if (dangPhucHoi()) return { ok: false, error: LOI_DANG_PHUC_HOI };
  const parsed = money.safeParse(costPrice);
  if (!parsed.success) return { ok: false, error: "Giá vốn không hợp lệ", field: "costPrice" };
  try {
    const count = await prisma.$transaction(async (tx) => {
      const { count: n } = await tx.variant.updateMany({ where: { productId }, data: { costPrice: parsed.data } });
      kiemKhongPhucHoiTrongTx(); // sau lượt ghi (đã khoá dòng) — cờ phục hồi bật giữa chừng ⇒ cuộn lại
      // Không dòng nào đổi ⇒ không có thao tác nào để ghi nhật ký.
      if (n > 0) {
        await ghiNhatKy(tx, {
          actor: cong.nguoiDung,
          hanhDong: HANH_DONG.GIA_VON_SUA,
          doiTuong: { loai: "Product", id: productId },
          ghiChu: { soDong: n },
        });
      }
      kiemKhongPhucHoiTrongTx(); // câu cuối, ngay trước COMMIT
      return n;
    });
    // count=0 = sản phẩm không có biến thể nào (vd đã bị gỡ khi đồng bộ) → báo lỗi, tránh "thành công ảo".
    if (count === 0) return { ok: false, error: "Không tìm thấy biến thể để áp giá vốn" };
    revalidateViews();
    return { ok: true, data: { updated: count } };
  } catch (e) {
    if (e instanceof LoiDangPhucHoiTrongTx) return { ok: false, error: LOI_DANG_PHUC_HOI };
    console.error("updateProductCost failed", e);
    return { ok: false, error: "Không áp được giá vốn" };
  }
}

/** Áp ngưỡng cảnh báo cho TẤT CẢ biến thể của 1 sản phẩm. threshold = null → dùng ngưỡng mặc định. */
export async function updateProductThreshold(
  productId: string,
  threshold: number | null,
): Promise<ActionResult<{ updated: number }>> {
  // Ngưỡng tồn không phải dữ liệu giá vốn ⇒ chỉ cần `san-pham:sua` (không kèm quyền xem giá vốn).
  const cong = await congAction("san-pham:sua");
  if (!cong.ok) return cong;
  if (dangPhucHoi()) return { ok: false, error: LOI_DANG_PHUC_HOI };
  const parsed = thresholdValue.nullable().safeParse(threshold);
  if (!parsed.success) return { ok: false, error: "Ngưỡng không hợp lệ", field: "threshold" };
  try {
    const count = await prisma.$transaction(async (tx) => {
      const { count: n } = await tx.variant.updateMany({
        where: { productId },
        data: { lowStockThreshold: parsed.data },
      });
      if (n > 0) {
        await ghiNhatKy(tx, {
          actor: cong.nguoiDung,
          hanhDong: HANH_DONG.NGUONG_TON_SUA,
          doiTuong: { loai: "Product", id: productId },
          ghiChu: { soDong: n },
        });
      }
      return n;
    });
    if (count === 0) return { ok: false, error: "Không tìm thấy biến thể để áp ngưỡng" };
    revalidateViews();
    return { ok: true, data: { updated: count } };
  } catch (e) {
    console.error("updateProductThreshold failed", e);
    return { ok: false, error: "Không áp được ngưỡng" };
  }
}

/** Preview đọc-only: nhóm variant theo sku → OK/MULTI (>1)/NOT_FOUND (0). */
export async function previewCostImport(rows: CostImportRow[]): Promise<ActionResult<{ diffs: CostDiff[] }>> {
  // Bảng so sánh trả giá vốn ĐANG CÓ ⇒ cùng cổng với lượt ghi (sửa + xem giá vốn).
  const cong = await congAction("san-pham:sua");
  if (!cong.ok) return cong;
  const giaVon = await kiemQuyenXemGiaVon(cong.nguoiDung);
  if (!giaVon.ok) return giaVon;
  // Trần phòng cạn bộ nhớ khi validate mảng lớn (zod < 4.6.6); file giá vốn lớn nhất đã import < 1000 dòng.
  const parsed = z.array(importRowSchema).max(5000).safeParse(rows);
  if (!parsed.success) return { ok: false, error: "Dữ liệu import không hợp lệ" };
  const clean = parsed.data;

  const skus = [...new Set(clean.map((r) => r.sku))];
  const variants = skus.length
    ? await prisma.variant.findMany({
        where: { sku: { in: skus } },
        select: { sku: true, costPrice: true, lowStockThreshold: true },
      })
    : [];
  const bySku = new Map<string, { costPrice: number; lowStockThreshold: number | null }[]>();
  for (const v of variants) {
    const arr = bySku.get(v.sku) ?? [];
    arr.push({ costPrice: v.costPrice, lowStockThreshold: v.lowStockThreshold });
    bySku.set(v.sku, arr);
  }

  const diffs: CostDiff[] = clean.map((r) => {
    const matches = bySku.get(r.sku) ?? [];
    const first = matches[0];
    return {
      sku: r.sku,
      matchedVariants: matches.length,
      oldCost: first?.costPrice ?? 0,
      newCost: r.costPrice,
      oldThreshold: first?.lowStockThreshold ?? null,
      newThreshold: r.lowStockThreshold,
      status: matches.length === 0 ? "NOT_FOUND" : matches.length > 1 ? "MULTI" : "OK",
    };
  });
  return { ok: true, data: { diffs } };
}

/** Áp giá vốn: 1 transaction; sku trùng nhiều variant → áp TẤT CẢ; đặt giá tuyệt đối → chạy lại = idempotent. */
export async function importCostPrices(
  rows: CostImportRow[],
): Promise<ActionResult<{ updatedVariants: number; multiSkus: string[]; notFound: string[] }>> {
  const cong = await congAction("san-pham:sua");
  if (!cong.ok) return cong;
  const giaVon = await kiemQuyenXemGiaVon(cong.nguoiDung);
  if (!giaVon.ok) return giaVon;
  if (dangPhucHoi()) return { ok: false, error: LOI_DANG_PHUC_HOI };
  // Trần phòng cạn bộ nhớ khi validate mảng lớn (zod < 4.6.6); file giá vốn lớn nhất đã import < 1000 dòng.
  const parsed = z.array(importRowSchema).max(5000).safeParse(rows);
  if (!parsed.success) return { ok: false, error: "Dữ liệu import không hợp lệ" };
  const clean = parsed.data;

  try {
    const out = await prisma.$transaction(async (tx) => {
      let updatedVariants = 0;
      const multiSkus: string[] = [];
      const notFound: string[] = [];
      for (const r of clean) {
        const data: { costPrice: number; lowStockThreshold?: number } = { costPrice: r.costPrice };
        if (r.lowStockThreshold !== null) data.lowStockThreshold = r.lowStockThreshold; // null = giữ nguyên ngưỡng
        const { count } = await tx.variant.updateMany({ where: { sku: r.sku }, data });
        kiemKhongPhucHoiTrongTx(); // sau lượt ghi đầu (và mọi lượt sau) — cờ bật giữa chừng ⇒ cuộn lại cả lượt
        if (count === 0) notFound.push(r.sku);
        else {
          updatedVariants += count;
          if (count > 1) multiSkus.push(r.sku);
        }
      }
      await ghiNhatKy(tx, {
        actor: cong.nguoiDung,
        hanhDong: HANH_DONG.GIA_VON_IMPORT,
        ghiChu: { soDong: updatedVariants },
      });
      kiemKhongPhucHoiTrongTx(); // câu cuối, ngay trước COMMIT
      return { updatedVariants, multiSkus, notFound };
    });
    revalidateViews();
    return { ok: true, data: out };
  } catch (e) {
    if (e instanceof LoiDangPhucHoiTrongTx) return { ok: false, error: LOI_DANG_PHUC_HOI };
    return { ok: false, error: "Lỗi khi áp giá vốn" };
  }
}
