-- Luồng phí/đối soát TikTok Shop cần SyncLog RIÊNG.
-- Trước đây MỌI stream (kể cả tiktok/*) ghi log kind=PANCAKE: nightly TikTok chạy OK sẽ đẻ log
-- PANCAKE status=OK, khiến UI (badge "Đồng bộ lúc…", empty-state, nút Đồng bộ ngay) báo XANH
-- trong khi luồng DOANH THU Pancake có thể đã chết nhiều ngày.
-- Additive: chỉ THÊM giá trị enum, không đụng dòng cũ → an toàn chạy trên PROD.
ALTER TYPE "SyncKind" ADD VALUE 'TIKTOK_SHOP';
