import { describe, expect, it } from "vitest";

import { ingestAdsBodySchema } from "@/lib/ingest/ads-schema";

/**
 * Unit test THUẦN (không DB) khoá HỢP ĐỒNG body /api/ingest/ads:
 * spendExVat là số nguyên đồng >= 0, vatRate 0..1 BẮT BUỘC. App nhân VAT, không phải n8n.
 */
describe("ingestAdsBodySchema", () => {
  const row = (extra: Record<string, unknown>) => ({
    source: "META",
    rows: [{ date: "2026-07-01", campaignId: "C1", spendExVat: 130000, vatRate: 0.1, ...extra }],
  });

  it("row hợp lệ → parse ra đúng kiểu số, campaignName mặc định rỗng", () => {
    const parsed = ingestAdsBodySchema.parse(row({}));
    expect(parsed.rows[0].spendExVat).toBe(130000);
    expect(parsed.rows[0].vatRate).toBe(0.1);
    expect(parsed.rows[0].campaignName).toBe("");
  });

  it("spendExVat lẻ (không nguyên) → reject", () => {
    expect(ingestAdsBodySchema.safeParse(row({ spendExVat: 130000.5 })).success).toBe(false);
  });

  it("spendExVat âm → reject", () => {
    expect(ingestAdsBodySchema.safeParse(row({ spendExVat: -1 })).success).toBe(false);
  });

  it("vatRate > 1 → reject", () => {
    expect(ingestAdsBodySchema.safeParse(row({ vatRate: 1.5 })).success).toBe(false);
  });

  it("vatRate âm → reject", () => {
    expect(ingestAdsBodySchema.safeParse(row({ vatRate: -0.1 })).success).toBe(false);
  });

  it("thiếu vatRate → reject (không mặc định 0)", () => {
    const bad = { source: "META", rows: [{ date: "2026-07-01", campaignId: "C1", spendExVat: 130000 }] };
    expect(ingestAdsBodySchema.safeParse(bad).success).toBe(false);
  });

  it("adType 'auction' / 'gmv_max' → parse giữ nguyên giá trị", () => {
    expect(ingestAdsBodySchema.parse(row({ adType: "auction" })).rows[0].adType).toBe("auction");
    expect(ingestAdsBodySchema.parse(row({ adType: "gmv_max" })).rows[0].adType).toBe("gmv_max");
  });

  it("adType vắng → undefined (backward-compat: hành vi GMV Max/bare, refId cũ giữ khoá trần)", () => {
    expect(ingestAdsBodySchema.parse(row({})).rows[0].adType).toBeUndefined();
  });

  it("adType lạ → reject", () => {
    expect(ingestAdsBodySchema.safeParse(row({ adType: "banner" })).success).toBe(false);
  });

  it("quá 2000 dòng → reject", () => {
    const many = {
      source: "TIKTOK_ADS",
      rows: Array.from({ length: 2001 }, (_, i) => ({
        date: "2026-07-01",
        campaignId: `C${i}`,
        spendExVat: 1000,
        vatRate: 0.1,
      })),
    };
    expect(ingestAdsBodySchema.safeParse(many).success).toBe(false);
  });
});
