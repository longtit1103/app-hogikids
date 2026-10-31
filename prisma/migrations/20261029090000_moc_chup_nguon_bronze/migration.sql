-- Mốc CHỤP nguồn cho 3 bảng kho thô có cột lần thấy (sản phẩm Pancake, báo cáo ads Meta, báo cáo ads TikTok Business).
-- Lỗi được vá: "lanThayCuoi"/"fetchedAt" là giờ LAND, không phải giờ nguồn CHỤP. Hai lượt kéo chồng nhau ("Đồng bộ ngay"
-- đè lượt đêm) mà trang của lượt chụp TRƯỚC POST tới SAU thì bản cũ được ghi lần thấy (hoặc chèn mới) và đứng lên đầu
-- dù nguồn đã ở bản mới hơn. "mocChup" = lúc n8n BẮT ĐẦU GET trang (trường `chupLuc` của /api/ingest/raw); mốc phiên
-- bản thành COALESCE("mocChup", "lanThayCuoi", "fetchedAt").
--
-- CHỈ THÊM cột NULL, không CHECK, không NOT NULL, không backfill, không index:
--  - NULL = dòng có trước bản này, hoặc chèn không kèm `chupLuc` ⇒ mốc rơi về "lanThayCuoi"/"fetchedAt" (thứ tự y cũ).
--  - Ảnh cũ (đường lùi ảnh) chạy được trên schema mới: câu INSERT liệt kê cột, Prisma chọn cột tường minh.
--  - Postgres ≥ 11 thêm cột NULL không mặc định = chỉ sửa catalog, không ghi lại bảng (khoá rất ngắn).
-- P&L, quỹ không đổi.

-- AlterTable
ALTER TABLE "RawPancakeProduct" ADD COLUMN "mocChup" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "RawTiktokBusinessReport" ADD COLUMN "mocChup" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "RawMetaAdsReport" ADD COLUMN "mocChup" TIMESTAMP(3);
