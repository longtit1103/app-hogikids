import { prisma } from "@/lib/prisma";
import { thuHoiMoiPhienMoiNguoi } from "@/lib/session";
import { HAN_THU_HOI_PHIEN_MS } from "./han-chay-lenh-pg";

/**
 * `thuHoiMoiPhienMoiNguoi()` nhưng CÓ HẠN — chỉ dùng trên đường phục hồi DB. Bản backup mang
 * `User.sessionEpoch` cũ của từng người ⇒ cookie cấp trước lúc chụp có thể khớp lại; đổi epoch MỌI
 * dòng (mỗi dòng một giá trị ngẫu nhiên) buộc tất cả đăng nhập lại.
 *
 * Vì sao cần bản riêng: bước đẩy mốc phiên chạy SAU khi nạp xong, tức là phần duy nhất còn lại
 * giữa lệnh phá huỷ cuối cùng và lúc `finally` trả khoá. Nó KHÔNG fence trước được (dữ liệu đã bị
 * thay rồi, dừng cũng chẳng cứu được gì), mà Prisma lại không có hạn truy vấn mặc định — một kết
 * nối nửa chết ở đúng chỗ này giữ cờ bảo trì tới hết TTL, cả app kẹt chỉ-đọc vì một câu `UPDATE`.
 * Thu hồi MỘT người thường ngày (đổi mật khẩu) KHÔNG cần thứ này: nó không cầm khoá bảo trì nào.
 *
 * Hạn đặt ở TẦNG DB (`SET LOCAL statement_timeout`) chứ không phải `Promise.race`: race chỉ bỏ đi
 * lời hứa, truy vấn vẫn chạy tiếp dưới DB và vẫn có thể ghi — đúng thứ ta muốn chặn khi nghi có
 * lượt phục hồi khác đang thay schema. `SET LOCAL` sống đúng trong transaction này nên không rò
 * sang truy vấn khác dùng chung connection pool.
 *
 * `maxWait` chỉ chặn ca KHÔNG LẤY ĐƯỢC kết nối để mở transaction (cùng `connectionTimeoutMillis` của
 * pool). `timeout` KHÔNG phải lớp ngoài cho câu đang treo: runtime Prisma 7 chỉ đánh dấu transaction
 * hết hạn cho câu KẾ TIẾP, câu đang chạy không bị huỷ và lời hứa không tự từ chối (đo bằng runtime thật
 * trên pool giả: câu `SET` treo ⇒ `$transaction` vẫn chờ sau gấp 15 lần hạn). Ca DB treo tới mức chính
 * câu `SET` không trả lời thì app KHÔNG có hạn nào cắt — chỉ tới khi TCP của hệ điều hành bỏ kết nối.
 */
export async function thuHoiMoiPhienCoHan(): Promise<void> {
  await prisma.$transaction(
    async (tx) => {
      // `statement_timeout` không nhận tham số bind nên phải nội suy; giá trị là hằng số nguyên
      // trong repo, không đến từ người dùng.
      await tx.$executeRawUnsafe(`SET LOCAL statement_timeout = ${Math.trunc(HAN_THU_HOI_PHIEN_MS)}`);
      await thuHoiMoiPhienMoiNguoi(tx);
    },
    { timeout: HAN_THU_HOI_PHIEN_MS, maxWait: HAN_THU_HOI_PHIEN_MS },
  );
}
