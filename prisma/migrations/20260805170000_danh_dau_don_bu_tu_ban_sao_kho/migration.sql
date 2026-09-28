-- Đánh dấu đơn được BÙ từ bản sao trong shop kho (`scripts/bu-don-shopee-tu-don-kho.ts`).
--
-- Vì sao cần một CỘT chứ không phải khoá trong `raw`: `raw` là JSON tự do, không nơi nào ràng buộc
-- nó, nên luồng dựng lại và các phép đếm bảo vệ tiền không thể tin vào đó. Hậu quả khi thiếu cột này
-- (phát hiện qua review đối kháng 2026-08-05, khi 46 đơn đã nằm trong prod):
--
--  1. `warnStuckSilverOrders` (rebuild.ts) đếm mọi đơn Silver bị luật mirror loại rồi khuyên
--     "cần xoá tay" — đếm trúng 46 đơn bù, tức app tự xúi chủ shop xoá 7,89 triệu doanh thu THẬT.
--  2. Nguy hơn: "Xoá dữ liệu giao dịch" → "Dựng lại từ kho thô" thì 46 đơn KHÔNG được dựng lại
--     (luật loại bản sao), doanh thu tụt 7,89 triệu mà cảnh báo cũng tự tắt ⇒ mất tiền không dấu vết.
--  3. Cổng chống-đếm-2-lần nay có nền cố định 46 ⇒ một bản sao lọt Silver THẬT về sau chỉ làm số
--     nhảy 46→47, không ai phân biệt được. Mất hẳn một chốt bảo vệ.
--
-- Cột này để các đường trên nhận ra và xử riêng, KHÔNG phải để P&L đọc: đơn bù vào doanh thu y hệt
-- đơn thường (đó là mục đích của việc bù).
ALTER TABLE "Order" ADD COLUMN "backfilledFromMirror" BOOLEAN NOT NULL DEFAULT false;

-- Backfill 46 đơn đã ghi trước khi có cột, nhận diện qua dấu script để lại trong payload.
UPDATE "Order" SET "backfilledFromMirror" = true WHERE raw ? '_buTuDonKho';
