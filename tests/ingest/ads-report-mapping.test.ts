import { describe, expect, it } from "vitest";

import { mapTiktokAdsReport } from "@/lib/ingest/ads-report-mapping";

/**
 * Từ 25/08 node GMV Max xin thêm `gross_revenue` + `roi`. Payload giàu hơn ⇒ Bronze land bản MỚI cùng
 * khoá ⇒ đường "Dựng lại từ kho thô" sẽ đọc CHÍNH bản mới này để dựng `Expense`. Nếu mapping vô tình
 * đọc key mới thành chi tiêu thì sổ chi phí (và LN ròng) lệch âm thầm. Suite này khoá lời khai "chi tiêu
 * chỉ đến từ `cost` (GMV Max) hoặc `spend` (auction), key khác là nhiễu".
 */
const NGAY = "2026-08-20";

describe("mapTiktokAdsReport — payload giàu metric hơn", () => {
  it("GMV Max: thêm gross_revenue/roi/orders KHÔNG đổi spendExVat lẫn adType", () => {
    const truoc = mapTiktokAdsReport({
      dimensions: { campaign_id: "C1", stat_time_day: `${NGAY} 00:00:00` },
      metrics: { campaign_name: "TOÀN SHOP", cost: "75789" },
    });
    const sau = mapTiktokAdsReport({
      dimensions: { campaign_id: "C1", stat_time_day: `${NGAY} 00:00:00` },
      metrics: { campaign_name: "TOÀN SHOP", cost: "75789", orders: "1", gross_revenue: "219789.00", roi: "2.90" },
    });
    expect(truoc).toEqual({ ok: true, row: { date: NGAY, campaignId: "C1", campaignName: "TOÀN SHOP", spendExVat: 75789, adType: "gmv_max" } });
    expect(sau).toEqual(truoc);
  });

  it("auction giữ nguyên adType khi payload có key lạ", () => {
    const r = mapTiktokAdsReport({
      dimensions: { campaign_id: "C2", stat_time_day: `${NGAY} 00:00:00` },
      metrics: { campaign_name: "Auction", spend: "1000", key_moi_cua_san: "999999" },
    });
    expect(r).toEqual({ ok: true, row: { date: NGAY, campaignId: "C2", campaignName: "Auction", spendExVat: 1000, adType: "auction" } });
  });

  it("CÓ CẢ cost lẫn spend vẫn bị TỪ CHỐI (luật rời-nhau không được nới)", () => {
    const r = mapTiktokAdsReport({
      dimensions: { campaign_id: "C3", stat_time_day: `${NGAY} 00:00:00` },
      metrics: { cost: "10", spend: "10", gross_revenue: "100" },
    });
    expect(r.ok).toBe(false);
  });
});
