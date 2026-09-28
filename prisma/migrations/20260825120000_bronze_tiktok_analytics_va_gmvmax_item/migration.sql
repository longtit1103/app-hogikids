-- Bronze cho CHỈ SỐ MARKETING TikTok Shop (4 stream analytics) + GMV Max cấp ITEM (1 stream ads).
-- ADDITIVE HOÀN TOÀN: chỉ THÊM 1 giá trị enum + 5 bảng mới. KHÔNG DROP, KHÔNG ALTER cột/bảng đang
-- sống ⇒ chạy được trên PROD mà không đụng một dòng dữ liệu nào hiện có.

-- AlterEnum
-- SyncLog của lượt analytics 02:30 phải TÁCH khỏi luồng phí/đối soát 02:00 (`TIKTOK_SHOP`): ghi
-- chung kind thì lượt analytics chạy OK sẽ "sơn xanh" trạng thái tài chính vừa chết đêm đó.
-- PG ≥ 12 cho phép ADD VALUE trong transaction MIỄN LÀ không dùng giá trị mới ngay trong chính
-- transaction đó — migration này chỉ tạo bảng nên an toàn.
ALTER TYPE "SyncKind" ADD VALUE 'TIKTOK_SHOP_ANALYTICS';

-- CreateTable
-- GMV Max cấp ITEM — BẢNG RIÊNG, KHÔNG land chung "RawTiktokBusinessReport": dòng item-level có đủ
-- campaign_id + stat_time_day và KHÔNG có metrics.spend ⇒ idExpr của stream cũ sinh khoá TRÙNG KHÍT
-- dòng campaign-level, DISTINCT ON khi dựng lại chọn 1 vứt 1 ⇒ chi phí ads ra SỐ SAI.
-- shopId = advertiser_id. externalId = "<campaign_id>:<item_group_id>:<ngày>".
CREATE TABLE "RawTiktokBusinessGmvMaxItem" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "payloadHash" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "syncLogId" TEXT,

    CONSTRAINT "RawTiktokBusinessGmvMaxItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
-- /analytics/202509/shop/performance (granularity 1D) — 1 dòng/NGÀY, externalId = start_date.
CREATE TABLE "RawTiktokShopAnalyticsShop" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "payloadHash" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "syncLogId" TEXT,

    CONSTRAINT "RawTiktokShopAnalyticsShop_pkey" PRIMARY KEY ("id")
);

-- CreateTable
-- /analytics/202605/shop_products/performance — record là TỔNG cả cửa sổ, KHÔNG có trường ngày ⇒
-- app bơm "_ngay" (khoá KỸ THUẬT, không phải field TikTok); externalId = "<_ngay>:<id>".
CREATE TABLE "RawTiktokShopAnalyticsProduct" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "payloadHash" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "syncLogId" TEXT,

    CONSTRAINT "RawTiktokShopAnalyticsProduct_pkey" PRIMARY KEY ("id")
);

-- CreateTable
-- /analytics/202605/shop_videos/performance — externalId = "<_ngay>:<id>"; record id = "0"
-- (TikTok gom "video không xác định") là HỢP LỆ, không lọc bỏ.
CREATE TABLE "RawTiktokShopAnalyticsVideo" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "payloadHash" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "syncLogId" TEXT,

    CONSTRAINT "RawTiktokShopAnalyticsVideo_pkey" PRIMARY KEY ("id")
);

-- CreateTable
-- /analytics/202509/shop_lives/performance — mảng ở data.live_stream_sessions; 1 dòng/PHIÊN,
-- externalId = id phiên (record có start_time/end_time riêng nên KHÔNG cần "_ngay").
CREATE TABLE "RawTiktokShopAnalyticsLive" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "payloadHash" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "syncLogId" TEXT,

    CONSTRAINT "RawTiktokShopAnalyticsLive_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RawTiktokBusinessGmvMaxItem_shopId_externalId_fetchedAt_idx" ON "RawTiktokBusinessGmvMaxItem"("shopId", "externalId", "fetchedAt");

-- CreateIndex
CREATE INDEX "RawTiktokBusinessGmvMaxItem_fetchedAt_idx" ON "RawTiktokBusinessGmvMaxItem"("fetchedAt");

-- CreateIndex
CREATE UNIQUE INDEX "RawTiktokBusinessGmvMaxItem_shopId_externalId_payloadHash_key" ON "RawTiktokBusinessGmvMaxItem"("shopId", "externalId", "payloadHash");

-- CreateIndex
CREATE INDEX "RawTiktokShopAnalyticsShop_shopId_externalId_fetchedAt_idx" ON "RawTiktokShopAnalyticsShop"("shopId", "externalId", "fetchedAt");

-- CreateIndex
CREATE INDEX "RawTiktokShopAnalyticsShop_fetchedAt_idx" ON "RawTiktokShopAnalyticsShop"("fetchedAt");

-- CreateIndex
CREATE UNIQUE INDEX "RawTiktokShopAnalyticsShop_shopId_externalId_payloadHash_key" ON "RawTiktokShopAnalyticsShop"("shopId", "externalId", "payloadHash");

-- CreateIndex
CREATE INDEX "RawTiktokShopAnalyticsProduct_shopId_externalId_fetchedAt_idx" ON "RawTiktokShopAnalyticsProduct"("shopId", "externalId", "fetchedAt");

-- CreateIndex
CREATE INDEX "RawTiktokShopAnalyticsProduct_fetchedAt_idx" ON "RawTiktokShopAnalyticsProduct"("fetchedAt");

-- CreateIndex
CREATE UNIQUE INDEX "RawTiktokShopAnalyticsProduct_shopId_externalId_payloadHash_key" ON "RawTiktokShopAnalyticsProduct"("shopId", "externalId", "payloadHash");

-- CreateIndex
CREATE INDEX "RawTiktokShopAnalyticsVideo_shopId_externalId_fetchedAt_idx" ON "RawTiktokShopAnalyticsVideo"("shopId", "externalId", "fetchedAt");

-- CreateIndex
CREATE INDEX "RawTiktokShopAnalyticsVideo_fetchedAt_idx" ON "RawTiktokShopAnalyticsVideo"("fetchedAt");

-- CreateIndex
CREATE UNIQUE INDEX "RawTiktokShopAnalyticsVideo_shopId_externalId_payloadHash_key" ON "RawTiktokShopAnalyticsVideo"("shopId", "externalId", "payloadHash");

-- CreateIndex
CREATE INDEX "RawTiktokShopAnalyticsLive_shopId_externalId_fetchedAt_idx" ON "RawTiktokShopAnalyticsLive"("shopId", "externalId", "fetchedAt");

-- CreateIndex
CREATE INDEX "RawTiktokShopAnalyticsLive_fetchedAt_idx" ON "RawTiktokShopAnalyticsLive"("fetchedAt");

-- CreateIndex
CREATE UNIQUE INDEX "RawTiktokShopAnalyticsLive_shopId_externalId_payloadHash_key" ON "RawTiktokShopAnalyticsLive"("shopId", "externalId", "payloadHash");
