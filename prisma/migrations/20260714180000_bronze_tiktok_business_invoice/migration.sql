-- Hoá đơn quảng cáo TikTok (Business Center) — số tiền THẬT, GỒM VAT 10%.
-- report `cost` là số CHƯA THUẾ ⇒ ghi P&L theo report là thiếu 10% chi phí quảng cáo.
CREATE TABLE "RawTiktokBusinessInvoice" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "payloadHash" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "syncLogId" TEXT,

    CONSTRAINT "RawTiktokBusinessInvoice_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "RawTiktokBusinessInvoice_shopId_externalId_fetchedAt_idx" ON "RawTiktokBusinessInvoice"("shopId", "externalId", "fetchedAt");
CREATE INDEX "RawTiktokBusinessInvoice_fetchedAt_idx" ON "RawTiktokBusinessInvoice"("fetchedAt");
CREATE UNIQUE INDEX "RawTiktokBusinessInvoice_shopId_externalId_payloadHash_key" ON "RawTiktokBusinessInvoice"("shopId", "externalId", "payloadHash");
