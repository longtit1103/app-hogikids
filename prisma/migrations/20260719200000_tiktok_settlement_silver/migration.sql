-- CreateTable
CREATE TABLE "TiktokSettlement" (
    "id" TEXT NOT NULL,
    "statementId" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "statementTime" TIMESTAMP(3) NOT NULL,
    "paymentTime" TIMESTAMP(3),
    "paymentStatus" TEXT NOT NULL,
    "paymentId" TEXT,
    "settlementAmount" INTEGER NOT NULL,
    "revenueAmount" INTEGER NOT NULL,
    "feeAmount" INTEGER NOT NULL,
    "adjustmentAmount" INTEGER NOT NULL,
    "netSalesAmount" INTEGER NOT NULL,
    "shippingCostAmount" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'VND',
    "raw" JSONB,
    "syncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TiktokSettlement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TiktokAdsSettlement" (
    "id" TEXT NOT NULL,
    "transactionId" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "adjustmentId" TEXT,
    "orderCreateTime" TIMESTAMP(3) NOT NULL,
    "settlementAmount" INTEGER NOT NULL,
    "raw" JSONB,
    "syncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TiktokAdsSettlement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TiktokPayment" (
    "id" TEXT NOT NULL,
    "paymentId" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "paidTime" TIMESTAMP(3),
    "settlementValue" INTEGER NOT NULL,
    "amountValue" INTEGER NOT NULL,
    "reserveValue" INTEGER NOT NULL DEFAULT 0,
    "bankAccount" TEXT,
    "raw" JSONB,
    "syncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TiktokPayment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "TiktokSettlement_statementId_key" ON "TiktokSettlement"("statementId");

-- CreateIndex
CREATE INDEX "TiktokSettlement_statementTime_idx" ON "TiktokSettlement"("statementTime");

-- CreateIndex
CREATE UNIQUE INDEX "TiktokAdsSettlement_transactionId_key" ON "TiktokAdsSettlement"("transactionId");

-- CreateIndex
CREATE INDEX "TiktokAdsSettlement_orderCreateTime_idx" ON "TiktokAdsSettlement"("orderCreateTime");

-- CreateIndex
CREATE UNIQUE INDEX "TiktokPayment_paymentId_key" ON "TiktokPayment"("paymentId");

-- CreateIndex
CREATE INDEX "TiktokPayment_paidTime_idx" ON "TiktokPayment"("paidTime");

