import { Prisma } from "@prisma/client";

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
    return (
      e.code.startsWith("P1") ||
      e.code === "P2021" ||
      e.code === "P2022" ||
      e.code === "P2024" ||
      e.code === "P2034" ||
      e.code === "P2003"
    );
  }

  return false;
}
