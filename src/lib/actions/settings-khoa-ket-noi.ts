"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import type { ActionResult } from "@/lib/actions/action-result";
import { dangPhucHoi, LOI_DANG_PHUC_HOI } from "@/lib/backup/khoa-bao-tri";
import { timNguonKetNoi, type NguonKetNoiId } from "@/lib/ket-noi/catalog-khoa-ket-noi";
import { xoaCacheCauHinhShop } from "@/lib/ket-noi/cau-hinh-shop";
import { chanDoiShopIdKhiCoDuLieu } from "@/lib/ket-noi/chan-doi-shop-id";
import { kiemTraMeta } from "@/lib/ket-noi/kiem-tra-meta";
import { kiemTraPancake } from "@/lib/ket-noi/kiem-tra-pancake";
import { kiemTraTiktokBusiness } from "@/lib/ket-noi/kiem-tra-tiktok-business";
import { kiemTraTiktokShop } from "@/lib/ket-noi/kiem-tra-tiktok-shop";
import type { KetQuaKiemTra } from "@/lib/ket-noi/kiem-tra-types";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";
import { luuTokenMetaVaoKho } from "@/lib/tokens/luu-token-meta";
import { doiTokenMetaDaiHan } from "@/lib/tokens/meta-doi-token-dai-han";

// ---- Cài đặt › Kết nối & Đồng bộ › Khóa kết nối nguồn dữ liệu ----------------
//
// Bất biến của cả file: KHÔNG BAO GIỜ đưa giá trị khóa/token vào message lỗi hay kết quả —
// mọi chuỗi trả về đều hiện nguyên văn trên UI (và có thể lọt vào log phía client).

/** Khóa API/token thực tế ~30–200 ký tự; 1000 là trần chống dán nhầm cả file. Một dòng duy nhất. */
const giaTriKhoaSchema = z.string().trim().min(1).max(1000).refine((v) => !/[\r\n]/.test(v), "không được xuống dòng");

/**
 * Lưu các ô người dùng đã nhập của MỘT nguồn. Ô bỏ trống = GIỮ NGUYÊN giá trị đang lưu
 * (trường bí mật không bao giờ hiện lại giá trị cũ nên "trống" không thể hiểu là "xóa").
 */
export async function luuKhoaKetNoi(
  nguonId: NguonKetNoiId,
  values: Record<string, string>
): Promise<ActionResult<{ daLuu: number }>> {
  await requireUser();
  if (dangPhucHoi()) return { ok: false, error: LOI_DANG_PHUC_HOI };

  const nguon = timNguonKetNoi(nguonId);
  if (!nguon) return { ok: false, error: "Nguồn không hợp lệ" };

  // CHỈ nhận key nằm trong danh mục của nguồn — key lạ là dấu hiệu client hỏng/bịa, chặn thẳng.
  const keyHopLe = new Set(nguon.truong.map((t) => t.key));
  for (const key of Object.keys(values)) {
    if (!keyHopLe.has(key)) return { ok: false, error: "Có trường không thuộc nguồn này — tải lại trang rồi thử lại" };
  }

  const canGhi: Array<[string, string]> = [];
  for (const truong of nguon.truong) {
    const tho = values[truong.key];
    if (tho === undefined || tho.trim() === "") continue; // trống = giữ nguyên
    const parsed = giaTriKhoaSchema.safeParse(tho);
    if (!parsed.success) {
      return { ok: false, error: `Ô "${truong.nhan}" không hợp lệ (tối đa 1000 ký tự, một dòng)`, field: truong.key };
    }
    canGhi.push([truong.key, parsed.data]);
  }
  if (canGhi.length === 0) return { ok: false, error: "Chưa nhập giá trị nào để lưu" };

  // Lưới shop ID: giá trị phải là chuỗi số, và KHÔNG đổi được khi kho thô đã có dữ liệu mang id
  // cũ (dòng cũ thành mồ côi ÂM THẦM — xem `chan-doi-shop-id.ts`). Message không chứa secret.
  const loiShopId = await chanDoiShopIdKhiCoDuLieu(canGhi);
  if (loiShopId) return { ok: false, error: loiShopId };

  try {
    await prisma.$transaction(
      canGhi.map(([key, value]) =>
        prisma.setting.upsert({ where: { key }, create: { key, value }, update: { value } })
      )
    );
  } catch {
    // KHÔNG đưa err.message vào body: lỗi Prisma có thể chứa giá trị khóa.
    return { ok: false, error: "Lỗi khi lưu khóa vào kho" };
  }

  // Shop ID có cache đọc phía ingest — xóa để giá trị vừa lưu có hiệu lực ngay trong process này.
  xoaCacheCauHinhShop();

  revalidatePath("/cai-dat");
  return { ok: true, data: { daLuu: canGhi.length } };
}

/**
 * Dispatch bằng `Map` chứ KHÔNG object literal: key kiểu `"constructor"` trên object literal
 * trả hàm prototype thay vì `undefined` — đã từng lọt cổng vì đúng bẫy này.
 */
const BO_KIEM_TRA = new Map<NguonKetNoiId, () => Promise<KetQuaKiemTra>>([
  ["pancake", kiemTraPancake],
  ["meta", kiemTraMeta],
  ["tiktok-shop", kiemTraTiktokShop],
  ["tiktok-business", kiemTraTiktokBusiness],
]);

/** Chỉ ĐỌC kho + gọi thử nguồn ngoài — không ghi gì nên không chặn lúc phục hồi. */
export async function kiemTraKetNoiNguon(nguonId: NguonKetNoiId): Promise<ActionResult<KetQuaKiemTra>> {
  await requireUser();
  const kiemTra = BO_KIEM_TRA.get(nguonId);
  if (!kiemTra) return { ok: false, error: "Nguồn không hợp lệ" };
  try {
    return { ok: true, data: await kiemTra() };
  } catch {
    return { ok: false, error: "Kiểm tra thất bại vì lỗi không lường trước — thử lại sau ít phút" };
  }
}

function ngayVn(epochGiay: number): string {
  return new Date(epochGiay * 1000).toLocaleDateString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh" });
}

export type KetQuaDoiTokenMetaUi = {
  hetHan: string;
  dataAccessHetHan: string;
  conNgay: number | null;
};

/**
 * "Thay token Meta" trên web: nhận token TƯƠI (Graph API Explorer) → đổi sang dài hạn 60 ngày →
 * hỏi hạn thật → ghi kho bằng ĐÚNG hàm route `/api/ingest/meta-token` dùng. Thay cho việc chạy
 * `scripts/meta-ads-lay-token.ts` trên máy dev.
 */
export async function doiVaLuuTokenMeta(tokenTuoi: string): Promise<ActionResult<KetQuaDoiTokenMetaUi>> {
  await requireUser();
  // Cùng lý do route POST chặn: nhận 200 rồi bị lượt phục hồi lùi bảng Setting = người dùng tin
  // token mới đã nằm trong kho trong khi kho quay về token cũ — hỏng lặng, phát hiện vài tuần sau.
  if (dangPhucHoi()) return { ok: false, error: LOI_DANG_PHUC_HOI };

  const parsed = giaTriKhoaSchema.safeParse(tokenTuoi);
  if (!parsed.success) return { ok: false, error: "Token dán vào không hợp lệ — copy lại nguyên vẹn từ Graph API Explorer" };

  const cauHinh = await prisma.setting.findMany({ where: { key: { in: ["metaAdsAppId", "metaAdsAppSecret"] } } });
  const theoKey = new Map(cauHinh.map((r) => [r.key, r.value]));
  const appId = theoKey.get("metaAdsAppId") ?? "";
  const appSecret = theoKey.get("metaAdsAppSecret") ?? "";
  if (!appId || !appSecret) {
    return { ok: false, error: "Chưa lưu App ID / App Secret của Meta — điền và lưu 2 ô phía trên trước" };
  }

  let doi;
  try {
    doi = await doiTokenMetaDaiHan({ tokenTuoi: parsed.data, appId, appSecret });
  } catch (err) {
    // Message của `doiTokenMetaDaiHan` cam kết không chứa token/secret — hiện được nguyên văn.
    return { ok: false, error: err instanceof Error ? err.message : "Đổi token thất bại" };
  }
  if (!doi.conSong) {
    return { ok: false, error: "Facebook báo token đổi ra KHÔNG còn hiệu lực — lấy lại token tươi rồi thử lại" };
  }

  try {
    await luuTokenMetaVaoKho({
      accessToken: doi.tokenMoi,
      expireAt: doi.hetHanEpoch,
      dataAccessExpireAt: doi.dataAccessHetHanEpoch,
    });
  } catch {
    return { ok: false, error: "Đổi token thành công nhưng LƯU thất bại — thử lại" };
  }

  revalidatePath("/cai-dat");
  return {
    ok: true,
    data: {
      hetHan: doi.hetHanEpoch ? ngayVn(doi.hetHanEpoch) : "không hết hạn",
      dataAccessHetHan: doi.dataAccessHetHanEpoch ? ngayVn(doi.dataAccessHetHanEpoch) : "không hết hạn",
      conNgay: doi.hetHanEpoch ? Math.floor((doi.hetHanEpoch * 1000 - Date.now()) / 86_400_000) : null,
    },
  };
}
