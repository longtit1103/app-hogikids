import { z } from "zod";

/**
 * Body POST /api/ingest/ads — CHỈ chi tiêu quảng cáo (Meta Ads spend + TikTok ad-account spend).
 * TUYỆT ĐỐI không kéo GMV/đơn TikTok Shop (double-count — doanh thu chỉ từ Pancake).
 *
 * HỢP ĐỒNG (chuyển phép nhân VAT từ n8n về app — app là biên tiền, TS + unit test):
 *  - spendExVat: chi tiêu CHƯA VAT, số nguyên đồng VND, >= 0.
 *  - vatRate: tỉ lệ thuế dạng thập phân (vd 0.1 = 10%), 0..1. BẮT BUỘC — thiếu ⇒ 400
 *    (KHÔNG mặc định 0: rơi về 0 im lặng sẽ ghi thiếu VAT, lãi đẹp lên âm thầm).
 * Route tự tính: amount = round(spendExVat × (1 + vatRate)).
 */
export const ingestAdsBodySchema = z.object({
  source: z.enum(["META", "TIKTOK_ADS"]),
  rows: z
    .array(
      z.object({
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        campaignId: z.string().min(1),
        campaignName: z.string().default(""),
        // z.number() THUẦN (không coerce): coerce ép null/""/false → 0 im lặng — đúng bẫy
        // "VAT/chi tiêu rơi về 0, lãi đẹp lên âm thầm". n8n gửi số JSON thật nên không vỡ.
        spendExVat: z.number().int().nonnegative(),
        vatRate: z.number().min(0).max(1),
        // Loại report TikTok Ads — cùng 1 campaign 1 ngày có thể xuất hiện ở CẢ auction
        // lẫn GMV Max (2 dòng chi tiêu KHÁC nhau) ⇒ route tách refId theo adType, mirror
        // khoá Bronze (streams.ts): auction mang infix "auction:", GMV Max giữ khoá TRẦN.
        // OPTIONAL vì backward-compat: vắng ⇒ coi như GMV Max/bare (Meta không có GMV Max,
        // refId prod cũ giữ nguyên khoá trần — không đẻ orphan/dup).
        adType: z.enum(["auction", "gmv_max"]).optional(),
      }),
    )
    .max(2000),
});

export type IngestAdsBody = z.infer<typeof ingestAdsBodySchema>;
