-- Shop id Pancake chuyển từ hằng trong code sang cấu hình bảng "Setting" (bản clone public có
-- shop id khác — xem src/lib/ket-noi/cau-hinh-shop.ts). Migration này giữ prod HogiKids chạy
-- TIẾP không đứt: seed 3 key bằng giá trị đang vận hành.
--
-- CÓ ĐIỀU KIỆN "đã từng có dữ liệu Pancake" là cố ý: prisma/migrations nằm trong allowlist của
-- snapshot public, nên seed VÔ điều kiện sẽ mồi id HogiKids vào DB TRẮNG của người clone — cơ chế
-- "thiếu key → lỗi rõ, bắt điền ở /cai-dat hoặc setup script" chết ngay từ lượt migrate đầu tiên,
-- và bản clone lặng lẽ gọi Pancake bằng shop của người khác (chỉ thấy 401 khó hiểu).
-- DB đã có dòng RawPancakeOrder = chắc chắn là DB HogiKids đang chạy, không phải bản clone mới.
--
-- ON CONFLICT DO NOTHING: ai đã điền tay key này (qua /cai-dat sau khi lên bản mới) thì giữ nguyên.
INSERT INTO "Setting" (key, value)
SELECT v.key, v.value
FROM (
  VALUES
    ('pancakeShopIdKho', '714995134'),
    ('pancakeShopIdShopee', '1942992175'),
    ('pancakeShopIdTiktok', '100975192'),
    -- 2 giá trị dưới vốn là hằng trong src/ (đã nằm sẵn ở repo public) — không lộ gì mới:
    ('pancakeWarehouseIdKhoTong', '8ea354a7-2350-4446-a1d5-8308353ff841'),
    ('tiktokBusinessAppId', '7403634155688476689')
) AS v(key, value)
WHERE EXISTS (SELECT 1 FROM "RawPancakeOrder")
ON CONFLICT (key) DO NOTHING;
