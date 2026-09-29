import { addMonths, format, startOfMonth } from "date-fns";

/**
 * Hai tháng mà hộp "Bật lại" khoản chi định kỳ cho chọn — tháng này và tháng sau — mỗi tháng là MỘT cặp
 * nhãn hiển thị + khoá gửi lên server, sinh từ cùng một mốc. Nguồn DUY NHẤT cho cả ba nơi: khối định kỳ
 * (server component render hộp), nút (gửi `khoa` của lựa chọn) và `batLaiDinhKy` (sau khi giành khoá,
 * dựng lại tập hợp lệ bằng chính hàm này). Ba nơi tự `format` riêng thì lệch một nơi là chọn "tháng
 * sau" ghi mốc tháng này (sinh lại đúng khoản vừa xoá) hoặc nút hỏng hẳn — mà `tsc` không bắt (đều là
 * `string`).
 *
 * Module THUẦN (không `"use server"`, không Prisma) để Client Component import được kiểu. Giờ VN theo
 * TZ tiến trình (container `TZ=Asia/Ho_Chi_Minh`) — CHỈ gọi ở server, không gọi ở client (máy người
 * bấm có thể khác múi giờ).
 */
export type LuaChonThangBatLai = {
  /** Nhãn `MM/yyyy` hiện trong hộp xác nhận + toast. */
  nhan: string;
  /** Khoá `yyyy-MM` gửi lên `batLaiDinhKy` (`thangBatDau`). */
  khoa: string;
};

export type ThangChoBatLai = {
  nay: LuaChonThangBatLai & { dauThang: Date };
  sau: LuaChonThangBatLai & { dauThang: Date };
};

export function thangChoBatLai(bayGio: Date): ThangChoBatLai {
  const mot = (dauThang: Date) => ({
    dauThang,
    nhan: format(dauThang, "MM/yyyy"),
    khoa: format(dauThang, "yyyy-MM"),
  });
  const dauThangNay = startOfMonth(bayGio);
  return { nay: mot(dauThangNay), sau: mot(addMonths(dauThangNay, 1)) };
}
