-- Ads TikTok trả bằng TÍN DỤNG TẶNG theo ngày chi tiêu:
--   Bronze "RawTiktokBusinessCost" (stream `tiktokbusiness/cost`, `/bc/account/cost/get/` gọi từng ngày; mỗi dòng
--   là ẢNH CHỤP nguyên envelope một ngày, externalId = ngày VN) → Silver "TiktokAdsTinDung" (advertiser × ngày).
-- P&L đọc Silver để trừ phần tín dụng (đã nhân VAT) khỏi dòng Quảng cáo TikTok. KHÔNG đụng quỹ, nợ thẻ, Sổ chi phí.
--
-- CHỈ THÊM hai bảng mới — không đụng dòng nào đang có ⇒ migrate deploy prod KHÔNG cần tiền kiểm. Hai bảng rỗng tới
-- khi chạy `scripts/backfill-tiktok-ads-tin-dung.ts` (lượt kéo đêm `tiktok-business-nightly` tự nạp 7 ngày gần nhất).
-- Bảng rỗng ⇒ P&L y hệt trước (trừ 0). Rollback = ảnh cũ + hai bảng thừa vô hại.

-- CreateTable
CREATE TABLE "RawTiktokBusinessCost" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "payloadHash" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "syncLogId" TEXT,

    CONSTRAINT "RawTiktokBusinessCost_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TiktokAdsTinDung" (
    "id" TEXT NOT NULL,
    "advertiserId" TEXT NOT NULL,
    "ngay" TIMESTAMP(3) NOT NULL,
    "bcId" TEXT NOT NULL,
    "grantExVat" INTEGER NOT NULL,
    "cashExVat" INTEGER NOT NULL,
    "amountExVat" INTEGER NOT NULL,
    "grantGomVat" INTEGER NOT NULL,
    "raw" JSONB,
    "syncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TiktokAdsTinDung_pkey" PRIMARY KEY ("id")
);

-- Tiền theo nghĩa CHI PHÍ (= −giá trị API; endpoint báo chi phí bằng số ÂM). Dòng ÂM = TikTok hoàn/điều chỉnh —
-- hợp lệ, nên CỐ Ý KHÔNG có CHECK ≥ 0. P&L cộng theo ngày rồi kẹp [0, ads TikTok ngày đó] ⇒ số âm không bao giờ
-- thành chi phí ảo.

-- CreateIndex
CREATE INDEX "RawTiktokBusinessCost_shopId_externalId_fetchedAt_idx" ON "RawTiktokBusinessCost"("shopId", "externalId", "fetchedAt");

-- CreateIndex
CREATE INDEX "RawTiktokBusinessCost_fetchedAt_idx" ON "RawTiktokBusinessCost"("fetchedAt");

-- CreateIndex
CREATE UNIQUE INDEX "RawTiktokBusinessCost_shopId_externalId_payloadHash_key" ON "RawTiktokBusinessCost"("shopId", "externalId", "payloadHash");

-- CreateIndex
CREATE UNIQUE INDEX "TiktokAdsTinDung_advertiserId_ngay_key" ON "TiktokAdsTinDung"("advertiserId", "ngay");

-- CreateIndex
CREATE INDEX "TiktokAdsTinDung_ngay_idx" ON "TiktokAdsTinDung"("ngay");

-- CreateIndex
CREATE INDEX "TiktokAdsTinDung_bcId_ngay_idx" ON "TiktokAdsTinDung"("bcId", "ngay");
