-- Bronze cho TikTok Business (chi tiêu quảng cáo). Trước đây spend đi THẲNG vào Expense, không giữ
-- bản gốc ⇒ đổi cách tính chi phí là phải gọi lại API. Giữ raw để dựng lại được.
-- shopId = advertiser_id (KHÔNG phải shop). externalId = "<campaign_id>:<ngày>" (báo cáo ads không có id).
CREATE TABLE "RawTiktokBusinessReport" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "payloadHash" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "syncLogId" TEXT,

    CONSTRAINT "RawTiktokBusinessReport_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "RawTiktokBusinessReport_shopId_externalId_fetchedAt_idx" ON "RawTiktokBusinessReport"("shopId", "externalId", "fetchedAt");
CREATE INDEX "RawTiktokBusinessReport_fetchedAt_idx" ON "RawTiktokBusinessReport"("fetchedAt");
CREATE UNIQUE INDEX "RawTiktokBusinessReport_shopId_externalId_payloadHash_key" ON "RawTiktokBusinessReport"("shopId", "externalId", "payloadHash");
