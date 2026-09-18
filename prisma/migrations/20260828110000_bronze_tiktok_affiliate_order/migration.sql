-- Bronze cho đơn AFFILIATE TikTok Shop (P3 — tab creator của /marketing).
-- ADDITIVE HOÀN TOÀN: chỉ THÊM 1 bảng mới. KHÔNG DROP, KHÔNG ALTER cột/bảng đang sống ⇒ chạy
-- được trên PROD mà không đụng một dòng dữ liệu nào hiện có. SyncKind dùng lại
-- 'TIKTOK_SHOP_ANALYTICS' (đã có từ 20260825120000) — không thêm giá trị enum.

-- CreateTable
-- POST /affiliate_seller/202410/orders/search — land theo DÒNG SKU (workflow làm phẳng
-- data.orders[].skus[] trước khi gửi). externalId = "<_don_id>:<sku_id>".
-- total_count của TikTok đếm DÒNG SKU, không đếm đơn (đo 28/08: page_size 20 → 19 đơn / 20 dòng).
CREATE TABLE "RawTiktokShopAffiliateOrder" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "payloadHash" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "syncLogId" TEXT,

    CONSTRAINT "RawTiktokShopAffiliateOrder_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RawTiktokShopAffiliateOrder_shopId_externalId_fetchedAt_idx" ON "RawTiktokShopAffiliateOrder"("shopId", "externalId", "fetchedAt");

-- CreateIndex
CREATE INDEX "RawTiktokShopAffiliateOrder_fetchedAt_idx" ON "RawTiktokShopAffiliateOrder"("fetchedAt");

-- CreateIndex
CREATE UNIQUE INDEX "RawTiktokShopAffiliateOrder_shopId_externalId_payloadHash_key" ON "RawTiktokShopAffiliateOrder"("shopId", "externalId", "payloadHash");
