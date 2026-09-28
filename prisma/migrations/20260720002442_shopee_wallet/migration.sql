-- CreateTable
CREATE TABLE "RawShopeeWalletTxn" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "payloadHash" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "syncLogId" TEXT,

    CONSTRAINT "RawShopeeWalletTxn_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ShopeeSettlement" (
    "id" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "txnTime" TIMESTAMP(3) NOT NULL,
    "type" TEXT NOT NULL,
    "orderCode" TEXT,
    "amount" INTEGER NOT NULL,
    "status" TEXT NOT NULL,
    "runningBalance" INTEGER NOT NULL,
    "raw" JSONB,
    "syncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ShopeeSettlement_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RawShopeeWalletTxn_shopId_externalId_fetchedAt_idx" ON "RawShopeeWalletTxn"("shopId", "externalId", "fetchedAt");

-- CreateIndex
CREATE INDEX "RawShopeeWalletTxn_fetchedAt_idx" ON "RawShopeeWalletTxn"("fetchedAt");

-- CreateIndex
CREATE UNIQUE INDEX "RawShopeeWalletTxn_shopId_externalId_payloadHash_key" ON "RawShopeeWalletTxn"("shopId", "externalId", "payloadHash");

-- CreateIndex
CREATE UNIQUE INDEX "ShopeeSettlement_externalId_key" ON "ShopeeSettlement"("externalId");

-- CreateIndex
CREATE INDEX "ShopeeSettlement_txnTime_idx" ON "ShopeeSettlement"("txnTime");

