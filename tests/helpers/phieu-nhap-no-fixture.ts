import { KEY_NO_PHAI_TRA_TU_NGAY } from "@/lib/no-phai-tra/cong-bat-no-phai-tra";
import { refIdChoPhieu } from "@/lib/nhap-hang/doi-chieu-phieu-nhap";
import { prisma } from "@/lib/prisma";

import { SHOP_KHO } from "./shop-ids-fixture";

/**
 * Fixture "Nợ phải trả — phiếu nhập" cho test tích hợp (`hogikids_test`): payload phiếu nhập Pancake
 * tối giản (đúng các trường `rutPhieuTuPayload` đọc), seed Bronze có `fetchedAt` điều khiển được, đặt /
 * gỡ mốc bật M, và tạo hồ sơ `PhieuNhapNo` trực tiếp.
 *
 * Bảng `RawPancakePurchase` và khoá `Setting.noPhaiTraTuNgay` KHÔNG nằm trong `truncateBusinessTables`
 * ⇒ suite gọi `donFixtureNoPhaiTra()` ở beforeEach + afterAll.
 */

export const vn = (iso: string) => new Date(`${iso}+07:00`);

export type PhieuMau = {
  uuid: string;
  displayId?: number;
  /** Naive = giờ UTC (bất biến #3) — vd "2026-09-20T03:00:00" = 10:00 VN ngày 20/09. */
  insertedAt: string;
  tongTien: number;
  status?: number;
};

/** Một dòng hàng = tổng phiếu ⇒ lưới kiểm `total_price = Σ dòng hàng` không kêu. */
export function payloadPhieu(p: PhieuMau): Record<string, unknown> {
  return {
    id: p.uuid,
    created_type: "actual_purchase",
    inserted_at: p.insertedAt,
    display_id: p.displayId ?? null,
    total_price: p.tongTien,
    total_quantity: 1,
    items: [{ quantity: 1, imported_price: p.tongTien }],
    status: p.status ?? 1,
    note: null,
  };
}

let demHash = 0;

/** Ghi một bản Bronze. `fetchedAt` muộn hơn ⇒ là bản "mới nhất" (DISTINCT ON). */
export async function seedBronze(p: PhieuMau, fetchedAt: Date = new Date()): Promise<void> {
  demHash += 1;
  await prisma.rawPancakePurchase.create({
    data: {
      shopId: SHOP_KHO,
      externalId: p.uuid,
      payloadHash: `npt-hash-${demHash}`,
      payload: payloadPhieu(p) as object,
      fetchedAt,
    },
  });
}

/** `null` ⇒ gỡ (chưa bật). Ngày `yyyy-MM-dd` giờ VN. */
export async function datMocM(ngay: string | null): Promise<void> {
  await prisma.setting.deleteMany({ where: { key: KEY_NO_PHAI_TRA_TU_NGAY } });
  if (ngay !== null) await prisma.setting.create({ data: { key: KEY_NO_PHAI_TRA_TU_NGAY, value: ngay } });
}

/** Dọn phần fixture nằm ngoài `truncateBusinessTables`. */
export async function donFixtureNoPhaiTra(): Promise<void> {
  await prisma.rawPancakePurchase.deleteMany();
  await datMocM(null);
}

/** Tạo hồ sơ phiếu nợ trực tiếp (không qua action) — cho test trả gộp / hậu kiểm. */
export async function taoPhieuNo(p: {
  uuid: string;
  maPhieu?: string;
  ngayPhieu?: Date;
  tongTien: number;
  daTraTruoc?: number;
  daHuy?: boolean;
}): Promise<string> {
  const r = await prisma.phieuNhapNo.create({
    data: {
      refId: refIdChoPhieu(p.uuid),
      shopId: SHOP_KHO,
      maPhieu: p.maPhieu ?? `#${p.uuid.slice(0, 4)}`,
      ngayPhieu: p.ngayPhieu ?? vn("2026-09-20T00:00:00"),
      tongTien: p.tongTien,
      daTraTruoc: p.daTraTruoc ?? 0,
      daHuy: p.daHuy ?? false,
    },
    select: { id: true },
  });
  return r.id;
}
