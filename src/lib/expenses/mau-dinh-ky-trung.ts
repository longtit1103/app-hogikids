import { formatVnd } from "@/lib/format";

/**
 * Nhận diện mẫu chi định kỳ "có vẻ trùng" khi TẠO khoản chi lặp hàng tháng. Hàm thuần — phần đọc DB
 * (cùng danh mục + cùng kênh + đang chạy, dưới khoá nhóm) nằm ở `createExpense`.
 *
 * Tiêu chí hẹp hơn cổng của "Bật lại": danh mục `fixed` gom cả lương/điện/nhà nên hai khoản hợp lệ
 * cùng nhóm rất phổ biến — chỉ hỏi khi CÙNG số tiền (bấm lại sau lỗi mạng, quên đã có mẫu) hoặc CÙNG
 * mô tả không rỗng (đổi giá nhưng giữ tên, quên dừng mẫu cũ).
 */

/** Mã lỗi server khi tạo/bật lại khoản định kỳ mà đã có mẫu cùng nhóm đang chạy — gửi lại kèm `xacNhanTrung`. */
export const DINH_KY_TRUNG_MAU_DANG_CHAY = "DINH_KY_TRUNG_MAU_DANG_CHAY";

export type MauDinhKyDangChay = { description: string; amount: number };

/** Mô tả so khớp: bỏ khoảng trắng đầu/cuối + không phân biệt hoa/thường. Rỗng ⇒ không tính. */
function chuanHoaMoTa(moTa: string): string {
  return moTa.trim().toLowerCase();
}

function laTrung(mau: MauDinhKyDangChay, moi: MauDinhKyDangChay): boolean {
  if (mau.amount === moi.amount) return true;
  const moTaMoi = chuanHoaMoTa(moi.description);
  return moTaMoi !== "" && moTaMoi === chuanHoaMoTa(mau.description);
}

/** Mẫu trùng đầu tiên (xếp theo mô tả rồi số tiền cho kết quả ổn định), hoặc null nếu không trùng. */
export function timMauTrung(
  dangChay: readonly MauDinhKyDangChay[],
  moi: MauDinhKyDangChay
): MauDinhKyDangChay | null {
  const trung = dangChay.filter((m) => laTrung(m, moi));
  trung.sort((a, b) => a.description.localeCompare(b.description) || a.amount - b.amount);
  return trung[0] ?? null;
}

/** Đoạn mở đầu câu cảnh báo dùng chung cho "Bật lại" và "Tạo khoản lặp". */
export function moDauCanhBaoMauTrung(mau: MauDinhKyDangChay): string {
  const moTa = mau.description.trim() === "" ? "(không mô tả)" : mau.description;
  return `Đang có khoản định kỳ '${moTa}' ${formatVnd(mau.amount)} cùng danh mục đang chạy — `;
}
