import { describe, expect, it } from "vitest";

import { buildTrendSheetRows } from "@/components/bao-cao/trend-tab";
import type { MonthlyTrendRow } from "@/lib/reports/monthly-trend";

/**
 * Sheet Xu hướng đi RA NGOÀI app: không có tooltip, không có dấu * để rê chuột. Thiếu cột này thì
 * người nhận thấy LN ròng và biên ròng của tháng đáo hạn sổ nhảy vọt mà không có gì giải thích.
 */
const THANG: MonthlyTrendRow = {
  month: "2026-06",
  revenue: 50_000_000,
  netRevenue: 40_000_000,
  netProfit: 12_000_000,
  financialIncome: 2_000_000,
  marginPct: 24,
  orderCount: 120,
  returnBomRatePct: 3.2,
};

describe("buildTrendSheetRows — cột Thu nhập tài chính", () => {
  it("xuất thành cột riêng, đứng cạnh LN ròng", () => {
    const [row] = buildTrendSheetRows([THANG]);
    expect(row["Thu nhập tài chính"]).toBe(2_000_000);
    expect(row["LN ròng"]).toBe(12_000_000);
  });

  it("tháng không có thì cột bằng 0, KHÔNG bỏ cột (mọi tháng cùng số cột)", () => {
    const [row] = buildTrendSheetRows([{ ...THANG, financialIncome: 0 }]);
    expect(row["Thu nhập tài chính"]).toBe(0);
  });
});
