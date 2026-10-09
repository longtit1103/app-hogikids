-- Nguồn nạp MẶC ĐỊNH của hồ sơ ví ads trả trước (ngân hàng / thẻ tín dụng). Additive: kiểu mới + cột có
-- DEFAULT 'BANK' ⇒ dòng sẵn có (nếu có) nhận BANK, không cần tiền kiểm. Kiểu tạo MỚI rồi dùng ngay trong
-- cùng file là hợp lệ (lỗi 55P04 chỉ xảy ra với `ALTER TYPE … ADD VALUE` rồi dùng giá trị mới cùng tx).

-- CreateEnum
CREATE TYPE "NguonNapViAds" AS ENUM ('BANK', 'CARD');

-- AlterTable
ALTER TABLE "ViAdsTraTruoc" ADD COLUMN "nguonNap" "NguonNapViAds" NOT NULL DEFAULT 'BANK';
