-- Sổ tiết kiệm SINH LÃI: 2 bảng mới (SoTietKiem, ThuNhap) + cột "savingsId" trên CashMovement +
-- toàn bộ CHECK.
--
-- TÁCH khỏi file …_them_loai_dong_tien_tiet_kiem vì Postgres cấm dùng giá trị enum mới trong chính
-- transaction đã `ALTER TYPE … ADD VALUE` ra nó (55P04) — mọi CHECK nhắc 'SAVINGS_OUT'/'SAVINGS_IN'
-- phải nằm ở file SAU. Xem chú thích đầu file đó.
--
-- CHỈ THÊM (bảng mới, cột nullable mới, giá trị enum đã có sẵn từ file trước) — không sửa, không xoá
-- dòng nào đang có ⇒ migrate deploy prod KHÔNG cần tiền kiểm. Ba CHECK trên "CashMovement" thoả mãn
-- với MỌI dòng prod hiện có: "savingsId" vừa thêm nên toàn NULL ⇒ CHECK 2 và 3 đúng hiển nhiên, còn
-- CHECK 1 không đụng tới loại nào đang dùng.

-- CreateEnum
CREATE TYPE "ThuNhapKind" AS ENUM ('LAI_TIET_KIEM');

-- AlterTable
ALTER TABLE "CashMovement" ADD COLUMN     "savingsId" TEXT;

-- CreateTable
CREATE TABLE "SoTietKiem" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "bank" TEXT NOT NULL DEFAULT '',
    "principal" INTEGER NOT NULL,
    "startDate" TIMESTAMP(3) NOT NULL,
    "termMonths" INTEGER NOT NULL,
    "maturityDate" TIMESTAMP(3) NOT NULL,
    "annualRateBp" INTEGER NOT NULL,
    "loanId" TEXT,
    "closedAt" TIMESTAMP(3),
    "note" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SoTietKiem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ThuNhap" (
    "id" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "kind" "ThuNhapKind" NOT NULL,
    "amount" INTEGER NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "savingsId" TEXT,
    "refId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ThuNhap_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SoTietKiem_closedAt_idx" ON "SoTietKiem"("closedAt");

-- CreateIndex
CREATE INDEX "SoTietKiem_maturityDate_idx" ON "SoTietKiem"("maturityDate");

-- CreateIndex
CREATE UNIQUE INDEX "ThuNhap_refId_key" ON "ThuNhap"("refId");

-- CreateIndex
CREATE INDEX "ThuNhap_date_idx" ON "ThuNhap"("date");

-- CreateIndex
CREATE INDEX "ThuNhap_savingsId_idx" ON "ThuNhap"("savingsId");

-- CreateIndex
CREATE INDEX "CashMovement_savingsId_idx" ON "CashMovement"("savingsId");

-- AddForeignKey
ALTER TABLE "CashMovement" ADD CONSTRAINT "CashMovement_savingsId_fkey" FOREIGN KEY ("savingsId") REFERENCES "SoTietKiem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SoTietKiem" ADD CONSTRAINT "SoTietKiem_loanId_fkey" FOREIGN KEY ("loanId") REFERENCES "Loan"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ThuNhap" ADD CONSTRAINT "ThuNhap_savingsId_fkey" FOREIGN KEY ("savingsId") REFERENCES "SoTietKiem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ── CHECK viết tay ───────────────────────────────────────────────────────────
-- Prisma KHÔNG quản CHECK và KHÔNG báo drift (tiền lệ "CashMovement_amount_duong", migration
-- 20260902130946). Tên constraint là HỢP ĐỒNG CÔNG KHAI: test tích hợp và thông báo lỗi của action
-- khoá theo tên — đổi tên là phá hợp đồng.

-- Sổ 0đ không phải sổ, số âm làm phép "Σ SAVINGS_OUT − Σ SAVINGS_IN" ra dư nợ vô nghĩa.
ALTER TABLE "SoTietKiem" ADD CONSTRAINT "SoTietKiem_principal_duong" CHECK ("principal" > 0);
-- Kỳ hạn tính bằng THÁNG, tối thiểu 1: 0 tháng thì không có ngày đáo hạn nào hợp lệ.
ALTER TABLE "SoTietKiem" ADD CONSTRAINT "SoTietKiem_termMonths_duong" CHECK ("termMonths" >= 1);
-- Lãi suất 0 là ca HỢP LỆ (gửi giữ hộ, không lấy lãi); âm thì không. KHÔNG dùng 0 làm sentinel.
ALTER TABLE "SoTietKiem" ADD CONSTRAINT "SoTietKiem_annualRateBp_khong_am" CHECK ("annualRateBp" >= 0);
-- Đáo hạn phải SAU ngày gửi: bằng hoặc trước ⇒ số ngày gửi ≤ 0 ⇒ lãi dự kiến 0/âm và cột "còn N
-- ngày" in ra số vô nghĩa.
ALTER TABLE "SoTietKiem" ADD CONSTRAINT "SoTietKiem_dao_han_sau_ngay_gui" CHECK ("maturityDate" > "startDate");

-- Thu nhập 0đ/âm là dữ liệu vô nghĩa và cộng THẲNG vào P&L. Chặn ở DB chứ không chỉ zod: "Expense"
-- chỉ chặn ở zod nên đường ingest ads đi vòng qua được — bảng mới không lặp lại lỗ hổng đó.
ALTER TABLE "ThuNhap" ADD CONSTRAINT "ThuNhap_amount_duong" CHECK ("amount" > 0);

-- Dòng SAVINGS_* không gắn sổ là tiền "mồ côi": không suy được số dư đang gửi của sổ nào, tất toán
-- không biết cấn trừ bao nhiêu (đúng lý do đã dựng "CashMovement_loan_bat_buoc" cho khoản vay).
ALTER TABLE "CashMovement" ADD CONSTRAINT "CashMovement_savings_bat_buoc"
  CHECK ("kind" NOT IN ('SAVINGS_OUT','SAVINGS_IN') OR "savingsId" IS NOT NULL);
-- Chiều ngược lại: gắn sổ vào loại khác (vd CAPITAL_OUT) làm phép Σ theo "savingsId" đếm cả tiền
-- không phải tiền gửi ⇒ số dư sổ sai mà không ai thấy.
ALTER TABLE "CashMovement" ADD CONSTRAINT "CashMovement_savings_dung_cho"
  CHECK ("savingsId" IS NULL OR "kind" IN ('SAVINGS_OUT','SAVINGS_IN'));
-- Một dòng tiền không thể vừa thuộc khoản vay vừa thuộc sổ tiết kiệm: hai trục dư nợ khác nhau,
-- dính cả hai thì mỗi trục đều cộng nhầm đúng số tiền đó.
ALTER TABLE "CashMovement" ADD CONSTRAINT "CashMovement_loan_savings_loai_tru"
  CHECK ("loanId" IS NULL OR "savingsId" IS NULL);
