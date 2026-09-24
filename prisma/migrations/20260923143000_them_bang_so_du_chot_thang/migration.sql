-- Chốt số dư THẬT cuối tháng (bank + tiền mặt) — hàng rào bắt sai cộng dồn sổ quỹ (S6 #1, 23/09).
-- CHỈ THÊM một bảng mới, không sửa/xoá gì đang có ⇒ migrate deploy prod KHÔNG cần tiền kiểm; lùi ảnh
-- là đủ (bảng thừa vô hại). Không vào Lãi/Lỗ — xem chú thích model trong schema.prisma.

-- CreateTable
CREATE TABLE "SoDuChotThang" (
    "id" TEXT NOT NULL,
    "thang" TIMESTAMP(3) NOT NULL,
    "soDuBank" INTEGER NOT NULL,
    "tienMat" INTEGER NOT NULL,
    "note" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SoDuChotThang_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SoDuChotThang_thang_key" ON "SoDuChotThang"("thang");


-- Tiền mặt không thể âm; số dư bank CỐ Ý không CHECK (thấu chi làm bank âm là hợp lệ).
ALTER TABLE "SoDuChotThang" ADD CONSTRAINT "SoDuChotThang_tienMat_khong_am" CHECK ("tienMat" >= 0);
