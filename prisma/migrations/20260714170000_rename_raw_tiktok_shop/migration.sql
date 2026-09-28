-- Đổi tên bảng Bronze TikTok cho rõ NGUỒN: RawTiktok* → RawTiktokShop* (dữ liệu từ TikTok Shop API).
-- "RawTiktok" mơ hồ: TikTok có 2 API khác hẳn nhau — TikTok Shop (đơn/phí/đối soát) và
-- TikTok Business (chi tiêu quảng cáo). Tên phải nói được nguồn nào.
--
-- RENAME chứ KHÔNG drop/create: bảng đang có dữ liệu thật (79 statement + 100 transaction + 3 payment).
-- `StatementTransaction` rút gọn thành `Transaction` để tên index không vượt trần 63 ký tự của Postgres
-- (RawTiktokShopStatementTransaction_shopId_externalId_fetchedAt_idx = 65 ký tự → bị cắt cụt, lệch với
-- tên Prisma sinh ra ở migration sau).

ALTER TABLE "RawTiktokStatement"            RENAME TO "RawTiktokShopStatement";
ALTER TABLE "RawTiktokStatementTransaction" RENAME TO "RawTiktokShopTransaction";
ALTER TABLE "RawTiktokPayment"              RENAME TO "RawTiktokShopPayment";
ALTER TABLE "RawTiktokOrder"                RENAME TO "RawTiktokShopOrder";

-- Khoá chính
ALTER INDEX "RawTiktokStatement_pkey"            RENAME TO "RawTiktokShopStatement_pkey";
ALTER INDEX "RawTiktokStatementTransaction_pkey" RENAME TO "RawTiktokShopTransaction_pkey";
ALTER INDEX "RawTiktokPayment_pkey"              RENAME TO "RawTiktokShopPayment_pkey";
ALTER INDEX "RawTiktokOrder_pkey"                RENAME TO "RawTiktokShopOrder_pkey";

-- Index + unique (Prisma sinh tên theo tên bảng → phải đổi theo, nếu không migration sau sẽ lệch)
ALTER INDEX "RawTiktokStatement_shopId_externalId_fetchedAt_idx"     RENAME TO "RawTiktokShopStatement_shopId_externalId_fetchedAt_idx";
ALTER INDEX "RawTiktokStatement_fetchedAt_idx"                       RENAME TO "RawTiktokShopStatement_fetchedAt_idx";
ALTER INDEX "RawTiktokStatement_shopId_externalId_payloadHash_key"   RENAME TO "RawTiktokShopStatement_shopId_externalId_payloadHash_key";

ALTER INDEX "RawTiktokStatementTransaction_shopId_externalId_fetchedAt_idx"   RENAME TO "RawTiktokShopTransaction_shopId_externalId_fetchedAt_idx";
ALTER INDEX "RawTiktokStatementTransaction_fetchedAt_idx"                     RENAME TO "RawTiktokShopTransaction_fetchedAt_idx";
ALTER INDEX "RawTiktokStatementTransaction_shopId_externalId_payloadHash_key" RENAME TO "RawTiktokShopTransaction_shopId_externalId_payloadHash_key";

ALTER INDEX "RawTiktokPayment_shopId_externalId_fetchedAt_idx"   RENAME TO "RawTiktokShopPayment_shopId_externalId_fetchedAt_idx";
ALTER INDEX "RawTiktokPayment_fetchedAt_idx"                     RENAME TO "RawTiktokShopPayment_fetchedAt_idx";
ALTER INDEX "RawTiktokPayment_shopId_externalId_payloadHash_key" RENAME TO "RawTiktokShopPayment_shopId_externalId_payloadHash_key";

ALTER INDEX "RawTiktokOrder_shopId_externalId_fetchedAt_idx"   RENAME TO "RawTiktokShopOrder_shopId_externalId_fetchedAt_idx";
ALTER INDEX "RawTiktokOrder_fetchedAt_idx"                     RENAME TO "RawTiktokShopOrder_fetchedAt_idx";
ALTER INDEX "RawTiktokOrder_shopId_externalId_payloadHash_key" RENAME TO "RawTiktokShopOrder_shopId_externalId_payloadHash_key";
