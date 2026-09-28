-- Setting vừa là kho khoá cho workflow n8n vừa là chỗ người sửa tay (Studio/NocoDB/psql), nên cần
-- biết mỗi dòng sửa lần cuối lúc nào.

-- AlterTable
ALTER TABLE "Setting" ADD COLUMN     "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- Backfill mốc THẬT cho các dòng token: hai key *TokenSavedAt (epoch giây) đã ghi sẵn thời điểm lưu
-- token, dùng luôn thay vì để tất cả cùng mốc chạy migration. Phải chạy TRƯỚC khi tạo trigger bên
-- dưới, nếu không trigger sẽ ghi đè bằng thời điểm hiện tại.
UPDATE "Setting" s
SET "updatedAt" = to_timestamp(x.saved::bigint) AT TIME ZONE 'utc'
FROM (SELECT value AS saved FROM "Setting" WHERE key = 'tiktokShopTokenSavedAt' AND value ~ '^\d+$') x
WHERE s.key IN (
  'tiktokShopAccessToken', 'tiktokShopRefreshToken', 'tiktokShopAccessTokenExpireAt', 'tiktokShopTokenSavedAt'
);

UPDATE "Setting" s
SET "updatedAt" = to_timestamp(x.saved::bigint) AT TIME ZONE 'utc'
FROM (SELECT value AS saved FROM "Setting" WHERE key = 'metaAdsTokenSavedAt' AND value ~ '^\d+$') x
WHERE s.key IN (
  'metaAdsAccessToken', 'metaAdsTokenExpireAt', 'metaAdsDataAccessExpireAt', 'metaAdsTokenSavedAt'
);

-- Prisma tự cập nhật `updatedAt` (@updatedAt) NHƯNG chỉ khi ghi qua Prisma. Bảng này thường xuyên
-- được sửa tay bằng SQL/Studio/NocoDB — không có trigger thì cột hiện số cũ, tức là sai một cách âm
-- thầm, còn tệ hơn không có cột. `at time zone 'utc'` để không phụ thuộc TimeZone của phiên kết nối.
CREATE OR REPLACE FUNCTION set_setting_updated_at() RETURNS trigger AS $$
BEGIN
  NEW."updatedAt" = now() AT TIME ZONE 'utc';
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER setting_set_updated_at
BEFORE UPDATE ON "Setting"
FOR EACH ROW EXECUTE FUNCTION set_setting_updated_at();
