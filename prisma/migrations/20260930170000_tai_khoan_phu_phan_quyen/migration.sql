-- Tài khoản phụ + phân quyền (M1): cột vai trò/quyền/phiên trên "User", bảng "ShopProfile" (singleton)
-- và "AuditLog" (nhật ký thao tác).
--
-- NGUYÊN TỬ TƯỜNG MINH: file mở bằng BEGIN; và đóng bằng COMMIT; — không dựa vào việc engine Prisma
-- có tự bọc transaction hay không. Mọi câu ở giữa chạy được trong transaction (enum MỚI, không
-- `ALTER TYPE … ADD VALUE`; không `CREATE INDEX CONCURRENTLY`). Một câu lỗi ⇒ Postgres huỷ cả khối,
-- `_prisma_migrations` ghi lượt thất bại (finished_at NULL), schema không nửa vời.
--
-- GIỮ 3 cột shopName/shopPhone/shopLogoPath trên "User" và dòng Setting 'sessionEpoch' — binary cũ còn
-- đọc chúng (rollback trong cửa sổ M1 chỉ cần trỏ lại ảnh + script). M2 mới xoá.
--
-- Hai index raw cuối file Prisma không tả được trong schema.prisma (unique lower(email), partial
-- unique OWNER). Đo 01/10 (Prisma 6.19): `prisma migrate diff` KHÔNG báo chúng — Prisma bỏ qua index
-- biểu thức/partial khi so, diff rỗng. Đừng "chữa" schema.prisma cho diff khớp, và đừng trông vào diff
-- để phát hiện ai đó xoá chúng: lưới là `tests/migration/m1-nguyen-tu.integration.test.ts`.

-- KIỂM SỚM số tài khoản, TRƯỚC `BEGIN;` — chỉ để người chạy THẤY nguyên nhân.
--
-- Cơ chế (đo 01/10, Prisma 6.19): Prisma gửi CẢ FILE trong một lượt simple Query. Khối này KHÔNG chạy
-- riêng: nó nằm chung transaction ngầm của lượt gửi, và `BEGIN;` bên dưới chỉ biến transaction đó thành
-- tường minh — lỗi trong khối BEGIN…COMMIT huỷ luôn câu đứng trước `BEGIN;`. Hệ quả tốt: không có khe
-- "user chen vào giữa lúc kiểm và lúc BEGIN".
--
-- Vì sao thông báo tới được người chạy: lỗi ở đây xảy ra TRƯỚC `BEGIN;` tường minh ⇒ server dừng lượt
-- gửi và huỷ transaction ngầm, kết nối không kẹt, Prisma in đúng câu RAISE. Lỗi SAU `BEGIN;` thì kết
-- nối kẹt "current transaction is aborted", câu ghi log lượt thất bại của Prisma bị từ chối ⇒ người
-- chạy CHỈ thấy dòng đó, lỗi thật nằm ở log server Postgres (`docker logs supabase-db`).
--
-- Khối kiểm trong transaction (dưới) GIỮ NGUYÊN làm chốt thật — khối này chỉ là lời báo sớm.
DO $$
DECLARE n integer;
BEGIN
  SELECT count(*) INTO n FROM "User";
  IF n > 1 THEN
    RAISE EXCEPTION 'Nhieu hon 1 tai khoan (%): xac dinh OWNER bang tay truoc khi migrate', n;
  END IF;
END $$;

BEGIN;

-- M1 PHẢI chạy khi app ĐÃ DỪNG (runbook: `docker compose stop app` trước `migrate deploy`).
-- `ALTER TABLE "User"` giành ACCESS EXCLUSIVE: một phiên đang giữ khoá trên "User" làm nó chờ, và trong
-- lúc chờ MỌI truy vấn "User" đến sau xếp hàng sau nó (app đứng hình). `lock_timeout` chỉ là LƯỚI: chờ
-- quá 15s ⇒ M1 lỗi, cả khối huỷ (schema không nửa vời) thay vì treo vô hạn. `SET LOCAL` hết hiệu lực
-- ở `COMMIT;` — không rò sang phiên Prisma dùng tiếp.
SET LOCAL lock_timeout = '15s';

CREATE TYPE "Role" AS ENUM ('OWNER', 'STAFF');
CREATE TYPE "KetQuaNhatKy" AS ENUM ('OK', 'LOI');

ALTER TABLE "User"
  ADD COLUMN "role" "Role" NOT NULL DEFAULT 'STAFF',
  ADD COLUMN "tenHienThi" TEXT NOT NULL DEFAULT '',
  ADD COLUMN "quyen" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN "isActive" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "mustChangePassword" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "sessionEpoch" TEXT NOT NULL DEFAULT '0',
  ADD COLUMN "lastLoginAt" TIMESTAMP(3);

CREATE TABLE "ShopProfile" (
  "id" INTEGER NOT NULL DEFAULT 1,
  "shopName" TEXT NOT NULL DEFAULT 'HogiKids',
  "shopPhone" TEXT,
  "shopLogoPath" TEXT,
  CONSTRAINT "ShopProfile_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ShopProfile_singleton" CHECK ("id" = 1)
);

CREATE TABLE "AuditLog" (
  "id" TEXT NOT NULL,
  "thoiDiem" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "actorId" TEXT,
  "actorEmail" TEXT,
  "danhTinhKhaiBao" TEXT,
  "hanhDong" TEXT NOT NULL,
  "doiTuongLoai" TEXT,
  "doiTuongId" TEXT,
  "doiTuongMoTa" TEXT,
  "ketQua" "KetQuaNhatKy" NOT NULL,
  "ghiChu" JSONB,
  CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "AuditLog_thoiDiem_idx" ON "AuditLog"("thoiDiem" DESC);
CREATE INDEX "AuditLog_actorId_thoiDiem_idx" ON "AuditLog"("actorId", "thoiDiem");

-- Ba nhánh theo số tài khoản hiện có. Nhánh 0 (DB trắng): seed tạo OWNER + ShopProfile.
-- Nhánh 1: tài khoản duy nhất thành OWNER, mang epoch phiên toàn cục cũ sang (cookie chủ shop đang
-- đăng nhập sống qua migration; cookie đã bị thu hồi trước M1 KHÔNG hồi sinh), hồ sơ shop chép sang
-- ShopProfile. Nhánh >1: dừng — phải xác định OWNER bằng tay, không đoán.
DO $$
DECLARE so_user integer;
BEGIN
  SELECT count(*) INTO so_user FROM "User";
  IF so_user > 1 THEN
    RAISE EXCEPTION 'Nhieu hon 1 tai khoan (%): xac dinh OWNER bang tay truoc khi migrate', so_user;
  ELSIF so_user = 1 THEN
    UPDATE "User" SET
      "role" = 'OWNER',
      "email" = lower(trim("email")),
      "sessionEpoch" = COALESCE((SELECT "value" FROM "Setting" WHERE "key" = 'sessionEpoch'), '0');
    INSERT INTO "ShopProfile" ("id", "shopName", "shopPhone", "shopLogoPath")
      SELECT 1, "shopName", "shopPhone", "shopLogoPath" FROM "User";
  END IF;
END $$;

CREATE UNIQUE INDEX "User_email_lower_key" ON "User" (lower("email"));
CREATE UNIQUE INDEX "User_owner_duy_nhat" ON "User" ("role") WHERE "role" = 'OWNER';

COMMIT;
