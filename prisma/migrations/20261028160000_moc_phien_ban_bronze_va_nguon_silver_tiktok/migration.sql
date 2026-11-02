-- Mốc phiên bản kho thô + mốc nguồn Silver TikTok — hai lỗi THỨ TỰ dữ liệu ingest:
--  1. Nguồn trả lại đúng nội dung CŨ (A → B → A): Bronze khử trùng theo hash nên lần A thứ hai không chèn dòng, bản
--     đứng đầu theo fetchedAt vẫn là B. Cột "lanThayCuoi" ghi LẦN THẤY LẠI (landRaw chỉ ghi cho dòng không đứng đầu);
--     bản đầu xếp theo COALESCE("lanThayCuoi", "fetchedAt"). Chỉ 3 bảng không có mốc nội dung trong payload và có
--     người đọc bản đầu: sản phẩm Pancake, báo cáo ads Meta, báo cáo ads TikTok Business.
--  2. Hai lượt transform song song: lượt cầm ảnh cũ ghi đè lượt cầm ảnh mới. Cột "nguonFetchedAt" mang mốc phiên bản
--     của dòng kho thô đã dựng bản Silver; câu ghi chỉ đè khi mốc mới ≥ mốc đang lưu.
--
-- CHỈ THÊM cột NULL, không CHECK, không NOT NULL, không backfill, không index:
--  - NULL = dòng có trước bản này: "lanThayCuoi" NULL ⇒ mốc = fetchedAt (thứ tự y cũ); "nguonFetchedAt" NULL ⇒ cho ghi
--    (lượt dựng lại / đêm sau tự điền). Ảnh cũ (đường lùi ảnh) chạy được trên schema mới, cột thừa vô hại.
--  - Không index cho "lanThayCuoi": câu cập nhật lần thấy đi theo khoá duy nhất (shopId, externalId, payloadHash) sẵn có;
--    bộ đọc bản đầu vẫn lọc theo (shopId, externalId) bằng index sẵn có, phần xếp mốc chỉ trên các phiên bản của một khoá.
--  - Postgres ≥ 11 thêm cột NULL không mặc định = chỉ sửa catalog, không ghi lại bảng (khoá rất ngắn).
-- syncedAt KHÔNG đổi nghĩa (chỉ đặt lúc tạo — người đọc "dòng về muộn" dựa vào đó). P&L, quỹ không đổi.

-- AlterTable
ALTER TABLE "RawPancakeProduct" ADD COLUMN "lanThayCuoi" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "RawTiktokBusinessReport" ADD COLUMN "lanThayCuoi" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "RawMetaAdsReport" ADD COLUMN "lanThayCuoi" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "TiktokSettlement" ADD COLUMN "nguonFetchedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "TiktokAdsSettlement" ADD COLUMN "nguonFetchedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "TiktokPayment" ADD COLUMN "nguonFetchedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "TiktokAdsHoaDon" ADD COLUMN "nguonFetchedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "TiktokAdsTinDung" ADD COLUMN "nguonFetchedAt" TIMESTAMP(3);
