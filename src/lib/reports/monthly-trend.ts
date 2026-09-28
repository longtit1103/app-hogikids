import { endOfMonth, format, startOfMonth, subMonths } from "date-fns";

import { calcPnl } from "@/lib/reports/pnl";
import { pnlPercentBase } from "@/lib/reports/pnl-percent-base";

/**
 * Xu hướng P&L theo THÁNG cho biểu đồ Báo cáo (6 hoặc 12 tháng gần nhất, kết
 * thúc bằng THÁNG HIỆN TẠI). Gọi `calcPnl` 1 lần/tháng — chấp nhận với Postgres
 * 1 user. Mỗi tháng = 1 range [đầu tháng → cuối tháng] neo giờ VN.
 */

export interface MonthlyTrendRow {
  month: string /* yyyy-MM */;
  revenue: number;
  netRevenue: number;
  netProfit: number;
  /** Thu nhập tài chính của tháng — để cột Biên ròng nói được "số này có gồm khoản nào". */
  financialIncome: number;
  marginPct: number | null;
  orderCount: number;
  returnBomRatePct: number;
}

export async function computeMonthlyTrend(months: 6 | 12): Promise<MonthlyTrendRow[]> {
  const now = new Date();

  // Cũ → mới: tháng i lùi (months-1-i) tháng so với tháng hiện tại.
  const monthStarts = Array.from({ length: months }, (_, i) => startOfMonth(subMonths(now, months - 1 - i)));

  return Promise.all(
    monthStarts.map(async (monthStart) => {
      const b = await calcPnl({ from: monthStart, to: endOfMonth(monthStart) });
      const returnDenom = b.orderCount + b.returnBomOrderCount;
      return {
        month: format(monthStart, "yyyy-MM"),
        revenue: b.revenue,
        netRevenue: b.netRevenue,
        netProfit: b.netProfit,
      financialIncome: b.financialIncome,
        marginPct: pnlPercentBase(b) ? (b.netProfit / pnlPercentBase(b)) * 100 : null,
        orderCount: b.orderCount,
        returnBomRatePct: returnDenom ? (b.returnBomOrderCount / returnDenom) * 100 : 0,
      };
    })
  );
}
