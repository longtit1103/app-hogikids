-- rollback-phan-quyen-m1.sql — LÙI VỀ BINARY ĐỜI TRƯỚC PHÂN QUYỀN, DB GIỮ NGUYÊN M1 (spec §7.3).
--
-- KHI NÀO: đã `migrate deploy` M1 (20260930170000_tai_khoan_phu_phan_quyen) + lên ảnh mới, rồi phải
-- quay về ảnh cũ. Đây là BẢO TRÌ, không phải trỏ ảnh: binary cũ chỉ so cookie với
-- `Setting.sessionEpoch` và không biết `role`/`isActive` ⇒ mọi tài khoản đăng nhập được đều thành
-- toàn quyền. Runbook: deploy/huong-dan-trien-khai-minipc.md §2c "Rollback M1 = bảo trì".
--
-- ĐIỀU KIỆN: app ĐÃ DỪNG (`docker compose stop app`) — không request nào đang ghi `User`/`ShopProfile`.
-- PG ≥ 13 (`gen_random_uuid()` là hàm lõi từ PG 13; KHÔNG dùng pgcrypto). PG thấp hơn ⇒ lỗi, DỪNG.
-- Chạy trên host (stdin, psql trong container):
--   docker exec -i supabase-db psql -U supabase_admin -d postgres -X -v ON_ERROR_STOP=1 \
--     < deploy/rollback-phan-quyen-m1.sql
--
-- HỆ QUẢ (một transaction — lỗi ở đâu thì không câu nào có hiệu lực):
--   1. `Setting.sessionEpoch` = giá trị ngẫu nhiên mới ⇒ mọi cookie đời binary cũ chết.
--   2. `User.sessionEpoch` ngẫu nhiên TỪNG dòng ⇒ mọi cookie đời mới chết. Chủ shop đăng nhập lại.
--   3. STAFF: hash mật khẩu thành chuỗi sentinel KHÔNG BAO GIỜ khớp mật khẩu nào + `mustChangePassword`
--      ⇒ nhân sự không vào được binary cũ (nó sẽ cấp toàn quyền). Tiến lại bản mới: chủ shop đặt lại
--      mật khẩu từng STAFF ở /quan-tri.
--   4. `ShopProfile` → 3 cột shop cũ trên `User` OWNER ⇒ thông tin shop sửa từ khi lên M1 không mất.
--   5. DẤU LÙI BẢN: `Setting('phanQuyenDangLui')` = thời điểm lùi (ISO UTC). Còn dấu này thì DB đang ở
--      trạng thái sau lùi: §2b tiền kiểm nó trước MỌI lượt deploy, app bản mới hiện banner cho chủ shop,
--      và `tien-lai-phan-quyen-m1.sql` từ chối chạy nếu thiếu nó. Chỉ `tien-lai` xoá dấu.
-- Tiến lại: deploy/tien-lai-phan-quyen-m1.sql.
--
-- ⚠️ CHẠY MỘT LẦN mỗi đợt lùi. Chạy lại SAU KHI binary cũ đã chạy và ghi 3 cột shop trên `User` ⇒ đè mất
-- phần sửa đó bằng `ShopProfile` cũ. Ngoại lệ DUY NHẤT: vừa phục hồi DB trong cửa sổ lùi (runbook §2c
-- "Phục hồi trong cửa sổ lùi") — bản phục hồi mang hash thật của STAFF + epoch đời dump nên PHẢI chạy lại
-- trước khi mở app.
SET search_path = app;
BEGIN;
INSERT INTO "Setting"("key","value") VALUES ('sessionEpoch', replace(gen_random_uuid()::text,'-',''))
  ON CONFLICT ("key") DO UPDATE SET "value" = EXCLUDED."value";
INSERT INTO "Setting"("key","value") VALUES ('phanQuyenDangLui', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'))
  ON CONFLICT ("key") DO UPDATE SET "value" = EXCLUDED."value";
UPDATE "User" SET "sessionEpoch" = replace(gen_random_uuid()::text,'-','');
UPDATE "User" SET "passwordHash" = '00000000000000000000000000000000:' || repeat('0',128), "mustChangePassword" = true WHERE "role" = 'STAFF';
UPDATE "User" u SET "shopName" = p."shopName", "shopPhone" = p."shopPhone", "shopLogoPath" = p."shopLogoPath"
  FROM "ShopProfile" p WHERE p."id" = 1 AND u."role" = 'OWNER';
COMMIT;
