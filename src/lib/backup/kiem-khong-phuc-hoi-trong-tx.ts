import { dangPhucHoi, LOI_DANG_PHUC_HOI } from "./khoa-bao-tri";

/**
 * Lỗi ném từ BÊN TRONG một transaction khi lượt phục hồi DB đã bắt đầu — làm transaction CUỘN LẠI.
 * Action bắt nó ngoài `$transaction` và trả `LOI_DANG_PHUC_HOI` (không ghi nhật ký lỗi: schema sắp
 * bị thay, dòng ghi lúc này mất theo).
 */
export class LoiDangPhucHoiTrongTx extends Error {
  constructor() {
    super(LOI_DANG_PHUC_HOI);
    this.name = "LoiDangPhucHoiTrongTx";
  }
}

/**
 * Kiểm cờ phục hồi LẦN HAI, trong transaction của writer APP-OWNED (giá vốn, tài khoản).
 *
 * Vì sao cần dù action đã kiểm `dangPhucHoi()` ở cửa: lượt phục hồi bật cờ, chụp bản lùi
 * (`pg_dump`) rồi nạp lại bản đã chọn. Action đã QUA cửa trước lúc cờ bật vẫn đang chạy transaction và
 * commit SAU bản lùi — dữ liệu đó (giá vốn không lấy lại được từ Pancake; mật khẩu/khoá tài khoản vừa
 * đổi) hoặc bị bản nạp lại đè, hoặc chen vào DB vừa nạp. Gọi hàm này ở HAI chỗ trong transaction:
 * ngay sau khoá dòng đầu tiên, và ngay trước khi callback trả về (sau câu ghi cuối, trước COMMIT) để
 * cửa sổ còn lại chỉ là khoảng COMMIT.
 *
 * KHÔNG phải khoá ghi toàn cục: một lượt đã qua kiểm lần cuối mà commit đúng lúc pg_dump đang chụp vẫn
 * có thể lọt (việc đó cần khoá phiên DB chung với restore — đã tách thành việc riêng). Vì vậy runbook
 * yêu cầu báo nhân sự ngừng nhập trước khi phục hồi.
 */
export function kiemKhongPhucHoiTrongTx(): void {
  if (dangPhucHoi()) throw new LoiDangPhucHoiTrongTx();
}
