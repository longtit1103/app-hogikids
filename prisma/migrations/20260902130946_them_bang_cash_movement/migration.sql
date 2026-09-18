-- CreateEnum
CREATE TYPE "CashMovementKind" AS ENUM ('LOAN_IN', 'CAPITAL_IN', 'DIRECT_SALE', 'OTHER_IN', 'LOAN_REPAY', 'CAPITAL_OUT');

-- CreateTable
CREATE TABLE "CashMovement" (
    "id" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "kind" "CashMovementKind" NOT NULL,
    "amount" INTEGER NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CashMovement_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CashMovement_date_idx" ON "CashMovement"("date");

-- Thêm tay: cổng DB cho bất biến "amount luôn dương" — chiều vào/ra suy từ kind nên số âm ở đây là
-- dữ liệu vô nghĩa. Prisma không quản CHECK và không báo drift (cùng kiểu với trigger updatedAt của
-- Setting, migration 20260725071943).
ALTER TABLE "CashMovement" ADD CONSTRAINT "CashMovement_amount_duong" CHECK ("amount" > 0);
