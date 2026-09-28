/**
 * Danh mục chi phí KHÔNG được phép ẩn — app tự ghi vào chúng, ẩn đi là tự chặn đường ghi của
 * chính mình mà không có gì báo:
 *  - `other`: chỗ hứng mọi khoản ghi tự động không thuộc danh mục nào (đối soát, hao hụt…).
 *  - `interest` (Lãi vay): màn Khoản vay ghi vào đây khi chủ shop duyệt kỳ trả nợ. Ẩn nó thì
 *    `validateCategory` (`src/lib/actions/expenses.ts`) từ chối ghi, và link drill
 *    `?danh_muc=interest` của dòng "Lãi vay" trong bảng Lãi/Lỗ dẫn vào bộ lọc rỗng.
 *
 * Module THUẦN (KHÔNG `"use server"`) vì cả server action lẫn Client Component Cài đặt cùng
 * đọc: hai nơi khoá theo hai danh sách chép tay khác nhau là lỗi chỉ lộ ra trên prod.
 */
export const DANH_MUC_KHOA_AN: readonly string[] = ["other", "interest"];

export const LOI_DANH_MUC_KHOA_AN = "Danh mục nhận ghi tự động, không thể ẩn";

export function laDanhMucKhoaAn(id: string): boolean {
  return DANH_MUC_KHOA_AN.includes(id);
}
