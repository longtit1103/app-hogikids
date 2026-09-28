-- TIỀN KIỂM trước migrate deploy prod: SELECT count(*) FROM "CashMovement" WHERE kind IN ('LOAN_IN','LOAN_REPAY') AND "loanId" IS NULL; phải = 0, nếu > 0 gắn loanId tay trước (phase 5 bước 5.5).

-- AlterTable
ALTER TABLE "CashMovement" ADD COLUMN     "loanId" TEXT;

-- CreateTable
CREATE TABLE "Loan" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "lender" TEXT NOT NULL DEFAULT '',
    "duNoMoSo" INTEGER NOT NULL DEFAULT 0,
    "startDate" TIMESTAMP(3) NOT NULL,
    "annualRateBp" INTEGER NOT NULL DEFAULT 0,
    "termMonths" INTEGER,
    "firstDueDate" TIMESTAMP(3),
    "lastDueHandled" TIMESTAMP(3),
    "closedAt" TIMESTAMP(3),
    "note" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Loan_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CashMovement_loanId_idx" ON "CashMovement"("loanId");

-- AddForeignKey
ALTER TABLE "CashMovement" ADD CONSTRAINT "CashMovement_loanId_fkey" FOREIGN KEY ("loanId") REFERENCES "Loan"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Thêm tay (Prisma không quản CHECK, tiền lệ CashMovement_amount_duong):
ALTER TABLE "Loan" ADD CONSTRAINT "Loan_duNoMoSo_khong_am" CHECK ("duNoMoSo" >= 0);
ALTER TABLE "Loan" ADD CONSTRAINT "Loan_annualRateBp_khong_am" CHECK ("annualRateBp" >= 0);
ALTER TABLE "Loan" ADD CONSTRAINT "Loan_termMonths_duong" CHECK ("termMonths" IS NULL OR "termMonths" >= 1);
-- Có lịch thì phải có ĐỦ cả kỳ hạn lẫn ngày trả kỳ đầu; không lịch thì cả hai NULL (vay người thân).
ALTER TABLE "Loan" ADD CONSTRAINT "Loan_lich_du_doi" CHECK (("termMonths" IS NULL) = ("firstDueDate" IS NULL));
-- Dòng gốc vay/trả gốc không gắn khoản vay là dư nợ "mồ côi" — chặn ở DB, zod là lớp một.
ALTER TABLE "CashMovement" ADD CONSTRAINT "CashMovement_loan_bat_buoc"
  CHECK ("kind" NOT IN ('LOAN_IN','LOAN_REPAY') OR "loanId" IS NOT NULL);
-- Danh mục hệ thống "Lãi vay". name là @unique: nếu chủ shop đã tự tạo danh mục tên này (id ngẫu nhiên)
-- thì đổi tên bản cũ trước, kẻo INSERT vỡ giữa migrate prod.
UPDATE "ExpenseCategory" SET name = 'Lãi vay (cũ)' WHERE name = 'Lãi vay' AND id <> 'interest';
INSERT INTO "ExpenseCategory" (id, name, "isSystem", "isHidden") VALUES ('interest', 'Lãi vay', true, false)
  ON CONFLICT (id) DO NOTHING;
