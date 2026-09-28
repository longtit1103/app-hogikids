-- Mốc bắt đầu sinh cho mẫu chi phí định kỳ — 25/09. Mở đường BẬT LẠI mẫu đã dừng mà không ghi lùi
-- chi phí vào các tháng đã dừng: mẫu chỉ sinh `Expense` cho tháng M khi `activeFrom IS NULL` hoặc
-- đầu tháng M >= đầu tháng `activeFrom` (giờ VN).
-- CHỈ THÊM một cột NULL, KHÔNG backfill: mẫu hiện có giữ `NULL` = hành vi cũ y nguyên (không cận
-- dưới) ⇒ không đổi một đồng nào trong P&L/Sổ quỹ. Lùi ảnh là đủ (cột thừa vô hại).

-- AlterTable
ALTER TABLE "RecurringExpense" ADD COLUMN "activeFrom" TIMESTAMP(3);
