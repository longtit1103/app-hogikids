import { format, startOfDay } from "date-fns";
import { z } from "zod";

import { LoiDongTienTruocM } from "@/lib/no-phai-tra/chan-dong-tien-truoc-m";
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
export function loiKhoanVay(
  e: unknown,
  macDinh: string
): { error: string; field?: string; code?: string } {
  if (e instanceof LoiHopDong) return { error: e.message, field: e.field };
  // Đã bật nợ phải trả mà lượt này ghi/xoá tiền ngày < M — cùng mã `DA_BAT_NO_PHAI_TRA` với sổ chi phí.
  if (e instanceof LoiDongTienTruocM) return { error: e.message, field: e.field, code: e.code };
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

/**
 * CÂU TỪ CHỐI khi đã bật nợ phải trả (mốc M) — mỗi câu chỉ ĐÚNG đường gỡ của action, luật thì dùng chung
 * `chanDongTienTruocM`. Tiền ngày < M đã chốt vào điều chỉnh mở sổ (`CUTOVER_*`); ghi/xoá thêm là quỹ từ M lệch
 * tiền thật đúng số đó.
 */
const ngayM = (mocM: Date) => format(mocM, "dd/MM/yyyy");

/**
 * Duyệt kỳ có ngày đến hạn < M: lối duy nhất còn lại là "Ngân hàng không thu kỳ này" (chỉ đóng dấu kỳ, không
 * ghi đồng nào) — chủ shop chốt 13/10: lãi kỳ đó không vào Lãi/Lỗ, đổi lại quỹ từ M giữ đúng tiền thật.
 */
export function cauKyVayTruocM(ngayKy: Date): (mocM: Date) => string {
  return (mocM) =>
    `Kỳ ${format(ngayKy, "dd/MM")} đến hạn trước ngày bật theo dõi nợ (${ngayM(mocM)}) — tiền kỳ này đã nằm ` +
    `trong số dư mở sổ. Đóng kỳ bằng 'Ngân hàng không thu kỳ này' (lãi kỳ này không vào Lãi/Lỗ).`;
}

/** Tất toán (thấu chi, hoặc khoản có tiền gửi bắt buộc phải hoàn) đề ngày < M. */
export function cauTatToanTruocM(mocM: Date): string {
  return (
    `Ngày tất toán phải từ ngày bật theo dõi nợ (${ngayM(mocM)}) trở đi — tiền trước ngày đó đã chốt vào số ` +
    `dư mở sổ.`
  );
}

/**
 * Tất toán khoản vay có tiền gửi bắt buộc đề ngày < M. CỐ Ý không gợi ý "chọn ngày từ ngày bật" như
 * `cauTatToanTruocM`: ngân hàng hoàn tiền gửi trước ngày bật thì tiền đó đã nằm trong số dư mở sổ, đề ngày ≥ M là
 * ghi `DEPOSIT_IN` lần hai (quỹ cao hơn tiền thật đúng số tiền gửi). Bước bật đã đòi tất toán khoản loại này trước
 * (`CON_TIEN_GUI_CHUA_TAT_TOAN_TRUOC_M`).
 */
export function cauTatToanTienGuiTruocM(mocM: Date): string {
  return (
    `Không ghi được ngày tất toán trước ngày bật theo dõi nợ (${ngayM(mocM)}). Tiền gửi ngân hàng đã hoàn / cấn ` +
    `trừ trước ngày bật đã nằm trong số dư mở sổ — KHÔNG tất toán lại với ngày từ ngày bật trở đi (tiền gửi sẽ ` +
    `bị đếm hai lần). Cần tất toán khoản này thì phải làm TRƯỚC khi bật.`
  );
}

/**
 * Khoản mới giải ngân < M: tiền giải ngân đã nằm trong số dư mở sổ ⇒ khai "mang sang" với dư nợ còn lại (không
 * sinh dòng `LOAN_IN`). KHÔNG đổi ngày dòng giải ngân sang M: bất biến `LOAN_IN.date = startOfDay(startDate)`.
 */
export function cauGiaiNganTruocM(mocM: Date): string {
  return (
    `Khoản giải ngân trước ngày bật theo dõi nợ (${ngayM(mocM)}) — tiền đó đã nằm trong số dư mở sổ. Khai ` +
    `chế độ "mang sang" với dư nợ còn lại.`
  );
}

/**
 * THẤU CHI có ngày rút < M: khoản này đã được đối chiếu lúc bật (dư nợ + quỹ khớp tiền thật tại M−1) ⇒ sau bật
 * không tạo (kể cả "mang sang"), không sửa dư nợ / ngày rút, không xoá — làm vậy dư nợ và quỹ lệch khỏi lúc
 * chốt. Thấu chi đang dùng trước M phải khai TRƯỚC khi bật.
 */
export function cauThauChiTruocM(mocM: Date): string {
  return (
    `Thấu chi dùng từ trước ngày bật theo dõi nợ (${ngayM(mocM)}) phải khai trước khi bật — khoản này đã được ` +
    `đối chiếu lúc bật, tạo / sửa dư nợ / ngày rút / xoá sẽ làm dư nợ và quỹ lệch khỏi lúc chốt.`
  );
}
