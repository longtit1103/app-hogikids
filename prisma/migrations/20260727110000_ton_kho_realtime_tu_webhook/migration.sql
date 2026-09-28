-- Tồn kho realtime từ webhook Pancake (`variations_warehouses` shop Kho Tổng).
--
-- `Variant.stockUpdatedAt` = mốc `inserted_at` của sự kiện webhook gần nhất đã ghi vào `stock`.
-- Vì sao cần cột riêng thay vì mượn `syncedAt`: `syncedAt` là "lần cuối API ghi biến thể này" và
-- luật ưu tiên là API MẠNH HƠN WEBHOOK. Giữ hai mốc tách bạch thì guard thứ tự so được đúng
-- (sự kiện phải mới hơn CẢ hai) mà không làm mất nghĩa của `syncedAt`.
-- null = tồn đang do API khẳng định; mọi lượt vá tồn từ Bronze đều xoá cột này về null.
ALTER TABLE "Variant" ADD COLUMN "stockUpdatedAt" TIMESTAMP(3);

-- Hộp thư webhook: mọi dòng nhận TRƯỚC khi pha 2 sống đều chưa từng được xử lý (hộp thư pha 1 chỉ
-- lưu, cộng các dòng nạp bù từ file mẫu / bảng hệ cũ). Chúng đang mang `processedAs = NULL`, mà
-- panel `/cai-dat#ket-noi` coi NULL là "chưa ghi được kết cục" ⇒ báo đỏ cho dòng hoàn toàn bình
-- thường, tập cho người đọc thói quen bỏ qua hộp đỏ — đúng cái panel sinh ra để tránh.
-- Đặt tên kết cục riêng cho chúng. Sau migration này NULL chỉ còn MỘT nghĩa: ghi kết cục thất bại
-- (bất thường thật) — panel vẫn tô đỏ. Payload gốc không bị đụng tới.
--
-- BIÊN THỜI GIAN là phần bắt buộc, không phải cho gọn: pha 2 lên prod 2026-07-27 ~17:01 giờ VN
-- (10:01 UTC). Dòng NHẬN SAU mốc đó mà vẫn NULL nghĩa là app xử lý xong nhưng GHI KẾT CỤC THẤT BẠI
-- — đúng ca cần người xem. Sơn xanh cả nhóm đó là tự bịt mắt mình.
-- Đã kiểm trên prod trước khi viết: cả 544 dòng NULL đều có `receivedAt` ≤ 09:50:13Z, và không dòng
-- NULL nào sau 10:00Z ⇒ biên này không bỏ sót dòng nào cần đổi tên.
UPDATE "RawPancakeWebhookEvent" SET "processedAs" = 'truoc-pha-2'
WHERE "processedAs" IS NULL AND "receivedAt" < '2026-07-27 10:00:00+00';
