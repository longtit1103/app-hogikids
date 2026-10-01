import { Prisma } from "@/generated/prisma/client";
import { laLoiKetNoiPgTho, laNguyenNhanHeThong, nguyenNhanAdapter } from "@/lib/prisma-loi-adapter";

/**
 * Lỗi này là của HỆ THỐNG/CẤU HÌNH, hay của riêng DÒNG DỮ LIỆU đang xử lý?
 *
 * Phân biệt được hai loại là điều kiện sống của chốt "đếm lượt thử": lượt đối soát đêm ghi nhận một
 * lượt thử THẤT BẠI cho từng dòng, và đủ số lượt thì dòng bị chuyển sang dừng-thử-lại VĨNH VIỄN.
 * Nếu một sự cố hệ thống (bảng `Channel` trống sau lượt phục hồi thiếu ref-data, mất kết nối DB,
 * cạn pool) bị tính thành "dòng này hỏng" thì sau vài đêm TOÀN BỘ đơn bị chôn — dùng một sự cố tạm
 * thời để vứt vĩnh viễn dữ liệu có tiền, đúng thứ chốt đó sinh ra để tránh.
 *
 * Cách phân loại CỐ Ý NGHIÊNG VỀ "hệ thống": nhầm một lỗi-dòng thành lỗi-hệ-thống chỉ làm lượt đêm
 * dừng sớm và kêu to (đêm sau chạy lại, không mất gì); nhầm chiều ngược lại thì chôn đơn.
 *
 * Prisma 7 đưa sự cố hạ tầng tới đây dưới ba hình dạng mà MÃ LỖI không nói lên được — xem
 * `src/lib/prisma-loi-adapter.ts`: P2010 của câu raw (hai câu ĐẦU TIÊN của transaction ghi đơn là raw:
 * khoá tư vấn + cổng trùng id giữa shop ⇒ mất kết nối gần như luôn nổ ở đây), `DriverAdapterError`
 * trần lúc COMMIT, và `Error` không mã của `pg`. Cả ba phải đọc NGUYÊN NHÂN, không đọc mã.
 */
export function laLoiHeThong(e: unknown): boolean {
  // Không kết nối được / khởi tạo client hỏng / engine chết — rõ ràng không phải lỗi của dòng.
  if (
    e instanceof Prisma.PrismaClientInitializationError ||
    e instanceof Prisma.PrismaClientRustPanicError ||
    e instanceof Prisma.PrismaClientUnknownRequestError
  ) {
    return true;
  }

  if (e instanceof Prisma.PrismaClientKnownRequestError) {
    // P1xxx = tầng kết nối/hạ tầng. P2021/P2022 = thiếu bảng/cột (schema chưa migrate).
    // P2024 = cạn connection pool. P2034 = deadlock/serialize — thử lại được, không phải lỗi dữ liệu.
    // P2003 = vi phạm khoá ngoại: với đường ghi đơn, khoá ngoại DUY NHẤT là `channelId`, mà kênh là
    //         DỮ LIỆU THAM CHIẾU do app tự seed — thiếu nó nghĩa là DB chưa dựng đủ, không phải đơn
    //         này hỏng. Đây chính là ca đã đo: phục hồi DB quên seed ⇒ mọi đơn dính P2003.
    // P2036 = lỗi JS trong tầng driver (Prisma 7) — hạ tầng, không phải dữ liệu.
    // P2037 = Postgres hết slot kết nối (53300) — hạ tầng.
    // P2028 = transaction quá hạn chờ mở (`maxWait` — pool cạn/DB chậm) hoặc quá hạn chạy (`timeout`).
    // P2039 = lỗi Postgres mà driver adapter (Prisma 7) KHÔNG có mã riêng: phiên bị ngắt
    //         (57P01 — vd lượt phục hồi thu hồi phiên), hết hạn chờ khoá (55P03), hết giờ câu lệnh
    //         (57014), vi phạm CHECK… Prisma 6 ném đúng nhóm này dưới dạng
    //         `PrismaClientUnknownRequestError` — vốn đã tính là HỆ THỐNG ở trên. Không liệt P2039 vào
    //         đây là lặng lẽ đổi chúng thành "lỗi của dòng" khi nâng Prisma 7 ⇒ đếm lượt thử, chôn đơn.
    if (
      e.code.startsWith("P1") ||
      e.code === "P2021" ||
      e.code === "P2022" ||
      e.code === "P2024" ||
      e.code === "P2034" ||
      e.code === "P2003" ||
      e.code === "P2036" ||
      e.code === "P2028" ||
      e.code === "P2037" ||
      e.code === "P2039"
    ) {
      return true;
    }
    // Còn lại (đáng kể nhất P2010 của câu raw) thì phán theo NGUYÊN NHÂN adapter gắn kèm. Câu raw vi
    // phạm ràng buộc (23xxx) vẫn là lỗi của dòng — đúng như Prisma 6 (P2010 chưa bao giờ là hệ thống).
    const nguyenNhan = nguyenNhanAdapter(e);
    return nguyenNhan !== undefined && laNguyenNhanHeThong(nguyenNhan);
  }

  // COMMIT hỏng: runtime ném `DriverAdapterError` trần, không bọc thành mã Prisma.
  const nguyenNhan = nguyenNhanAdapter(e);
  if (nguyenNhan !== undefined) return laNguyenNhanHeThong(nguyenNhan);

  // `pg` mất kết nối / hết hạn chờ pool: `Error` không mã, adapter để lọt nguyên dạng.
  return laLoiKetNoiPgTho(e);
}
