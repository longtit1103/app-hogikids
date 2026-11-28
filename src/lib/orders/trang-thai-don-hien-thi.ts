import type { OrderStatus } from "@/generated/prisma/client";

import { MAU_TRANG_THAI } from "@/components/trang-chu/mau-trang-chu";
import { ORDER_STATUS_META } from "@/lib/orders/order-status-meta";

/**
 * Nhãn + màu trạng thái đơn theo phong cách trang chủ, dùng cho tab, viên thuốc và drawer trang
 * Đơn hàng. `slug` lấy từ `ORDER_STATUS_META` (cùng slug bộ đọc URL hiểu), chấm `mau` lấy từ
 * `MAU_TRANG_THAI` (khớp token `--tq-*`), nền/chữ viên thuốc lấy nguyên từ bản mẫu đã duyệt.
 * Nhãn ngắn ("Thành công", "Hoàn", "Hủy") là nhãn trang chủ — khác nhãn dài của `ORDER_STATUS_META`.
 */
export type TrangThaiHienThi = { status: OrderStatus; slug: string; nhan: string; mau: string; nen: string; chu: string };

function tao(status: OrderStatus, nhan: string, nen: string, chu: string): TrangThaiHienThi {
  return { status, slug: ORDER_STATUS_META[status].slug, nhan, mau: MAU_TRANG_THAI[status], nen, chu };
}

/** Thứ tự tab: COMPLETED, SHIPPING, PENDING, RETURNED, CANCELLED. */
export const TRANG_THAI_HIEN_THI: readonly TrangThaiHienThi[] = [
  tao("COMPLETED", "Thành công", "#e3f5ea", "#0c5132"),
  tao("SHIPPING", "Đang giao", "#e6effb", "#1d4f91"),
  tao("PENDING", "Chờ xử lý", "#fdf0de", "#7a4f01"),
  tao("RETURNED", "Hoàn", "#f4ebe1", "#6b4420"),
  tao("CANCELLED", "Hủy", "#fdeaea", "#8e1f0b"),
];

const THEO_STATUS = Object.fromEntries(TRANG_THAI_HIEN_THI.map((t) => [t.status, t])) as Record<
  OrderStatus,
  TrangThaiHienThi
>;

export function trangThaiHienThi(s: OrderStatus): TrangThaiHienThi {
  return THEO_STATUS[s];
}
