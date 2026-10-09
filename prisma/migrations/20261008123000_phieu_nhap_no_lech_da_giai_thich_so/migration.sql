-- "Đã giải thích" lệch Sổ chi phí ≠ đã trả trước của phiếu nợ: thêm SỐ đi kèm cờ `lechDaGiaiThich`.
-- `lechDaGiaiThichSo` = `Expense.amount` cùng refId (không có dòng ⇒ 0) TẠI LÚC chủ shop giải thích.
-- Hậu kiểm ẩn cảnh báo `LECH_DA_TRA_TRUOC` CHỈ khi Expense hiện tại vẫn đúng số này: cờ boolean trơn
-- không phân biệt "lệch đã giải thích" với "lệch mới sau khi Expense bị sửa/xoá tiếp".
--
-- File RIÊNG (không sửa …_them_bang_no_phai_tra_va_rang_buoc đã áp lên DB test — sửa file đã áp là
-- để lại checksum lệch). CHỈ THÊM cột nullable vào bảng mới, chưa dòng prod nào ⇒ migrate deploy prod
-- KHÔNG cần tiền kiểm.

-- AlterTable
ALTER TABLE "PhieuNhapNo" ADD COLUMN "lechDaGiaiThichSo" INTEGER;
