-- Cổng DB cho loại vay BULLET + tiền gửi tiết kiệm bắt buộc. TÁCH khỏi file
-- 20260910101500_them_loai_vay_goc_cuoi_ky vì Postgres cấm dùng giá trị enum mới trong cùng
-- transaction đã thêm nó — xem chú thích đầu file đó.
--
-- Prisma không quản CHECK và không báo drift (tiền lệ "CashMovement_amount_duong") nên viết tay.

-- GIỮ NGUYÊN TÊN "Loan_lich_theo_loai": tên constraint này là hợp đồng công khai — thông báo lỗi của
-- action và test tích hợp thấu chi đều khoá theo tên. BULLET đòi ĐỦ cả kỳ hạn lẫn ngày trả kỳ đầu:
-- không có kỳ hạn thì không biết kỳ nào là kỳ trả trọn gốc.
ALTER TABLE "Loan" DROP CONSTRAINT "Loan_lich_theo_loai";
ALTER TABLE "Loan" ADD CONSTRAINT "Loan_lich_theo_loai" CHECK (
  ("kind" = 'TERM' AND (("termMonths" IS NULL) = ("firstDueDate" IS NULL)))
  OR ("kind" = 'OVERDRAFT' AND "termMonths" IS NULL)
  OR ("kind" = 'BULLET' AND "termMonths" IS NOT NULL AND "firstDueDate" IS NOT NULL)
);

-- Tiền gửi mỗi kỳ luôn ≥ 0; lãi cố định NULL = "tính theo %/năm như cũ", có số thì phải ≥ 0.
-- KHÔNG dùng 0 làm sentinel: vay không lãi là trạng thái hợp lệ (vay người thân).
ALTER TABLE "Loan" ADD CONSTRAINT "Loan_tienGuiBatBuocMoiKy_khong_am" CHECK ("tienGuiBatBuocMoiKy" >= 0);
ALTER TABLE "Loan" ADD CONSTRAINT "Loan_laiCoDinhMoiKy_khong_am" CHECK ("laiCoDinhMoiKy" IS NULL OR "laiCoDinhMoiKy" >= 0);

-- Dòng tiền gửi/nhận lại tiết kiệm bắt buộc cũng là dòng "mồ côi" nếu không gắn khoản vay: không đối
-- chiếu lại được số ngân hàng đang giữ, và lúc tất toán không biết cấn trừ bao nhiêu.
ALTER TABLE "CashMovement" DROP CONSTRAINT "CashMovement_loan_bat_buoc";
ALTER TABLE "CashMovement" ADD CONSTRAINT "CashMovement_loan_bat_buoc"
  CHECK ("kind" NOT IN ('LOAN_IN','LOAN_REPAY','DEPOSIT_OUT','DEPOSIT_IN') OR "loanId" IS NOT NULL);
