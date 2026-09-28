-- Bronze cho chi tiêu quảng cáo Meta. shopId = ad account (act_...), externalId = campaign_id:ngày.
CREATE TABLE "RawMetaAdsReport" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "payloadHash" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "syncLogId" TEXT,

    CONSTRAINT "RawMetaAdsReport_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "RawMetaAdsReport_shopId_externalId_fetchedAt_idx" ON "RawMetaAdsReport"("shopId", "externalId", "fetchedAt");
CREATE INDEX "RawMetaAdsReport_fetchedAt_idx" ON "RawMetaAdsReport"("fetchedAt");
CREATE UNIQUE INDEX "RawMetaAdsReport_shopId_externalId_payloadHash_key" ON "RawMetaAdsReport"("shopId", "externalId", "payloadHash");
