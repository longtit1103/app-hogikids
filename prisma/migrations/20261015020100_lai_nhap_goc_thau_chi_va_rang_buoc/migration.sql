-- Thấu chi "lãi nhập gốc" — cờ trên hồ sơ khoản vay + ràng buộc cho loại dòng tiền LAI_NHAP_GOC
-- (giá trị enum thêm ở file trước, xem lý do tách file ở đó).
--
-- AN TOÀN VỚI DỮ LIỆU CÓ SẴN, không cần tiền kiểm — chứng minh từng vế:
--  · cột "laiNhapGoc" thêm với DEFAULT false ⇒ mọi khoản vay cũ = false ⇒ CHECK
--    "Loan_lai_nhap_goc_chi_thau_chi" đúng hiển nhiên; hành vi mọi khoản cũ giữ nguyên;
--  · LAI_NHAP_GOC là giá trị enum MỚI TINH ⇒ không dòng CashMovement nào mang nó ⇒ vế mới của
--    "CashMovement_loan_bat_buoc" đúng hiển nhiên; các vế cũ giữ NGUYÊN chữ (Postgres re-validate toàn
--    bảng khi ADD CONSTRAINT — chỉ vỡ nếu dữ liệu đã vỡ luật cũ từ trước, không phải rủi ro mới);
--  · index duy nhất có điều kiện kind = LAI_NHAP_GOC ⇒ tập dòng rỗng lúc tạo.

-- AlterTable
ALTER TABLE "Loan" ADD COLUMN "laiNhapGoc" BOOLEAN NOT NULL DEFAULT false;

-- Chỉ THẤU CHI có khái niệm "lãi nhập gốc": vay kỳ hạn / trả gốc cuối kỳ có lịch trả gốc cố định, ngân
-- hàng thu lãi bằng tiền. Cờ bật trên loại khác là số chết — chặn thẳng ở lớp cuối.
ALTER TABLE "Loan" ADD CONSTRAINT "Loan_lai_nhap_goc_chi_thau_chi"
  CHECK ("kind" = 'OVERDRAFT' OR "laiNhapGoc" = false);

-- LAI_NHAP_GOC làm TĂNG dư nợ khoản vay ⇒ không gắn khoản vay là dư nợ "mồ côi" (cùng luật gốc vay).
ALTER TABLE "CashMovement" DROP CONSTRAINT "CashMovement_loan_bat_buoc";
ALTER TABLE "CashMovement" ADD CONSTRAINT "CashMovement_loan_bat_buoc"
  CHECK ("kind" NOT IN ('LOAN_IN','LOAN_REPAY','DEPOSIT_OUT','DEPOSIT_IN','LAI_NHAP_GOC') OR "loanId" IS NOT NULL);

-- MỘT dòng lãi nhập gốc mỗi khoản mỗi ngày kỳ: dòng này đi CẶP với `Expense` lãi `refId`
-- `LOAN:{loanId}:{yyyy-MM-dd}` (unique) — khoá cặp là (loanId, ngày kỳ). Hai dòng cùng khoá là cặp
-- không còn xác định được (xoá/khôi phục kỳ đi nhầm dòng). Cổng chống trùng thứ ba, sau con dấu
-- `lastDueHandled` và `Expense.refId`.
CREATE UNIQUE INDEX "CashMovement_lai_nhap_goc_mot_ky" ON "CashMovement" ("loanId", "date") WHERE "kind" = 'LAI_NHAP_GOC';
