-- Pha 2 webhook: hộp thư vẫn ghi TRƯỚC mọi xử lý (bất biến), nhưng sau khi ghi app sniff
-- loại sự kiện và xử lý ĐƠN HÀNG (loại khác đếm rồi bỏ qua — nguồn giữ API).
-- Hai cột metadata ghi KẾT CỤC xử lý của từng dòng — payload gốc không bao giờ bị sửa:
--   `processedAs`  : don-hang | don-hang-cu-hon | don-hang-can-xem | ton-kho-bo-qua |
--                    san-pham-bo-qua | bronze-only | khong-nhan-dien | loi.
--                    NULL = dòng trước pha 2 / nạp bù.
--   `processedNote`: chi tiết cho ca cần người xem (sự kiện lạ, lỗi) — hiển thị ở /cai-dat
--                    để chủ shop biết có loại sự kiện app chưa hiểu mà còn vào fix.

-- AlterTable
ALTER TABLE "RawPancakeWebhookEvent" ADD COLUMN "processedAs" TEXT;
ALTER TABLE "RawPancakeWebhookEvent" ADD COLUMN "processedNote" TEXT;
