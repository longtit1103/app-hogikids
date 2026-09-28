-- Hai loại dòng tiền cho sổ tiết kiệm SINH LÃI tự nguyện: SAVINGS_OUT (gửi) / SAVINGS_IN (nhận lại GỐC).
--
-- TÁCH LÀM HAI FILE MIGRATION LÀ BẮT BUỘC, KHÔNG PHẢI CHO ĐẸP: Postgres cấm DÙNG một giá trị enum
-- trong chính transaction vừa `ALTER TYPE … ADD VALUE` ra nó (55P04 "unsafe use of new value ... of
-- enum type"). Prisma bọc mỗi file migration trong MỘT transaction, nên mọi CHECK nhắc tới
-- 'SAVINGS_OUT' / 'SAVINGS_IN' phải nằm ở file SAU (…_them_bang_so_tiet_kiem_va_thu_nhap).
-- Tiền lệ y hệt: 20260910101500 / 20260910101600 (vay trả gốc cuối kỳ).
--
-- File này CHỈ thêm giá trị enum ⇒ migrate deploy prod KHÔNG cần tiền kiểm.

-- AlterEnum
ALTER TYPE "CashMovementKind" ADD VALUE 'SAVINGS_OUT';
ALTER TYPE "CashMovementKind" ADD VALUE 'SAVINGS_IN';
