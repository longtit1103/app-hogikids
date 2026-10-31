-- Trạng thái BỀN của từng Business Center TikTok với lượt kéo hoá đơn, cho cổng chốt sao kê thẻ (D+2). Ba luật cần
-- sống qua cửa sổ D − 30 của SyncLog và qua việc dọn SyncLog:
--  1. BC đã từng đọc được hoá đơn ("lanCuoiDocDuoc", hoặc có hoá đơn trong kho thô) nay mất quyền finance / biến mất
--     ⇒ CHẶN — trước đây quá 30 ngày thì BC rơi khỏi tập xét và cổng mở;
--  2. BC chủ shop xác nhận "không dùng thẻ" ("khongDung*") ⇒ bỏ khỏi tập xét; BC thiếu quyền chưa xác nhận ⇒ CHẶN;
--  3. Có ít nhất một dòng mang "lanDauCoDau" ⇒ chế độ dấu lượt toàn cục, không quay về luật cũ.
--
-- CHỈ THÊM một bảng mới rỗng + CHECK trên chính bảng đó. KHÔNG backfill: BC đã có hoá đơn được cổng hợp thẳng từ kho
-- thô "RawTiktokBusinessInvoice" (không bị dọn), "lanDauCoDau" tự ghi ở dấu lượt kế tiếp. Ảnh cũ (đường lùi) không
-- biết bảng này ⇒ chạy được trên schema mới. Quỹ, P&L, dư nợ không đọc bảng này.

-- CreateTable
CREATE TABLE "TiktokBcHoaDon" (
    "bcId" TEXT NOT NULL,
    "lanDauCoDau" TIMESTAMP(3),
    "lanCuoiDocDuoc" TIMESTAMP(3),
    "khongDungTu" TIMESTAMP(3),
    "khongDungGhiChu" TEXT,
    "khongDungBoi" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TiktokBcHoaDon_pkey" PRIMARY KEY ("bcId")
);

-- bc_id cùng khuôn route dấu lượt / kho thô (chuỗi số) — dòng rác không bao giờ thành "BC từng đọc được".
ALTER TABLE "TiktokBcHoaDon" ADD CONSTRAINT "TiktokBcHoaDon_bc_id_khuon" CHECK ("bcId" ~ '^[0-9]{6,32}$');

-- Xác nhận "không dùng thẻ" đi trọn bộ: có mốc thì có người xác nhận; bỏ đánh dấu xoá cả ba cột.
ALTER TABLE "TiktokBcHoaDon" ADD CONSTRAINT "TiktokBcHoaDon_khong_dung_tron_bo" CHECK (
    ("khongDungTu" IS NULL AND "khongDungBoi" IS NULL AND "khongDungGhiChu" IS NULL)
    OR ("khongDungTu" IS NOT NULL AND "khongDungBoi" IS NOT NULL)
);
