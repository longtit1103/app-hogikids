/**
 * Hai phép tính TIỀN của thẻ "Kỳ trả nợ chờ duyệt" — THUẦN (không React, không Prisma) để kiểm được
 * bằng số thật của chủ shop.
 *
 * Vì sao tách ra: hai con số này từng nằm rải ở hai component và LỆCH NHAU đúng Σ tiền gửi — ô nhập
 * in "Tổng chuyển ngân hàng kỳ này: 201.421.096 ₫" trong khi thẻ ngay bên dưới in "Tiền thật anh
 * chuyển kỳ này: 190.621.096 ₫" cho cùng một kỳ. Chủ shop không có cách nào biết tin số nào. Nay chỉ
 * còn MỘT công thức, một chỗ in.
 */

/**
 * Σ tiền gửi tiết kiệm ngân hàng sẽ TRẢ LẠI ngay sau kỳ này — chỉ kỳ CUỐI mới có, vì đó là kỳ duy
 * nhất mà lượt "Tất toán" đứng liền sau (dòng hoàn `DEPOSIT_IN` = Σ đang giữ + phần gửi của chính kỳ
 * này). 0 ở mọi kỳ khác và ở khoản không có sổ tiết kiệm.
 *
 * `termMonths === null` (khoản không có lịch kỳ hạn: thấu chi, vay người thân) ⇒ không có "kỳ cuối"
 * ⇒ luôn 0.
 */
export function tienGuiSeNhanLai(args: {
  termMonths: number | null;
  /** Σ DEPOSIT_OUT − Σ DEPOSIT_IN của khoản TÍNH TỚI TRƯỚC kỳ này. */
  tienGuiDangGiu: number;
  /** Số thứ tự kỳ đang duyệt. */
  kyThuMay: number;
  /** Tiền gửi của CHÍNH kỳ này (ô nhập, chủ shop sửa được). */
  tienGuiKyNay: number;
}): number {
  const laKyCuoi = args.termMonths !== null && args.kyThuMay === args.termMonths;
  return laKyCuoi ? args.tienGuiDangGiu + args.tienGuiKyNay : 0;
}

/**
 * TIỀN THẬT chuyển cho ngân hàng trong kỳ này. Ngân hàng thu MỘT LẦN đủ lãi + gốc + tiền gửi, nhưng
 * ở kỳ cuối nó cấn luôn phần sổ tiết kiệm đang giữ vào số phải nộp ⇒ trừ `tienGuiSeNhanLai`.
 *
 * Đây là con số chủ shop so thẳng với giấy báo ngân hàng trước khi bấm "Đã chuyển tiền", nên nó là
 * MỘT phép trừ duy nhất — không có bản "chưa trừ" nào khác được in ra ở đâu.
 */
export function tongChuyenNganHang(args: {
  lai: number;
  goc: number;
  tienGui: number;
  tienGuiSeNhanLai: number;
}): number {
  return args.lai + args.goc + args.tienGui - args.tienGuiSeNhanLai;
}

/**
 * Gốc điền SẴN trong ô nhập của kỳ chờ duyệt, kẹp về dư nợ THẬT còn lại.
 *
 * `deXuatKy` tính gốc từ `duNoDauKy` — dư nợ tại mốc ĐẦU kỳ. Giữa kỳ chủ shop có thể trả bớt gốc
 * bằng tay ở bảng "Khoản tiền khác"; dòng đó nằm SAU mốc nên đề xuất không thấy, và ở kỳ cuối (gốc
 * đề xuất = trọn dư nợ đầu kỳ) ô nhập hiện một con số LỚN HƠN số thật còn nợ. Ca thật: 200.000.000
 * đầu kỳ, trả tay 50.000.000 giữa kỳ ⇒ ô hiện 200.000.000 trong khi chỉ còn nợ 150.000.000, dòng
 * tổng và hộp xác nhận (đọc dư nợ HIỆN TẠI) lại in theo 150.000.000 — bốn con số trên cùng một màn
 * hình đá nhau.
 *
 * Kẹp là cải thiện THUẦN, không phải nới lỏng: đề xuất trả nhiều hơn số thật còn nợ vốn đã sai, và
 * `chanDuNoAm` ở server vẫn là cổng thật — nó ném và rollback trọn kỳ nếu con số gửi lên làm dư nợ
 * âm. Ô vẫn sửa tay được như cũ; đây chỉ là giá trị khởi tạo.
 *
 * Áp cho MỌI loại vay: kỳ thường của khoản trả gốc cuối kỳ có `gocDeXuat = 0` nên không đổi gì.
 */
export function gocDeXuatKep(args: { gocDeXuat: number; duNoHienTai: number }): number {
  return Math.min(args.gocDeXuat, args.duNoHienTai);
}
