-- Mỗi mẫu chi phí định kỳ TỐI ĐA 1 dòng `Expense`/tháng — bảo đảm bằng UNIQUE dưới DB thay cho
-- transaction Serializable + findFirst ở bộ sinh (`ensureRecurringExpenses`). Bộ sinh chạy MỖI lượt
-- render Dashboard/Tài chính; transaction bị cắt ngang khi rời trang giữa chừng ⇒ Prisma "Transaction
-- not found" ⇒ trang 500. Nay bộ sinh chèn MỘT câu `INSERT … ON CONFLICT DO NOTHING` (nguyên tử).
--
-- `recurringMonth` = khoá `yyyy-MM` theo GIỜ VN của `date`. Cột `date` là timestamp KHÔNG múi giờ
-- chứa giờ UTC (Prisma ghi UTC) ⇒ đổi đúng chiều: `date AT TIME ZONE 'UTC'` (đọc naive là UTC →
-- timestamptz) rồi `AT TIME ZONE 'Asia/Ho_Chi_Minh'` (→ giờ tường VN). Viết thẳng
-- `date AT TIME ZONE 'Asia/Ho_Chi_Minh'` là SAI CHIỀU (đọc naive như giờ VN ⇒ lệch 7 tiếng ngược
-- hướng, dòng sát biên tháng rơi sai tháng).
-- Biểu thức không phụ thuộc `TimeZone` của phiên nên chạy ở đâu cũng ra cùng kết quả.
--
-- Không đổi số tiền nào: chỉ thêm cột + backfill khoá cho dòng định kỳ đã có (prod đo 28/09: 0 dòng
-- mang `recurringId`, 0 nhóm trùng). Dòng thường giữ NULL — NULL khác nhau trong UNIQUE của Postgres
-- ⇒ không ảnh hưởng. Có nhóm trùng sẵn thì CREATE UNIQUE INDEX thất bại và cả migration rollback.

-- AlterTable
ALTER TABLE "Expense" ADD COLUMN "recurringMonth" TEXT;

-- Backfill
UPDATE "Expense"
SET "recurringMonth" = to_char(("date" AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Ho_Chi_Minh', 'YYYY-MM')
WHERE "recurringId" IS NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "Expense_recurringId_recurringMonth_key" ON "Expense"("recurringId", "recurringMonth");

-- Prisma không quản CHECK và không báo drift (cùng kiểu `CashMovement_amount_duong`).
-- (1) Khoá tháng có ⇔ dòng định kỳ: dòng định kỳ thiếu khoá là lọt khỏi UNIQUE (NULL không trùng).
ALTER TABLE "Expense" ADD CONSTRAINT "Expense_recurringMonth_chi_cho_dinh_ky"
  CHECK (("recurringId" IS NULL) = ("recurringMonth" IS NULL));

-- (2) Khoá tháng khớp tháng VN của `date`: writer quên cập nhật khoá khi đổi ngày (hay tính theo UTC)
-- là UNIQUE canh sai tháng — chặn ngay ở câu ghi thay vì để trùng/thiếu dòng âm thầm.
ALTER TABLE "Expense" ADD CONSTRAINT "Expense_recurringMonth_khop_ngay"
  CHECK (
    "recurringMonth" IS NULL
    OR "recurringMonth" = to_char(("date" AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Ho_Chi_Minh', 'YYYY-MM')
  );
