-- Bổ sung cho lượt đối soát đêm: phân biệt "lỗi TỰ LÀNH ĐƯỢC" với "lỗi lặp lại mãi".
--
-- Trước đó mọi lỗi ghi đều để dòng ở trạng thái chưa-đóng-dấu với giả định "tự lành được". Nhưng
-- giả định đó KHÔNG được kiểm: một payload có `inserted_at` sai khuôn lọt qua zod rồi làm Prisma
-- ném ở mọi lượt, nên dòng nằm chưa-đóng-dấu VĨNH VIỄN và lượt đêm hỏng mỗi đêm, không lối thoát.
--
--   `silverAttempts`      : số lượt ĐỐI SOÁT TỰ ĐỘNG đã thử dòng này và nhận lỗi GẮN VỚI CHÍNH NÓ.
--                           Lỗi hạ tầng/cả lô KHÔNG tính — nếu không, một nhịp DB chập đẩy cả nghìn
--                           dòng tới ngưỡng dừng-thử-lại cùng lúc.
--   `silverLastAttemptAt` : mốc lượt thử gần nhất, để ép các lượt thử CÁCH XA nhau (một sự cố kéo
--                           dài không được tính là nhiều lượt thử độc lập).
--
-- Hai giá trị kết cục mới (cột `silverOutcome` là TEXT, không phải enum Postgres nên không cần DDL):
--   `FAILED_RETRY_LIMIT` : thử đủ số lượt mà vẫn hỏng ⇒ dừng retry tự động, vẫn hiện "cần xem".
--   `DISCARDED`          : chủ shop đã bấm "Xóa dữ liệu giao dịch" khi dòng còn dở ⇒ TUYỆT ĐỐI
--                          không dựng lại tự động (Sổ đã được xoá CÓ CHỦ ĐÍCH). Chỉ lượt dựng lại
--                          TAY có quyền riêng mới ghi đè được.

-- AlterTable
ALTER TABLE "RawPancakeOrder" ADD COLUMN "silverAttempts" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "RawPancakeOrder" ADD COLUMN "silverLastAttemptAt" TIMESTAMP(3);
