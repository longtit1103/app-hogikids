-- Sáu loại dòng tiền cho "Nợ phải trả" (tiền hàng NCC + thẻ tín dụng + ví ads trả trước):
--   CARD_PAY (trả thẻ, RA) · SUPPLIER_PAY (trả NCC, RA) · SUPPLIER_REFUND (NCC hoàn, VÀO) ·
--   CUTOVER_ADJ_IN / CUTOVER_ADJ_OUT (điều chỉnh MỘT LẦN tại mốc bật) · ADS_TOPUP (nạp ví ads; chiều
--   theo nguồn nạp — từ thẻ thì không chạm quỹ).
--
-- TÁCH LÀM HAI FILE MIGRATION LÀ BẮT BUỘC: Postgres cấm DÙNG một giá trị enum trong chính transaction
-- vừa `ALTER TYPE … ADD VALUE` ra nó (55P04 "unsafe use of new value ... of enum type"). Prisma bọc
-- mỗi file trong MỘT transaction, nên mọi CHECK nhắc tới sáu giá trị này nằm ở file SAU
-- (…_them_bang_no_phai_tra_va_rang_buoc). Tiền lệ: 20260916044605 / 20260916044938.
--
-- File này CHỈ thêm giá trị enum ⇒ migrate deploy prod KHÔNG cần tiền kiểm. `ADD VALUE` không lùi
-- được bằng migration — chấp nhận (tiền lệ): giá trị thừa không ai ghi thì vô hại.

-- AlterEnum
ALTER TYPE "CashMovementKind" ADD VALUE 'CARD_PAY';
ALTER TYPE "CashMovementKind" ADD VALUE 'SUPPLIER_PAY';
ALTER TYPE "CashMovementKind" ADD VALUE 'SUPPLIER_REFUND';
ALTER TYPE "CashMovementKind" ADD VALUE 'CUTOVER_ADJ_IN';
ALTER TYPE "CashMovementKind" ADD VALUE 'CUTOVER_ADJ_OUT';
ALTER TYPE "CashMovementKind" ADD VALUE 'ADS_TOPUP';
