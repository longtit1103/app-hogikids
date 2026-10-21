-- Loại dòng tiền LAI_NHAP_GOC: lãi kỳ của khoản thấu chi "lãi nhập gốc" — ngân hàng CỘNG lãi vào dư nợ
-- thay vì trừ tài khoản. VÀO quỹ, đi cặp với `Expense` lãi cùng số ⇒ quỹ net 0, dư nợ + lãi.
--
-- TÁCH LÀM HAI FILE MIGRATION LÀ BẮT BUỘC: Postgres cấm DÙNG một giá trị enum trong chính transaction
-- vừa `ALTER TYPE … ADD VALUE` ra nó (55P04 "unsafe use of new value ... of enum type"). Prisma bọc
-- mỗi file trong MỘT transaction, nên CHECK + index nhắc tới giá trị này nằm ở file SAU
-- (…_lai_nhap_goc_thau_chi_va_rang_buoc). Tiền lệ: 20261008094600 / 20261008094601.
--
-- File này CHỈ thêm giá trị enum ⇒ migrate deploy prod KHÔNG cần tiền kiểm. `ADD VALUE` không lùi
-- được bằng migration — chấp nhận (tiền lệ): giá trị thừa không ai ghi thì vô hại.

-- AlterEnum
ALTER TYPE "CashMovementKind" ADD VALUE 'LAI_NHAP_GOC';
