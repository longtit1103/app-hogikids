-- Nhập sao kê thẻ tín dụng từ file PDF: kỳ sao kê (`KySaoKeThe`) ghi thêm nguồn + số in trên sao kê + vân tay file,
-- và bảng con `DongSaoKeThe` giữ các dòng giao dịch tách từ file (chỉ để soi lại/đối chiếu, KHÔNG tham gia tính
-- dư nợ — dư nợ vẫn chỉ đọc `KySaoKeThe.soDu` + giao dịch app).
--
-- CHỈ THÊM: 4 cột mới đều có mặc định/NULL (dòng cũ = "TAY", NULL) + một bảng mới rỗng ⇒ migrate deploy prod KHÔNG
-- cần tiền kiểm. Quỹ, P&L, công thức dư nợ không đổi. Rollback = ảnh cũ + cột/bảng thừa vô hại.

-- AlterTable
ALTER TABLE "KySaoKeThe"
    ADD COLUMN "nguon" TEXT NOT NULL DEFAULT 'TAY',
    ADD COLUMN "saoKeSoDu" INTEGER,
    ADD COLUMN "saoKeTongBillGhiSoTre" INTEGER,
    ADD COLUMN "saoKeHash" TEXT;

-- CreateTable
CREATE TABLE "DongSaoKeThe" (
    "id" TEXT NOT NULL,
    "kyId" TEXT NOT NULL,
    "ngayGiaoDich" TIMESTAMP(3) NOT NULL,
    "ngayGhiSo" TIMESTAMP(3) NOT NULL,
    "ghiNo" INTEGER NOT NULL,
    "ghiCo" INTEGER NOT NULL,
    "dienGiai" TEXT NOT NULL,
    "laTiktok" BOOLEAN NOT NULL,
    "hoaDonId" TEXT,

    CONSTRAINT "DongSaoKeThe_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DongSaoKeThe_kyId_idx" ON "DongSaoKeThe"("kyId");

-- AddForeignKey: xoá kỳ ⇒ dòng sao kê đi theo (dòng con không có nghĩa khi mất kỳ).
ALTER TABLE "DongSaoKeThe" ADD CONSTRAINT "DongSaoKeThe_kyId_fkey" FOREIGN KEY ("kyId") REFERENCES "KySaoKeThe"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Nguồn chỉ có hai giá trị; action dịch lỗi theo TÊN constraint nên tên là hợp đồng.
ALTER TABLE "KySaoKeThe" ADD CONSTRAINT "KySaoKeThe_nguon" CHECK ("nguon" IN ('TAY', 'SAO_KE_PDF'));

-- Kỳ nhập từ PDF PHẢI mang đủ số in trên sao kê + vân tay file (thiếu vân tay là cổng "một file một lần" mù);
-- kỳ gõ tay KHÔNG được mang chúng (lẫn hai nguồn là soi lại sai).
ALTER TABLE "KySaoKeThe" ADD CONSTRAINT "KySaoKeThe_sao_ke_pdf_du_truong" CHECK (
    ("nguon" = 'SAO_KE_PDF' AND "saoKeHash" IS NOT NULL AND "saoKeSoDu" IS NOT NULL AND "saoKeTongBillGhiSoTre" IS NOT NULL)
    OR ("nguon" = 'TAY' AND "saoKeHash" IS NULL AND "saoKeSoDu" IS NULL AND "saoKeTongBillGhiSoTre" IS NULL)
);

-- Số in trên sao kê: dư nợ (dương = đang nợ) và tổng bill ghi sổ trễ đều không âm.
ALTER TABLE "KySaoKeThe" ADD CONSTRAINT "KySaoKeThe_sao_ke_pdf_khong_am" CHECK (
    ("saoKeSoDu" IS NULL OR "saoKeSoDu" >= 0) AND ("saoKeTongBillGhiSoTre" IS NULL OR "saoKeTongBillGhiSoTre" >= 0)
);

-- Tiền dòng sao kê không dấu — chiều nằm ở cột (ghi nợ / ghi có).
ALTER TABLE "DongSaoKeThe" ADD CONSTRAINT "DongSaoKeThe_tien_khong_am" CHECK ("ghiNo" >= 0 AND "ghiCo" >= 0);

-- Một file sao kê chỉ nhập MỘT lần cho một thẻ. Unique có điều kiện viết tay (Prisma không khai được `WHERE`):
-- kỳ gõ tay có `saoKeHash` NULL nên không dính.
CREATE UNIQUE INDEX "KySaoKeThe_mot_sao_ke_pdf_moi_the" ON "KySaoKeThe" ("cardId", "saoKeHash") WHERE "saoKeHash" IS NOT NULL;
