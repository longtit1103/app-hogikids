-- Sổ tiết kiệm nhớ id dòng `CashMovement` `SAVINGS_IN` do CHÍNH lượt tất toán sinh, để "Mở lại" chỉ xoá đúng dòng
-- đó và giữ nguyên dòng nhận gốc ghi tay (trước đây mở lại đoán theo số lượng dòng nhận nên có thể xoá dòng tay).
--
-- CHỈ THÊM: một cột NULL + index duy nhất (Postgres cho nhiều NULL). Không CHECK, không FK, không backfill — sổ đã
-- tất toán trước bản này để NULL; mở lại sổ đó mà còn dòng mang mẫu mô tả app sinh bị từ chối tới khi chủ shop
-- duyệt và gán dấu bằng `scripts/danh-dau-dong-nhan-goc-tat-toan.ts`. Quỹ, P&L không đổi. Rollback = ảnh cũ + cột
-- thừa vô hại.

-- AlterTable
ALTER TABLE "SoTietKiem" ADD COLUMN "dongNhanGocTatToanId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "SoTietKiem_dongNhanGocTatToanId_key" ON "SoTietKiem"("dongNhanGocTatToanId");
