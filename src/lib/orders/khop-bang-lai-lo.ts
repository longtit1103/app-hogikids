import { endOfMonth, startOfMonth } from "date-fns";
import type { OrderStatus } from "@/generated/prisma/client";

import { formatNgayVn } from "@/lib/dinh-dang-ngay-gio-vn";
import { formatVnd } from "@/lib/format";
import type { BoLocDonHang } from "@/lib/orders/don-hang-kieu-du-lieu";

/**
 * Khi nào số trên trang Đơn hàng được phép nói "khớp bảng Lãi/Lỗ", và khớp DÒNG NÀO.
 *
 * Chỉ dùng để quyết định câu chú thích cho người đọc — KHÔNG tham gia tính tiền (tiền do truy vấn trả,
 * Lãi/Lỗ do `pnl.ts` tính). Tên dòng trong câu chú thích là ĐÚNG nhãn bảng Lãi/Lỗ đang hiện
 * (`pnl-line-items.ts`): "Doanh thu" (đã trừ voucher), "Phí sàn", "Thực nhận từ sàn", "LN gộp",
 * "Phí sàn đơn hoàn/hủy". Bảng không có dòng nào bằng Σ tiền hàng, nên câu nói "Tiền hàng − voucher".
 * Lưới `tests/queries/orders-the-so-khop-calc-pnl.integration.test.ts` khẳng định từng đẳng thức với `calcPnl`.
 */

/** Trạng thái P&L coi là "đơn hợp lệ" (bất biến: loại RETURNED + CANCELLED). */
const PNL_VALID_STATUSES: OrderStatus[] = ["PENDING", "SHIPPING", "COMPLETED"];
const PNL_EXCLUDED_STATUSES: OrderStatus[] = ["RETURNED", "CANCELLED"];
const SO_TRANG_THAI = 5;

function dungTap(statuses: OrderStatus[], tap: OrderStatus[]): boolean {
  return statuses.length === tap.length && tap.every((s) => statuses.includes(s));
}

export function isExactlyPnlValid(statuses: OrderStatus[]): boolean {
  return dungTap(statuses, PNL_VALID_STATUSES);
}

/**
 * P&L chỉ tồn tại theo THÁNG dương lịch trọn vẹn (`/tai-chinh` luôn tính
 * `startOfMonth`–`endOfMonth`) — không có kỳ nửa tháng nào để đối chiếu. Nếu
 * không kiểm điều này, bấm preset "7 ngày"/"Hôm nay" ở bộ lọc Đơn hàng (giữ
 * nguyên `trang_thai` hợp lệ từ lượt drill trước) vẫn khiến caption khẳng định
 * "khớp bảng Lỗ lãi" trong khi P&L không hề có con số cho kỳ đó — trấn an sai.
 */
export function isFullCalendarMonth(range: { from: Date; to: Date }): boolean {
  return range.from.getTime() === startOfMonth(range.from).getTime() && range.to.getTime() === endOfMonth(range.from).getTime();
}

/**
 * Bốn trạng thái đối chiếu (điều kiện chung: trọn một tháng dương lịch ∧ không kênh ∧ không tìm ∧ không chip;
 * sắp xếp/trang/đơn đang mở không đổi tập đơn):
 *  - `khop_tron`: đúng {hợp lệ} ⇒ mọi thẻ khớp, Lãi đơn = "LN gộp";
 *  - `khop_tru_phi_hoan_huy`: không lọc trạng thái (hoặc chọn đủ năm — bộ đọc URL đã bỏ trùng) ⇒ các thẻ tiền
 *    vẫn khớp, nhưng Lãi đơn = "LN gộp" − "Phí sàn đơn hoàn/hủy" (thẻ Lãi trừ phí sàn sàn giữ của đơn hoàn/hủy);
 *  - `khop_phi_hoan_huy`: đúng {hoàn, hủy} (đường bấm từ dòng "Phí sàn đơn hoàn/hủy") ⇒ chỉ số phí sàn đơn
 *    hoàn/hủy khớp dòng cùng tên;
 *  - `khong_khop`: còn lại.
 */
export type KhopBangLaiLo =
  | { kieu: "khop_tron" | "khop_tru_phi_hoan_huy" | "khop_phi_hoan_huy"; thang: string }
  | { kieu: "khong_khop" };

export function khopBangLaiLo(b: BoLocDonHang): KhopBangLaiLo {
  if (b.ky.loai !== "khoang" || !isFullCalendarMonth(b.ky)) return { kieu: "khong_khop" };
  if (b.channels.length > 0 || b.q !== "" || b.loc.length > 0) return { kieu: "khong_khop" };
  const thang = formatNgayVn(b.ky.from, "MM/yyyy");
  if (isExactlyPnlValid(b.statuses)) return { kieu: "khop_tron", thang };
  if (b.statuses.length === 0 || new Set(b.statuses).size === SO_TRANG_THAI) return { kieu: "khop_tru_phi_hoan_huy", thang };
  if (dungTap(b.statuses, PNL_EXCLUDED_STATUSES)) return { kieu: "khop_phi_hoan_huy", thang };
  return { kieu: "khong_khop" };
}

/**
 * Câu chú thích dưới hàng thẻ (chữ thường, đọc được trên điện thoại — không dựa vào `title`). `null` khi
 * không khớp (thẻ tự hiện câu cảnh báo "Đang lọc"). Người thiếu quyền giá vốn không thấy thẻ Lãi ⇒ câu không
 * nhắc "Lãi đơn"/"LN gộp".
 */
export function chuThichKhopBangLaiLo(khop: KhopBangLaiLo, phiSanGiuHoanHuy: number, coQuyenGiaVon: boolean): string | null {
  if (khop.kieu === "khong_khop") return null;
  const phiHoanHuy = formatVnd(phiSanGiuHoanHuy);
  if (khop.kieu === "khop_phi_hoan_huy") {
    return `Phí sàn đơn hoàn/hủy tháng ${khop.thang} (${phiHoanHuy}) khớp dòng “Phí sàn đơn hoàn/hủy” của bảng Lãi/Lỗ. Đơn hoàn/hủy không tính vào thẻ Tiền hàng và thẻ Tiền sau voucher và phí sàn.`;
  }
  const chung = `Số trên thẻ khớp bảng Lãi/Lỗ tháng ${khop.thang}: Tiền hàng − voucher = “Doanh thu” · phí sàn = “Phí sàn” · Tiền sau voucher và phí sàn = “Thực nhận từ sàn”`;
  if (khop.kieu === "khop_tron") return coQuyenGiaVon ? `${chung} · Lãi đơn = “LN gộp”.` : `${chung}.`;
  return coQuyenGiaVon
    ? `${chung} · Lãi đơn = “LN gộp” − “Phí sàn đơn hoàn/hủy” (${phiHoanHuy}).`
    : `${chung} · phí sàn đơn hoàn/hủy (${phiHoanHuy}) = “Phí sàn đơn hoàn/hủy”.`;
}
