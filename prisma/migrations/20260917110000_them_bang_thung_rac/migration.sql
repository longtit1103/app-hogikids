-- THÙNG RÁC KHÔI PHỤC: một bảng snapshot DUY NHẤT cho 5 bảng tiền nhập tay (Expense, CashMovement,
-- ThuNhap, Loan, SoTietKiem).
--
-- CHỈ THÊM — một bảng mới, không cột nào của bảng đang có bị sửa/xoá, không FK nào trỏ vào dữ liệu
-- cũ ⇒ `migrate deploy` trên prod KHÔNG cần tiền kiểm và không khoá bảng nào đang chạy.
--
-- CỐ Ý KHÔNG có khoá ngoại tới bản ghi gốc: bản ghi đó đã bị xoá CỨNG rồi, "banGhiId" chỉ là id cũ
-- giữ lại để dựng lại đúng id đó lúc khôi phục.

-- CreateTable
CREATE TABLE "BanGhiDaXoa" (
    "id" TEXT NOT NULL,
    "bang" TEXT NOT NULL,
    "banGhiId" TEXT NOT NULL,
    "nhan" TEXT NOT NULL,
    "soTien" INTEGER NOT NULL,
    "ngay" TIMESTAMP(3) NOT NULL,
    "anh" JSONB NOT NULL,
    "xoaLuc" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "khoiPhucLuc" TIMESTAMP(3),

    CONSTRAINT "BanGhiDaXoa_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
-- Màn thùng rác sắp xếp "mới xoá trước" nên index theo đúng cột đó.
CREATE INDEX "BanGhiDaXoa_xoaLuc_idx" ON "BanGhiDaXoa"("xoaLuc");

-- CreateIndex
-- Tra "bản ghi này từng bị xoá lần nào chưa" lúc đối chiếu sự cố + lúc khôi phục cụm.
CREATE INDEX "BanGhiDaXoa_bang_banGhiId_idx" ON "BanGhiDaXoa"("bang", "banGhiId");
