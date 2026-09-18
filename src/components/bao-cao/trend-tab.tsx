"use client";

import { useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { endOfMonth, parse, startOfMonth } from "date-fns";

import { TrendChart } from "@/components/bao-cao/trend-chart";
import { useDateRange } from "@/components/shell/date-range-provider";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { normalizeCustomRange, serializeDateRange } from "@/lib/date-range";
import { formatVnd } from "@/lib/format";
import { chuThichBienRongCoThuNhap } from "@/lib/reports/chu-thich-thu-nhap-tai-chinh";
import type { MonthlyTrendRow } from "@/lib/reports/monthly-trend";
import { formatPct1, monthLabel } from "@/lib/reports/trend-format";

/** Δ LN ròng so dòng tháng trước (theo %) — dòng đầu tiên trong cửa sổ hiện luôn "—". */
function netProfitDelta(current: MonthlyTrendRow, prev: MonthlyTrendRow | undefined): React.ReactNode {
  if (!prev) return <span className="text-muted-foreground">—</span>;
  if (prev.netProfit === 0) {
    return current.netProfit === 0 ? (
      <span className="text-muted-foreground">—</span>
    ) : (
      <span className="text-ink">Mới</span>
    );
  }
  const pct = ((current.netProfit - prev.netProfit) / Math.abs(prev.netProfit)) * 100;
  if (pct === 0) return <span className="text-muted-foreground">0%</span>;
  const up = pct > 0;
  return (
    <span className={up ? "text-success" : "text-error"}>
      {up ? "▲" : "▼"} {formatPct1(Math.abs(pct))}
    </span>
  );
}

/**
 * Tab Xu hướng — dropdown 6/12 tháng là CỬA SỔ RIÊNG của tab này (state
 * client thuần, KHÔNG đụng range toàn cục). `rows` luôn nhận đủ 12 tháng từ
 * `computeMonthlyTrend(12)` ở page.tsx (server) — chọn "6 tháng" chỉ cắt
 * `slice(-6)` phía client, KHÔNG gọi lại server (12 tháng luôn chứa trọn 6
 * tháng gần nhất vì cùng kết thúc ở tháng hiện tại). Chart tách sang
 * `trend-chart.tsx` — file này chỉ giữ cửa sổ 6/12, bảng, và điều hướng click
 * dòng tháng.
 */
export function TrendTab({ rows }: { rows: MonthlyTrendRow[] }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { applyCustomRange } = useDateRange();

  const [windowSize, setWindowSize] = useState<6 | 12>(6);

  const displayRows = rows.slice(-windowSize);
  const monthsWithData = displayRows.filter((r) => r.orderCount > 0).length;
  const showTable = monthsWithData >= 2;
  // Có tháng nào gồm lãi tiết kiệm không — quyết định hiện chú thích dưới bảng.
  const coThuNhapTaiChinh = displayRows.some((r) => r.financialIncome > 0);

  function handleRowClick(monthStr: string) {
    const monthDate = parse(monthStr, "yyyy-MM", new Date());
    const monthRange = normalizeCustomRange({ from: startOfMonth(monthDate), to: endOfMonth(monthDate) });
    applyCustomRange(monthRange); // đồng bộ context toàn cục (P&L month-picker đọc từ đây)

    const { tu, den } = serializeDateRange(monthRange);
    // P&L đã dời sang hub Tài chính → click dòng tháng mở /tai-chinh?tab=loi-lo.
    const params = new URLSearchParams(searchParams);
    params.set("tab", "loi-lo");
    params.set("tu", tu);
    params.set("den", den);
    router.push(`/tai-chinh?${params.toString()}`);
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex justify-end print:hidden">
        <Select value={String(windowSize)} onValueChange={(v) => setWindowSize(v === "12" ? 12 : 6)}>
          <SelectTrigger className="w-32">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="6">6 tháng</SelectItem>
            <SelectItem value="12">12 tháng</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <TrendChart rows={displayRows} />

      {showTable ? (
        <>
        <div className="overflow-hidden rounded-xl border border-hairline">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Tháng</TableHead>
                <TableHead className="text-right">Doanh thu</TableHead>
                <TableHead className="text-right">DT thuần</TableHead>
                <TableHead className="text-right">LN ròng</TableHead>
                <TableHead className="text-right">Biên ròng %</TableHead>
                <TableHead className="text-right">Số đơn</TableHead>
                <TableHead className="text-right">Hoàn/bom %</TableHead>
                <TableHead className="text-right">Δ</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {displayRows.map((r, i) => (
                <TableRow
                  key={r.month}
                  onClick={() => handleRowClick(r.month)}
                  className="cursor-pointer"
                  title={`Xem P&L tháng ${monthLabel(r.month)}`}
                >
                  <TableCell>{monthLabel(r.month)}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatVnd(r.revenue)}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatVnd(r.netRevenue)}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatVnd(r.netProfit)}</TableCell>
                  <TableCell className="text-right tabular-nums text-muted-foreground">
                    {r.marginPct === null ? "—" : formatPct1(r.marginPct)}
                    {r.financialIncome > 0 && (
                      <span title={chuThichBienRongCoThuNhap(r.financialIncome) ?? ""}> *</span>
                    )}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{r.orderCount.toLocaleString("vi-VN")}</TableCell>
                  <TableCell className="text-right tabular-nums text-muted-foreground">
                    {formatPct1(r.returnBomRatePct)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{netProfitDelta(r, displayRows[i - 1])}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
        {coThuNhapTaiChinh && (
          <p className="mt-2 text-xs text-muted-foreground">
            * tháng có thu nhập tài chính (lãi sổ tiết kiệm) — LN ròng và biên ròng đã gồm khoản này,
            không phải lãi từ bán hàng.
          </p>
        )}
        </>
      ) : (
        <p className="py-6 text-center text-sm text-muted-foreground">Cần ít nhất 2 tháng dữ liệu</p>
      )}
    </div>
  );
}

/** Sheet Excel — luôn xuất đủ 12 tháng nhận từ page.tsx (nhiều hơn cửa sổ 6 tháng mặc định trên màn, không ít hơn). */
export function buildTrendSheetRows(rows: MonthlyTrendRow[]) {
  return rows.map((r) => ({
    Tháng: monthLabel(r.month),
    "Doanh thu": r.revenue,
    "DT thuần": r.netRevenue,
    "LN ròng": r.netProfit,
    "Thu nhập tài chính": r.financialIncome,
    "Biên ròng %": r.marginPct === null ? "" : Math.round(r.marginPct * 10) / 10,
    "Số đơn": r.orderCount,
    "Hoàn/bom %": Math.round(r.returnBomRatePct * 10) / 10,
  }));
}
