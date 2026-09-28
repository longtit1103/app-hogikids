-- Loại vay thứ ba: "vay trả gốc cuối kỳ" (BULLET) + tiền gửi tiết kiệm bắt buộc.
--
-- TÁCH LÀM HAI FILE MIGRATION LÀ BẮT BUỘC, KHÔNG PHẢI CHO ĐẸP: Postgres cấm DÙNG một giá trị enum
-- trong chính transaction vừa `ALTER TYPE … ADD VALUE` ra nó ("unsafe use of new value ... of enum
-- type"). Prisma bọc mỗi file migration trong MỘT transaction, nên mọi CHECK nhắc tới 'BULLET' /
-- 'DEPOSIT_OUT' / 'DEPOSIT_IN' phải nằm ở file SAU (20260910101600_rang_buoc_vay_goc_cuoi_ky).
--
-- File này chỉ thêm giá trị enum + cột nullable/có default ⇒ migrate deploy prod KHÔNG cần tiền kiểm.

-- AlterEnum
ALTER TYPE "LoanKind" ADD VALUE 'BULLET';

-- AlterEnum
ALTER TYPE "CashMovementKind" ADD VALUE 'DEPOSIT_OUT';
ALTER TYPE "CashMovementKind" ADD VALUE 'DEPOSIT_IN';

-- AlterTable
ALTER TABLE "Loan" ADD COLUMN     "laiCoDinhMoiKy" INTEGER,
ADD COLUMN     "tienGuiBatBuocMoiKy" INTEGER NOT NULL DEFAULT 0;
