import { prisma } from "@/lib/prisma";
import { thuHoiMoiPhien } from "@/lib/session";
import { HAN_THU_HOI_PHIEN_MS } from "./han-chay-lenh-pg";

/**
 * `thuHoiMoiPhien()` nhưng CÓ HẠN — chỉ dùng trên đường phục hồi DB.
 *
 * Vì sao cần bản riêng: bước đẩy mốc phiên chạy SAU khi nạp xong, tức là phần duy nhất còn lại
 * giữa lệnh phá huỷ cuối cùng và lúc `finally` trả khoá. Nó KHÔNG fence trước được (dữ liệu đã bị
 * thay rồi, dừng cũng chẳng cứu được gì), mà Prisma lại không có hạn truy vấn mặc định — một kết
 * nối nửa chết ở đúng chỗ này giữ cờ bảo trì tới hết TTL, cả app kẹt chỉ-đọc vì một câu `upsert`
 * một dòng. Chỗ gọi thường ngày (đổi mật khẩu) KHÔNG cần thứ này: nó không cầm khoá nào.
 *
 * Hạn đặt ở TẦNG DB (`SET LOCAL statement_timeout`) chứ không phải `Promise.race`: race chỉ bỏ đi
 * lời hứa, truy vấn vẫn chạy tiếp dưới DB và vẫn có thể ghi — đúng thứ ta muốn chặn khi nghi có
 * lượt phục hồi khác đang thay schema. `SET LOCAL` sống đúng trong transaction này nên không rò
 * sang truy vấn khác dùng chung connection pool.
 *
 * `timeout`/`maxWait` của Prisma là lớp ngoài cho ca DB không phản hồi tới mức chính câu `SET`
 * cũng không chạy được.
 */
export async function thuHoiMoiPhienCoHan(): Promise<void> {
  await prisma.$transaction(
    async (tx) => {
      // `statement_timeout` không nhận tham số bind nên phải nội suy; giá trị là hằng số nguyên
      // trong repo, không đến từ người dùng.
      await tx.$executeRawUnsafe(`SET LOCAL statement_timeout = ${Math.trunc(HAN_THU_HOI_PHIEN_MS)}`);
      await thuHoiMoiPhien(tx);
    },
    { timeout: HAN_THU_HOI_PHIEN_MS, maxWait: HAN_THU_HOI_PHIEN_MS },
  );
}
