/**
 * NGUỒN CHUẨN DUY NHẤT cho câu hỏi "kênh nào có phí sàn THẬT".
 *
 * Shopee & TikTok trả phí sàn thật qua Pancake (`fee_marketplace`) — đây là
 * bất biến #1 của app ("Phí sàn lấy số THẬT Pancake, KHÔNG ước tính %"). Mọi
 * kênh khác (Facebook, Website) chưa có phí thật nên dùng % dự phòng
 * (platformFeePct + paymentFeePct).
 *
 * Cả hai nơi phải import từ đây, KHÔNG nhân bản Set:
 *  - ingest mapping (`pancake-mapping.ts`): chọn số thật vs ước tính khi tạo đơn;
 *  - action "Tính lại phí kỳ này" (`settings-channels.ts`): LOẠI đơn marketplace khỏi
 *    recompute để không ghi đè phí thật bằng ước tính (không hoàn tác được).
 */
export const REAL_FEE_CHANNELS: ReadonlySet<string> = new Set(["shopee", "tiktok"]);

/** true nếu kênh lấy phí sàn THẬT từ Pancake (không dùng % ước tính). */
export function usesRealPlatformFee(channelId: string): boolean {
  return REAL_FEE_CHANNELS.has(channelId);
}
