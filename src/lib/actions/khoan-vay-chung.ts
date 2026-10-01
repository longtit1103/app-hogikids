import { startOfDay } from "date-fns";
import { z } from "zod";

import { LoiDuNoAm } from "@/lib/so-quy/vi-tu-du-no";
import { laLoiDongTienBan, THONG_BAO_KHOA_DONG_TIEN_BAN } from "@/lib/so-quy/khoa-dong-tien-co-han";

/**
 * Phần DÙNG CHUNG của hai file action khoản vay (`khoan-vay.ts` · `tat-toan-thau-chi.ts`).
 *
 * Vì sao tách ra: file `"use server"` CHỈ được export async function, nên một class lỗi / một schema
 * zod / một hằng option không thể ở đó rồi cho file kia import. Module này CỐ Ý không có `"use server"`.
 *
 * Nằm trong `src/lib/actions/` là có chủ ý: lưới `tests/khoa-bao-tri-duong-ghi.test.ts` quét thư mục
 * này tìm `export async function` — ở đây không có hàm async nào nên lưới không bị nhiễu, mà file vẫn
 * đứng cạnh đúng hai chủ dùng nó.
 */

/** Lãi/gốc của một kỳ ĐƯỢC PHÉP bằng 0 (kỳ ân hạn, hoặc chỉ trả lãi). Trần 2 tỷ = ngưỡng Prisma Int. */
export const soTienKySchema = z.coerce
  .number()
  .int("Số tiền phải là số nguyên")
  .min(0, "Số tiền không âm")
  .max(2_000_000_000, "Số tiền quá lớn (tối đa 2 tỷ)");

/**
 * Lỗi HỢP ĐỒNG nghiệp vụ (câu đã tiếng Việt sẵn). Ném từ trong transaction để Prisma rollback trọn
 * — không có ca "ghi lãi xong mới phát hiện gốc vượt dư nợ".
 */
export class LoiHopDong extends Error {
  constructor(
    message: string,
    public readonly field?: string
  ) {
    super(message);
    this.name = "LoiHopDong";
  }
}

/**
 * P2025 = "record not found" của Prisma — CHỈ mã này mới là "không tìm thấy" (cùng lý do với
 * `cash-movements.ts`). P2002 chỉ có thể là `Expense.refId` trùng ⇒ đúng nghĩa "kỳ đã ghi".
 */
export function loiKhoanVay(e: unknown, macDinh: string): { error: string; field?: string } {
  if (e instanceof LoiHopDong) return { error: e.message, field: e.field };
  if (e instanceof LoiDuNoAm) return { error: e.message };
  // Chờ khoá dòng `Loan` quá hạn (lượt khác đang giữ) hoặc transaction quá hạn (P2028) — đã lùi, không ghi gì.
  if (laLoiDongTienBan(e)) return { error: THONG_BAO_KHOA_DONG_TIEN_BAN };
  const code = (e as { code?: string })?.code;
  if (code === "P2025") return { error: "Không tìm thấy khoản vay" };
  if (code === "P2002") return { error: "Kỳ này đã được ghi" };
  return { error: macDinh };
}

export function cungNgay(a: Date, b: Date): boolean {
  return startOfDay(a).getTime() === startOfDay(b).getTime();
}

/**
 * Mã lỗi NGẮN cho `ghiChu.lyDo` của dòng nhật ký LOI (lượt ghi tiền bị từ chối / hỏng): mã Prisma
 * (`P2025`…) nếu có, không thì tên lớp lỗi (`LoiDuNoAm`, `LoiHopDong`…). CỐ Ý không ghi `message` —
 * câu báo có thể chứa số tiền / dữ liệu form, nhật ký chỉ cần biết LOẠI lỗi.
 */
export function maLoiNhatKy(e: unknown): string {
  const code = (e as { code?: unknown } | null)?.code;
  if (typeof code === "string" && /^[A-Z0-9_]{1,40}$/.test(code)) return code;
  if (e instanceof Error && /^[A-Za-z0-9_]{1,60}$/.test(e.name)) return e.name;
  return "KHONG_RO";
}
