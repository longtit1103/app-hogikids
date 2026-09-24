-- Kênh "Bán trực tiếp" (đơn lên từ màn Bán hàng Pancake, khách trả tại shop) — 23/09.
-- CHỈ THÊM: một cột mặc định 0 + một dòng kênh. Không sửa/xoá gì đang có ⇒ lùi ảnh là đủ (cột + kênh
-- thừa vô hại). Seed chỉ chạy lần đầu dựng máy nên kênh mới PHẢI đi bằng migration.

-- AlterTable
ALTER TABLE "Order" ADD COLUMN "paidAtShop" INTEGER NOT NULL DEFAULT 0;

-- Kênh mới — ON CONFLICT để máy đã có (seed lại / chạy lại) không vỡ.
INSERT INTO "Channel" ("id", "name", "color", "isActive", "platformFeePct", "paymentFeePct", "sortOrder")
VALUES ('direct', 'Bán trực tiếp', '#6a8fd8', true, 0, 0, 5)
ON CONFLICT ("id") DO NOTHING;
