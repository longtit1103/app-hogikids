-- Chỉ thêm cột có default + đổi CHECK: migrate deploy prod không cần tiền kiểm.

-- CreateEnum
CREATE TYPE "LoanKind" AS ENUM ('TERM', 'OVERDRAFT');

-- AlterTable
ALTER TABLE "Loan" ADD COLUMN     "kind" "LoanKind" NOT NULL DEFAULT 'TERM';

-- Thay CHECK "Loan_lich_du_doi" (luật cũ: có kỳ hạn ⇔ có ngày trả kỳ đầu). Thấu chi KHÔNG có lịch trả
-- gốc nên "termMonths" luôn NULL, còn ngày thu lãi kỳ đầu là TUỲ CHỌN (NULL = chỉ thu lãi lúc tất
-- toán) — luật cũ sẽ chặn đúng ca hợp lệ đó. TERM giữ nguyên luật cũ từng chữ.
ALTER TABLE "Loan" DROP CONSTRAINT "Loan_lich_du_doi";
ALTER TABLE "Loan" ADD CONSTRAINT "Loan_lich_theo_loai" CHECK (
  ("kind" = 'TERM' AND (("termMonths" IS NULL) = ("firstDueDate" IS NULL)))
  OR ("kind" = 'OVERDRAFT' AND "termMonths" IS NULL)
);
