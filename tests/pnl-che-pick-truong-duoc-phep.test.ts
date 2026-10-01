import { describe, expect, it } from "vitest";

import type { ChannelPnl, PnlBreakdown } from "@/lib/reports/pnl";
import { calcPnlCore } from "@/lib/reports/pnl";
import { boChannelPnlTheoQuyen, boPnlTheoQuyen, chePnl, cheChannelPnl, cheDailySeries, coLaiKenh } from "@/lib/reports/pnl-che";

/**
 * DTO che dựng theo DANH SÁCH TRƯỜNG ĐƯỢC PHÉP (spec phân quyền §4.1): trường mới thêm vào
 * `PnlBreakdown`/`ChannelPnl` mặc định KHÔNG lọt ra. Đột biến "spread rồi xoá" (`const { cogs, …rest }
 * = b; return rest`) làm ca "trường lạ" dưới đây đỏ.
 */

const B: PnlBreakdown = calcPnlCore(
  [
    {
      status: "COMPLETED",
      channelId: "shopee",
      itemsTotal: 500_000,
      discount: 10_000,
      platformFeeEst: 50_000,
      items: [{ sku: "X", quantity: 2, costPrice: 7331117 }],
    },
  ],
  [],
);

describe("chePnl — pick trường được phép", () => {
  it("đúng 7 trường không nhạy cảm, giữ nguyên giá trị", () => {
    const che = chePnl(B);
    expect(Object.keys(che).sort()).toEqual(
      ["ads", "netRevenue", "orderCount", "platformFee", "returnBomOrderCount", "revenue", "voucher"].sort(),
    );
    expect(che.revenue).toBe(B.revenue);
    expect(che.netRevenue).toBe(B.netRevenue);
    expect(JSON.stringify(che)).not.toContain("7331117");
  });

  it("trường LẠ thêm vào PnlBreakdown (mô phỏng field mới) không lọt ra", () => {
    const coTruongMoi = { ...B, loiNhuanMoi: 123, cogsTheoKenh: { shopee: 1 } } as PnlBreakdown;
    const che = chePnl(coTruongMoi);
    expect(che).not.toHaveProperty("loiNhuanMoi");
    expect(che).not.toHaveProperty("cogsTheoKenh");
    expect(che).not.toHaveProperty("cogs");
    expect(che).not.toHaveProperty("netProfit");
  });
});

describe("cheChannelPnl / cheDailySeries / coLaiKenh", () => {
  const kenh: ChannelPnl = {
    channelId: "shopee",
    name: "Shopee",
    color: "#000",
    isActive: true,
    revenue: 1,
    orderCount: 1,
    aov: 1,
    ads: 0,
    platformFee: 0,
    returnBomOrderCount: 0,
    returnBomRatePct: null,
    netProfit: 7331117,
    roas: null,
    marginPct: 12,
  };

  it("kênh che không lãi ròng/biên, kể cả trường lạ", () => {
    const [che] = cheChannelPnl([{ ...kenh, laiGopMoi: 5 } as ChannelPnl]);
    expect(che).not.toHaveProperty("netProfit");
    expect(che).not.toHaveProperty("marginPct");
    expect(che).not.toHaveProperty("laiGopMoi");
    expect(coLaiKenh(che)).toBe(false);
    expect(coLaiKenh(kenh)).toBe(true);
  });

  it("chuỗi ngày che chỉ date + revenue", () => {
    const [p] = cheDailySeries([{ date: "2026-10-01", revenue: 1, netProfit: 7331117 }]);
    expect(p).toEqual({ date: "2026-10-01", revenue: 1 });
  });
});

describe("boPnlTheoQuyen / boChannelPnlTheoQuyen — một chỗ rẽ nhánh che cho page nhiều kỳ", () => {
  const kenh = {
    channelId: "shopee",
    name: "Shopee",
    color: "#000",
    isActive: true,
    revenue: 1,
    orderCount: 1,
    aov: 1,
    ads: 0,
    platformFee: 0,
    returnBomOrderCount: 0,
    returnBomRatePct: null,
    netProfit: 7331117,
    roas: null,
    marginPct: 12,
  } satisfies ChannelPnl;

  it("thiếu giá vốn ⇒ MỌI kỳ qua chePnl (không COGS/LN ở kỳ nào), giữ đúng khoá kỳ", () => {
    const ra = boPnlTheoQuyen({ today: B, thisMonth: B, lastMonthSameDays: B }, { coQuyenGiaVon: false });
    expect(ra.coQuyenGiaVon).toBe(false);
    expect(Object.keys(ra).sort()).toEqual(["coQuyenGiaVon", "lastMonthSameDays", "thisMonth", "today"]);
    expect(ra.today).toEqual(chePnl(B));
    expect(JSON.stringify(ra)).not.toContain("7331117");
    expect(JSON.stringify(ra)).not.toMatch(/cogs|netProfit|grossProfit/);
  });

  it("đủ giá vốn ⇒ trả nguyên bản đầy đủ", () => {
    const ra = boPnlTheoQuyen({ current: B, previous: B }, { coQuyenGiaVon: true });
    expect(ra).toEqual({ coQuyenGiaVon: true, current: B, previous: B });
  });

  it("bộ kênh: thiếu giá vốn ⇒ mọi danh sách qua cheChannelPnl; đủ ⇒ nguyên", () => {
    const che = boChannelPnlTheoQuyen({ channels: [kenh], prevChannels: [kenh] }, { coQuyenGiaVon: false });
    expect(JSON.stringify(che)).not.toMatch(/7331117|netProfit|marginPct/);
    expect(che.channels).toEqual(cheChannelPnl([kenh]));
    const day = boChannelPnlTheoQuyen({ channels: [kenh], prevChannels: [] }, { coQuyenGiaVon: true });
    expect(day).toEqual({ coQuyenGiaVon: true, channels: [kenh], prevChannels: [] });
  });
});
