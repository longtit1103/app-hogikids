import type { KhoanVayRow } from "@/lib/so-quy/khoan-vay-queries";

/**
 * Đếm khoản vay CÒN HIỆU LỰC đang có kỳ trả nợ CHỜ DUYỆT (tối đa 1 kỳ/khoản) — cùng phép đếm cho
 * dòng cảnh báo "N khoản vay có kỳ trả nợ chưa ghi" (`so-quy-canh-bao.tsx`) ở cả thẻ Quỹ (tab Dòng
 * tiền) lẫn tab Sổ quỹ, tránh viết lại hai nơi rồi một chỗ đổi luật mà chỗ kia quên theo.
 */
export function demKhoanVayCoKyCho(loans: KhoanVayRow[]): number {
  return loans.filter((l) => l.kyCho !== null && l.closedAt === null).length;
}
