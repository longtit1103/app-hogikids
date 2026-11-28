import type { OrderStatus } from "@/generated/prisma/client";

import type { DongDonHang, DongDonHangChe } from "@/lib/orders/don-hang-kieu-du-lieu";

import { maDonBenSan } from "./orders";

/**
 * Đổi dòng thô của CTE `don` (`orders-lai-tung-don-sql.ts`) sang kiểu hợp đồng trang Đơn hàng. Mọi số đi
 * qua `soNguyenAnToan` — cột `bigint` (lãi, giá vốn, tổng) KHÔNG được làm tròn câm.
 */

const TRANG_THAI_DON: readonly OrderStatus[] = ["PENDING", "SHIPPING", "COMPLETED", "RETURNED", "CANCELLED"];

/** Chuỗi trạng thái từ SQL (`status::text`) → `OrderStatus`; giá trị lạ ⇒ ném (không đoán). */
export function trangThaiDon(giaTri: string): OrderStatus {
  const s = TRANG_THAI_DON.find((t) => t === giaTri);
  if (!s) throw new Error(`Trạng thái đơn lạ từ database: ${giaTri}`);
  return s;
}

/**
 * `bigint`/`number` từ `$queryRaw` → `number`. Ngoài miền số nguyên an toàn, hoặc kiểu lạ (vd `Decimal` do
 * quên ép `::bigint` sau `SUM`, hay `null`) ⇒ ném: một con số tiền sai lặng lẽ tệ hơn trang lỗi.
 */
export function soNguyenAnToan(giaTri: unknown, ten: string): number {
  if (typeof giaTri === "number" && Number.isSafeInteger(giaTri)) return giaTri;
  if (
    typeof giaTri === "bigint" &&
    giaTri <= BigInt(Number.MAX_SAFE_INTEGER) &&
    giaTri >= BigInt(Number.MIN_SAFE_INTEGER)
  ) {
    return Number(giaTri);
  }
  throw new Error(`Số "${ten}" từ database không phải số nguyên an toàn: ${String(giaTri)}`);
}

/** Một dòng `SELECT * FROM don` (CTE dựng với `cotHienThi = true`). */
export type HangDon = {
  id: string;
  code: string;
  pancake_id: string;
  backfilled_from_mirror: boolean;
  ordered_at: Date;
  status_changed_at: Date | null;
  channel_id: string;
  channel_name: string;
  channel_color: string;
  ten_khach: string | null;
  items_total: unknown;
  discount: unknown;
  platform_fee_est: unknown;
  returned_fee: unknown;
  status: string;
  hop_le: boolean;
  phi_tam: boolean;
  so_dong: unknown;
  tong_sl: unknown;
  sp_dau_ten: string | null;
  sp_dau_sl: unknown;
  // Chỉ có ở nhánh đủ quyền giá vốn.
  cogs?: unknown;
  lai_don?: unknown;
  thieu_gia_von?: boolean;
};

/** Dòng nhánh che — dựng tường minh từng trường, không trải `h` (cột lạ không bao giờ lọt ra client). */
export function dongCheTuHang(h: HangDon): DongDonHangChe {
  const soDongHang = soNguyenAnToan(h.so_dong, "so_dong");
  return {
    id: h.id,
    code: h.code,
    maSan: maDonBenSan({ pancakeId: h.pancake_id, backfilledFromMirror: h.backfilled_from_mirror, channelId: h.channel_id }),
    orderedAt: h.ordered_at,
    statusChangedAt: h.status_changed_at,
    channelId: h.channel_id,
    channelName: h.channel_name,
    channelColor: h.channel_color,
    tenKhach: h.ten_khach,
    sanPhamDau:
      soDongHang > 0 && h.sp_dau_ten !== null
        ? { ten: h.sp_dau_ten, soLuong: soNguyenAnToan(h.sp_dau_sl, "sp_dau_sl") }
        : null,
    soDongHang,
    tongSoLuong: soNguyenAnToan(h.tong_sl, "tong_sl"),
    itemsTotal: soNguyenAnToan(h.items_total, "items_total"),
    discount: soNguyenAnToan(h.discount, "discount"),
    platformFeeEst: soNguyenAnToan(h.platform_fee_est, "platform_fee_est"),
    returnedFee: soNguyenAnToan(h.returned_fee, "returned_fee"),
    status: trangThaiDon(h.status),
    phiTamTinh: h.phi_tam,
  };
}

/** Dòng nhánh đủ quyền — CHỈ gọi khi câu SQL chạy với `coQuyenGiaVon = true`. */
export function dongDayTuHang(h: HangDon): DongDonHang {
  if (typeof h.thieu_gia_von !== "boolean") throw new Error("Thiếu cột thieu_gia_von — câu SQL không phải nhánh đủ quyền");
  return { ...dongCheTuHang(h), laiDon: soNguyenAnToan(h.lai_don, "lai_don"), thieuGiaVon: h.thieu_gia_von };
}
