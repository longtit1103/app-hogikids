-- CreateTable
CREATE TABLE "RawTiktokStatement" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "payloadHash" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "syncLogId" TEXT,

    CONSTRAINT "RawTiktokStatement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RawTiktokStatementTransaction" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "payloadHash" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "syncLogId" TEXT,

    CONSTRAINT "RawTiktokStatementTransaction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RawTiktokPayment" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "payloadHash" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "syncLogId" TEXT,

    CONSTRAINT "RawTiktokPayment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RawTiktokOrder" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "payloadHash" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "syncLogId" TEXT,

    CONSTRAINT "RawTiktokOrder_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RawTiktokStatement_shopId_externalId_fetchedAt_idx" ON "RawTiktokStatement"("shopId", "externalId", "fetchedAt");

-- CreateIndex
CREATE INDEX "RawTiktokStatement_fetchedAt_idx" ON "RawTiktokStatement"("fetchedAt");

-- CreateIndex
CREATE UNIQUE INDEX "RawTiktokStatement_shopId_externalId_payloadHash_key" ON "RawTiktokStatement"("shopId", "externalId", "payloadHash");

-- CreateIndex
CREATE INDEX "RawTiktokStatementTransaction_shopId_externalId_fetchedAt_idx" ON "RawTiktokStatementTransaction"("shopId", "externalId", "fetchedAt");

-- CreateIndex
CREATE INDEX "RawTiktokStatementTransaction_fetchedAt_idx" ON "RawTiktokStatementTransaction"("fetchedAt");

-- CreateIndex
CREATE UNIQUE INDEX "RawTiktokStatementTransaction_shopId_externalId_payloadHash_key" ON "RawTiktokStatementTransaction"("shopId", "externalId", "payloadHash");

-- CreateIndex
CREATE INDEX "RawTiktokPayment_shopId_externalId_fetchedAt_idx" ON "RawTiktokPayment"("shopId", "externalId", "fetchedAt");

-- CreateIndex
CREATE INDEX "RawTiktokPayment_fetchedAt_idx" ON "RawTiktokPayment"("fetchedAt");

-- CreateIndex
CREATE UNIQUE INDEX "RawTiktokPayment_shopId_externalId_payloadHash_key" ON "RawTiktokPayment"("shopId", "externalId", "payloadHash");

-- CreateIndex
CREATE INDEX "RawTiktokOrder_shopId_externalId_fetchedAt_idx" ON "RawTiktokOrder"("shopId", "externalId", "fetchedAt");

-- CreateIndex
CREATE INDEX "RawTiktokOrder_fetchedAt_idx" ON "RawTiktokOrder"("fetchedAt");

-- CreateIndex
CREATE UNIQUE INDEX "RawTiktokOrder_shopId_externalId_payloadHash_key" ON "RawTiktokOrder"("shopId", "externalId", "payloadHash");
