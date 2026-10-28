-- Kỳ sao kê nhập từ PDF lưu thêm "trả chưa lên sao kê": Σ lần trả thẻ (`CARD_PAY`) ngày ≤ ngày chốt mà ngân hàng ghi
-- sổ SAU ngày chốt. Neo `soDu` đã trừ phần này, nhưng số in trên sao kê (`saoKeSoDu`) vẫn gồm nó ⇒ nghĩa vụ kỳ =
-- `saoKeSoDu − saoKeTraChuaLen` (trước đây kẹp tại neo nên đòi thừa đúng phần trả đó khi kỳ có cả bill ghi sổ trễ).
--
-- CHỈ THÊM một cột NULL, KHÔNG CHECK, KHÔNG điền số cho dòng cũ:
--  - NULL = nghĩa vụ tính như cũ (lõi dùng `?? 0`) ⇒ migrate deploy prod không cần tiền kiểm, P&L/quỹ không đổi.
--  - Không CHECK "kỳ PDF phải có cột": ảnh cũ (đường lùi ảnh) ghi kỳ PDF không biết cột này, CHECK sẽ làm chức năng
--    chốt sao kê PDF gãy sau khi lùi ảnh.
--  - Kỳ PDF đã chốt trước bản này: chạy `scripts/tinh-lai-sao-ke-tra-chua-len.ts` (xem trước mặc định, chủ shop duyệt
--    rồi mới ghi theo danh sách id) — không đoán số trong migration.

-- AlterTable
ALTER TABLE "KySaoKeThe" ADD COLUMN "saoKeTraChuaLen" INTEGER;
