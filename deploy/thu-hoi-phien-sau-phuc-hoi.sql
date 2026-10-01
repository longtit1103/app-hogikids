-- thu-hoi-phien-sau-phuc-hoi.sql — THU HỒI MỌI PHIÊN sau một lượt phục hồi DB trên host (spec §7.4 bước 4).
--
-- KHI NÀO: sau MỌI lượt phục hồi bằng `deploy/restore.sh` — kể cả dump đời ≥ M1, không riêng dump đời
-- trước phân quyền. Dump mang `User.sessionEpoch` của đời chụp (M1 còn cố ý copy epoch cũ để giữ
-- cookie lúc nâng cấp) ⇒ không đổi epoch là cookie cấp trong đời dump SỐNG LẠI. `restore.sh` tự gọi
-- file này ở bước cuối khi `User` đã có cột `sessionEpoch`; dump đời trước M1 thì phải
-- `migrate deploy` trước rồi chạy tay (runbook: "Phục hồi dump đời trước phân quyền").
--
-- ĐIỀU KIỆN: app ĐÃ DỪNG trong suốt lượt phục hồi; M1 đã áp (cột `User.sessionEpoch` tồn tại). PG ≥ 13
-- (`gen_random_uuid()` lõi, `pg_strong_random`; KHÔNG pgcrypto — DR có thể thiếu extension). Chạy tay:
--   docker exec -i supabase-db psql -U supabase_admin -d postgres -X -v ON_ERROR_STOP=1 \
--     < deploy/thu-hoi-phien-sau-phuc-hoi.sql
--
-- HỆ QUẢ: mọi người dùng mang epoch ngẫu nhiên mới (32 hex, khác nhau từng dòng) ⇒ mọi cookie cũ bị từ
-- chối; ai cũng phải đăng nhập lại. Chạy lại nhiều lần vô hại.
SET search_path = app;
UPDATE "User" SET "sessionEpoch" = replace(gen_random_uuid()::text,'-','');
