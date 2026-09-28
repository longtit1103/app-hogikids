-- Kết cục riêng cho PING THỬ đường truyền webhook (`ping-thu`).
--
-- Bối cảnh: lượt XOAY PATH webhook 21/09 (việc bảo mật, checklist ở `n8n/huong-dan-cai-dat-workflows.md`)
-- bắt buộc phải bắn thử path mới trước khi tắt path cũ. Loạt thử lúc 11:02 giờ VN đẻ 4 dòng
-- `khong-nhan-dien` — panel /cai-dat tô đỏ 4 sự kiện hoàn toàn vô hại. Xoay path nay là việc LẶP LẠI,
-- nên mỗi lượt sau cũng sẽ đẻ hộp đỏ giả y hệt, đúng thứ tập cho người đọc thói quen bỏ qua hộp đỏ.
--
-- Cùng khuôn với migration `20260727110000` đã đặt tên `truoc-pha-2` cho nhóm NULL vô hại: payload
-- gốc KHÔNG bị đụng, chỉ đổi NHÃN kết cục.
--
-- ĐIỀU KIỆN Ở ĐÂY HẸP HƠN cổng trong code — CỐ Ý, đừng "sửa cho khớp":
--   • code (`sniffLoaiSuKien`, `src/lib/ingest/webhook-processor.ts`) so NGỮ NGHĨA JSON: object có
--     ĐÚNG MỘT khoá `test` mang boolean `true`. `{ "test" : true }` hay có `\n` cuối đều tính là ping.
--   • câu này so BYTE nguyên văn payload.
-- Lệch nhau theo chiều AN TOÀN: payload ping viết cách khác sẽ KHÔNG khớp ⇒ dòng đó ở lại ĐỎ, chứ
-- không bao giờ sơn xanh nhầm một sự kiện lạ. Chọn so byte vì cast `payload::jsonb` sẽ NỔ CẢ
-- MIGRATION ngay khi gặp một dòng `khong-nhan-dien` có payload không phải JSON — ca thật đã có
-- (`<html>lỗi 502</html>`, xem `tests/bronze/webhook-processor.test.ts`).
-- Đã đo trên prod trước khi viết: 4 dòng `khong-nhan-dien` tồn tại đều có payload đúng chuỗi 13 byte
-- này và KHÔNG dòng `khong-nhan-dien` nào khác.
-- ⚠️ Rủi ro còn lại là NOOP IM LẶNG (lệch 1 byte ⇒ migrate báo thành công nhưng sửa 0 dòng, panel
-- vẫn đỏ, không ai biết) ⇒ lượt deploy PHẢI đếm trước/sau, kỳ vọng 4 → 4:
--   SELECT count(*) FROM "RawPancakeWebhookEvent" WHERE "processedAs" = 'ping-thu';
UPDATE "RawPancakeWebhookEvent"
SET "processedAs" = 'ping-thu', "processedNote" = 'ping kiểm tra đường truyền webhook'
WHERE "processedAs" = 'khong-nhan-dien' AND "payload" = '{"test":true}';
