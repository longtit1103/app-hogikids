-- Silver hoá đơn quảng cáo TikTok (Business Center): dựng từ Bronze "RawTiktokBusinessInvoice", MỌI loại giao
-- dịch, khoá "transactionId" (chuỗi nguyên, có dạng ghép "A|B"). Là dòng tiền ĐỐI CHIẾU / nghĩa vụ — dư nợ thẻ
-- tín dụng đọc nó; KHÔNG vào P&L, KHÔNG vào quỹ.
--
-- CHỈ THÊM một bảng mới — không đụng dòng nào đang có ⇒ migrate deploy prod KHÔNG cần tiền kiểm. Bảng rỗng tới
-- khi chạy `scripts/rebuild-tiktok-ads-hoa-don.ts` (lượt kéo đêm sau đó tự dựng phần mới theo từng trang).
-- Rollback = ảnh cũ + bảng thừa vô hại.

-- CreateTable
CREATE TABLE "TiktokAdsHoaDon" (
    "id" TEXT NOT NULL,
    "transactionId" TEXT NOT NULL,
    "bcId" TEXT NOT NULL,
    "advertiserId" TEXT,
    "invoiceId" TEXT,
    "createTime" TIMESTAMP(3) NOT NULL,
    "amount" INTEGER NOT NULL,
    "subtotal" INTEGER,
    "taxAmount" INTEGER,
    "transactionType" TEXT NOT NULL,
    "billingType" TEXT NOT NULL,
    "amountType" TEXT NOT NULL,
    "paymentPortfolioId" TEXT,
    "raw" JSONB,
    "syncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TiktokAdsHoaDon_pkey" PRIMARY KEY ("id")
);

-- Tiền KHÔNG dấu, chiều tiền nằm DUY NHẤT ở "amountType": dư nợ thẻ cộng/trừ theo cột đó, một dòng âm lọt vào
-- là đảo dấu hai lần. Mapping đã từ chối hai ca này; CHECK là lưới cuối cho mọi đường ghi khác.
ALTER TABLE "TiktokAdsHoaDon" ADD CONSTRAINT "TiktokAdsHoaDon_tien_khong_am" CHECK ("amount" >= 0);
ALTER TABLE "TiktokAdsHoaDon" ADD CONSTRAINT "TiktokAdsHoaDon_chieu_tien" CHECK ("amountType" IN ('POSITIVE', 'NEGATIVE'));

-- CreateIndex
CREATE UNIQUE INDEX "TiktokAdsHoaDon_transactionId_key" ON "TiktokAdsHoaDon"("transactionId");

-- CreateIndex
CREATE INDEX "TiktokAdsHoaDon_createTime_idx" ON "TiktokAdsHoaDon"("createTime");

-- CreateIndex
CREATE INDEX "TiktokAdsHoaDon_advertiserId_createTime_idx" ON "TiktokAdsHoaDon"("advertiserId", "createTime");
