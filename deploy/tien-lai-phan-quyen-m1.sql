-- tien-lai-phan-quyen-m1.sql — TIẾN LẠI BẢN PHÂN QUYỀN sau một đợt đã chạy rollback-phan-quyen-m1.sql
-- (spec §7.3).
--
-- KHI NÀO: đang chạy binary đời trước phân quyền (sau rollback M1), muốn lên lại ảnh mới. M1 VẪN đã áp
-- trong DB ⇒ KHÔNG `migrate deploy` lại; chỉ chạy script này rồi `up -d` ảnh mới.
--
-- ĐIỀU KIỆN: app ĐÃ DỪNG (`docker compose stop app`), chạy TRƯỚC khi lên ảnh mới. PG ≥ 13
-- (`gen_random_uuid()` lõi; KHÔNG pgcrypto). Chạy trên host:
--   docker exec -i supabase-db psql -U supabase_admin -d postgres -X -v ON_ERROR_STOP=1 \
--     < deploy/tien-lai-phan-quyen-m1.sql
--
-- TIỀN KIỂM (trong transaction, không thoả ⇒ RAISE, không câu nào có hiệu lực):
--   - bảng `ShopProfile` tồn tại. THIẾU = DB đã bị phục hồi bằng dump đời TRƯỚC M1 trong cửa sổ lùi ⇒
--     đường tiến là `migrate deploy` bình thường + thu hồi phiên (runbook §4.2), KHÔNG phải script này;
--   - `ShopProfile` đúng 1 dòng và `User` đúng 1 OWNER (nguồn/đích của bước chép);
--   - còn dấu `Setting('phanQuyenDangLui')` do rollback ghi. THIẾU = DB không ở trạng thái sau lùi (chưa
--     từng lùi, hoặc đã tiến lại rồi) ⇒ chạy nữa là đè `ShopProfile` bằng cột `User` cũ.
--
-- HỆ QUẢ (một transaction):
--   1. 3 cột shop trên `User` OWNER → `ShopProfile` ⇒ thông tin shop sửa trong lúc chạy binary cũ
--      không mất (binary cũ chỉ ghi 3 cột đó).
--   2. `User.sessionEpoch` ngẫu nhiên từng dòng ⇒ mọi cookie cấp trong lúc rollback bị từ chối; chủ
--      shop đăng nhập lại.
--   3. Xoá dấu `phanQuyenDangLui` ⇒ banner "sau lùi bản" tắt, tiền kiểm §2b thông.
--   STAFF vẫn mang hash sentinel từ lượt rollback (không bao giờ khớp) ⇒ chủ shop đặt lại mật khẩu
--   từng STAFF ở /quan-tri.
--
-- ⚠️ CHẠY MỘT LẦN mỗi đợt tiến. Dấu lùi bị xoá ở cuối nên lượt chạy lặp tự bị tiền kiểm chặn — ĐỪNG
-- tự tay chèn lại dấu để "chạy cho chắc": sau khi binary mới đã ghi `ShopProfile`, chạy lại là đè mất
-- phần sửa đó bằng cột `User` cũ.
SET search_path = app;
BEGIN;
DO $$
DECLARE
  so_ho_so int;
  so_chu int;
BEGIN
  IF to_regclass('app."ShopProfile"') IS NULL THEN
    RAISE EXCEPTION 'TIEN_LAI_DUNG: thiếu bảng ShopProfile — DB vừa phục hồi dump đời TRƯỚC phân quyền. KHÔNG dùng script này: tiến bằng "migrate deploy" + thu hồi phiên (runbook §4.2).';
  END IF;
  SELECT count(*) INTO so_ho_so FROM app."ShopProfile";
  IF so_ho_so <> 1 THEN
    RAISE EXCEPTION 'TIEN_LAI_DUNG: ShopProfile có % dòng (cần đúng 1) — kiểm tay, không đoán.', so_ho_so;
  END IF;
  SELECT count(*) INTO so_chu FROM app."User" WHERE "role" = 'OWNER';
  IF so_chu <> 1 THEN
    RAISE EXCEPTION 'TIEN_LAI_DUNG: User có % OWNER (cần đúng 1) — kiểm tay, không đoán.', so_chu;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM app."Setting" WHERE "key" = 'phanQuyenDangLui') THEN
    RAISE EXCEPTION 'TIEN_LAI_DUNG: không có dấu phanQuyenDangLui — DB không ở trạng thái sau lùi bản (chưa lùi, hoặc đã tiến lại). Chạy nữa là đè ShopProfile bằng cột User cũ.';
  END IF;
END
$$;
-- Truy vấn con (không `UPDATE … FROM`): lọc OWNER mà trả > 1 dòng thì Postgres NÉM thay vì chọn bừa.
UPDATE "ShopProfile" SET ("shopName", "shopPhone", "shopLogoPath") =
  (SELECT u."shopName", u."shopPhone", u."shopLogoPath" FROM "User" u WHERE u."role" = 'OWNER')
  WHERE "id" = 1;
UPDATE "User" SET "sessionEpoch" = replace(gen_random_uuid()::text,'-','');
DELETE FROM "Setting" WHERE "key" = 'phanQuyenDangLui';
COMMIT;
-- STAFF: chủ shop đặt lại mật khẩu ở /quan-tri (hash sentinel không bao giờ khớp).
