-- CreateTable
CREATE TABLE "RawPancakeOrder" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "payloadHash" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "syncLogId" TEXT,

    CONSTRAINT "RawPancakeOrder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RawPancakeProduct" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "payloadHash" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "syncLogId" TEXT,

    CONSTRAINT "RawPancakeProduct_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RawPancakeVariation" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "payloadHash" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "syncLogId" TEXT,

    CONSTRAINT "RawPancakeVariation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RawPancakePurchase" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "payloadHash" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "syncLogId" TEXT,

    CONSTRAINT "RawPancakePurchase_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RawPancakeInventoryHistory" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "payloadHash" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "syncLogId" TEXT,

    CONSTRAINT "RawPancakeInventoryHistory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RawPancakeTransaction" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "payloadHash" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "syncLogId" TEXT,

    CONSTRAINT "RawPancakeTransaction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RawPancakeReverseOrder" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "payloadHash" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "syncLogId" TEXT,

    CONSTRAINT "RawPancakeReverseOrder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RawPancakeCustomer" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "payloadHash" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "syncLogId" TEXT,

    CONSTRAINT "RawPancakeCustomer_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RawPancakeOrder_shopId_externalId_fetchedAt_idx" ON "RawPancakeOrder"("shopId", "externalId", "fetchedAt");

-- CreateIndex
CREATE INDEX "RawPancakeOrder_fetchedAt_idx" ON "RawPancakeOrder"("fetchedAt");

-- CreateIndex
CREATE UNIQUE INDEX "RawPancakeOrder_shopId_externalId_payloadHash_key" ON "RawPancakeOrder"("shopId", "externalId", "payloadHash");

-- CreateIndex
CREATE INDEX "RawPancakeProduct_shopId_externalId_fetchedAt_idx" ON "RawPancakeProduct"("shopId", "externalId", "fetchedAt");

-- CreateIndex
CREATE INDEX "RawPancakeProduct_fetchedAt_idx" ON "RawPancakeProduct"("fetchedAt");

-- CreateIndex
CREATE UNIQUE INDEX "RawPancakeProduct_shopId_externalId_payloadHash_key" ON "RawPancakeProduct"("shopId", "externalId", "payloadHash");

-- CreateIndex
CREATE INDEX "RawPancakeVariation_shopId_externalId_fetchedAt_idx" ON "RawPancakeVariation"("shopId", "externalId", "fetchedAt");

-- CreateIndex
CREATE INDEX "RawPancakeVariation_fetchedAt_idx" ON "RawPancakeVariation"("fetchedAt");

-- CreateIndex
CREATE UNIQUE INDEX "RawPancakeVariation_shopId_externalId_payloadHash_key" ON "RawPancakeVariation"("shopId", "externalId", "payloadHash");

-- CreateIndex
CREATE INDEX "RawPancakePurchase_shopId_externalId_fetchedAt_idx" ON "RawPancakePurchase"("shopId", "externalId", "fetchedAt");

-- CreateIndex
CREATE INDEX "RawPancakePurchase_fetchedAt_idx" ON "RawPancakePurchase"("fetchedAt");

-- CreateIndex
CREATE UNIQUE INDEX "RawPancakePurchase_shopId_externalId_payloadHash_key" ON "RawPancakePurchase"("shopId", "externalId", "payloadHash");

-- CreateIndex
CREATE INDEX "RawPancakeInventoryHistory_shopId_externalId_fetchedAt_idx" ON "RawPancakeInventoryHistory"("shopId", "externalId", "fetchedAt");

-- CreateIndex
CREATE INDEX "RawPancakeInventoryHistory_fetchedAt_idx" ON "RawPancakeInventoryHistory"("fetchedAt");

-- CreateIndex
CREATE UNIQUE INDEX "RawPancakeInventoryHistory_shopId_externalId_payloadHash_key" ON "RawPancakeInventoryHistory"("shopId", "externalId", "payloadHash");

-- CreateIndex
CREATE INDEX "RawPancakeTransaction_shopId_externalId_fetchedAt_idx" ON "RawPancakeTransaction"("shopId", "externalId", "fetchedAt");

-- CreateIndex
CREATE INDEX "RawPancakeTransaction_fetchedAt_idx" ON "RawPancakeTransaction"("fetchedAt");

-- CreateIndex
CREATE UNIQUE INDEX "RawPancakeTransaction_shopId_externalId_payloadHash_key" ON "RawPancakeTransaction"("shopId", "externalId", "payloadHash");

-- CreateIndex
CREATE INDEX "RawPancakeReverseOrder_shopId_externalId_fetchedAt_idx" ON "RawPancakeReverseOrder"("shopId", "externalId", "fetchedAt");

-- CreateIndex
CREATE INDEX "RawPancakeReverseOrder_fetchedAt_idx" ON "RawPancakeReverseOrder"("fetchedAt");

-- CreateIndex
CREATE UNIQUE INDEX "RawPancakeReverseOrder_shopId_externalId_payloadHash_key" ON "RawPancakeReverseOrder"("shopId", "externalId", "payloadHash");

-- CreateIndex
CREATE INDEX "RawPancakeCustomer_shopId_externalId_fetchedAt_idx" ON "RawPancakeCustomer"("shopId", "externalId", "fetchedAt");

-- CreateIndex
CREATE INDEX "RawPancakeCustomer_fetchedAt_idx" ON "RawPancakeCustomer"("fetchedAt");

-- CreateIndex
CREATE UNIQUE INDEX "RawPancakeCustomer_shopId_externalId_payloadHash_key" ON "RawPancakeCustomer"("shopId", "externalId", "payloadHash");
