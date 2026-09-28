-- Hộp thư THÔ hứng webhook Pancake POS: chỉ lưu, không transform, không dựng Silver.
-- `payload` là TEXT (không phải JSONB) để giữ đúng từng byte Pancake gửi — id int64 an toàn
-- tuyệt đối và không bị chuẩn hoá thứ tự khoá/khoảng trắng. Truy vấn thì cast tại chỗ:
-- `payload::jsonb->>'type'`.

-- CreateTable
CREATE TABLE "RawPancakeWebhookEvent" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "payload" TEXT NOT NULL,
    "payloadHash" TEXT NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "source" TEXT NOT NULL DEFAULT 'webhook',

    CONSTRAINT "RawPancakeWebhookEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RawPancakeWebhookEvent_shopId_receivedAt_idx" ON "RawPancakeWebhookEvent"("shopId", "receivedAt");

-- CreateIndex
CREATE INDEX "RawPancakeWebhookEvent_receivedAt_idx" ON "RawPancakeWebhookEvent"("receivedAt");

-- CreateIndex
-- Khoá idempotent cho NẠP BÙ (chạy lại script không nhân bản). Sự kiện live luôn có
-- `receivedAt` mới nên hai lần Pancake bắn trùng payload vẫn giữ đủ cả hai dòng.
CREATE UNIQUE INDEX "RawPancakeWebhookEvent_shopId_receivedAt_payloadHash_key" ON "RawPancakeWebhookEvent"("shopId", "receivedAt", "payloadHash");
