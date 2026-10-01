import { endOfMonth, format, startOfMonth, subMonths } from "date-fns";

import type { KetQuaChe, QuyenGiaVon } from "@/lib/queries/che-gia-von-types";
import { calcPnl } from "@/lib/reports/pnl";
import { pnlPercentBase } from "@/lib/reports/pnl-percent-base";

/**
 * Xu hướng P&L theo THÁNG cho biểu đồ Báo cáo (6 hoặc 12 tháng gần nhất, kết
 * thúc bằng THÁNG HIỆN TẠI). Gọi `calcPnl` 1 lần/tháng — chấp nhận với Postgres
 * 1 user. Mỗi tháng = 1 range [đầu tháng → cuối tháng] neo giờ VN.
 */

/** Dòng tháng KHÔNG lãi/biên — danh sách trường được phép (pick). */
export interface MonthlyTrendRowChe {
  month: string /* yyyy-MM */;
  revenue: number;
  netRevenue: number;
  orderCount: number;
  returnBomRatePct: number;
}

export interface MonthlyTrendRow extends MonthlyTrendRowChe {
  netProfit: number;
  /** Thu nhập tài chính của tháng — để cột Biên ròng nói được "số này có gồm khoản nào". */
  financialIncome: number;
  marginPct: number | null;
}

export type MonthlyTrend = KetQuaChe<{ rows: MonthlyTrendRow[] }, { rows: MonthlyTrendRowChe[] }>;

/**
 * Thiếu `gia-von-loi-nhuan:xem`: `calcPnl` VẪN tính đủ (ngoại lệ chốt 30/09, spec phân quyền §4.1 —
 * không tách công thức khỏi `pnl.ts`), rồi chiếu sang DTO chỉ-pick TRƯỚC khi trả — không lãi ròng,
 * biên, thu nhập tài chính.
 */
export async function computeMonthlyTrend(months: 6 | 12, quyen: QuyenGiaVon): Promise<MonthlyTrend> {
  const now = new Date();

  // Cũ → mới: tháng i lùi (months-1-i) tháng so với tháng hiện tại.
  const monthStarts = Array.from({ length: months }, (_, i) => startOfMonth(subMonths(now, months - 1 - i)));

  const rows: MonthlyTrendRow[] = await Promise.all(
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

  if (quyen.coQuyenGiaVon) return { coQuyenGiaVon: true, rows };
  return {
    coQuyenGiaVon: false,
    rows: rows.map((r) => ({
      month: r.month,
      revenue: r.revenue,
      netRevenue: r.netRevenue,
      orderCount: r.orderCount,
      returnBomRatePct: r.returnBomRatePct,
    })),
  };
}
