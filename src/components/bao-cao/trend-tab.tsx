"use client";

import { useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { endOfMonth, parse, startOfMonth } from "date-fns";

import { TrendChart } from "@/components/bao-cao/trend-chart";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { normalizeCustomRange, serializeDateRange } from "@/lib/date-range";
import { formatVnd } from "@/lib/format";
import { chuThichBienRongCoThuNhap } from "@/lib/reports/chu-thich-thu-nhap-tai-chinh";
import type { MonthlyTrend, MonthlyTrendRow } from "@/lib/reports/monthly-trend";
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
export function TrendTab({ trend }: { trend: MonthlyTrend }) {
  const router = useRouter();
  const searchParams = useSearchParams();

  const [windowSize, setWindowSize] = useState<6 | 12>(6);

  // Thiếu quyền giá vốn (nhánh che): không cột lãi/biên/Δ, không drill sang Lãi/Lỗ (tab đó đòi giá vốn).
  const coLai = trend.coQuyenGiaVon;
  const displayRows = trend.rows.slice(-windowSize);
  const rowsLai: MonthlyTrendRow[] | null = trend.coQuyenGiaVon ? trend.rows.slice(-windowSize) : null;
  const monthsWithData = displayRows.filter((r) => r.orderCount > 0).length;
  const showTable = monthsWithData >= 2;
  // Có tháng nào gồm lãi tiết kiệm không — quyết định hiện chú thích dưới bảng.
  const coThuNhapTaiChinh = rowsLai?.some((r) => r.financialIncome > 0) ?? false;

  function handleRowClick(monthStr: string) {
    const monthDate = parse(monthStr, "yyyy-MM", new Date());
    const monthRange = normalizeCustomRange({ from: startOfMonth(monthDate), to: endOfMonth(monthDate) });
    // Bấm dòng tháng là DRILL: chỉ mang tu/den trên URL — bộ chọn ngày toàn cục tự nhận khoảng này
    // từ URL để HIỂN THỊ (P&L month-picker đọc từ đó) và KHÔNG lưu sang phiên sau (hợp đồng 29/09).
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

      <TrendChart rows={displayRows} coLai={coLai} />

      {showTable ? (
        <>
        <div className="overflow-hidden rounded-xl border border-hairline">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Tháng</TableHead>
                <TableHead className="text-right">Doanh thu</TableHead>
                <TableHead className="text-right">DT thuần</TableHead>
                {coLai && <TableHead className="text-right">LN ròng</TableHead>}
                {coLai && <TableHead className="text-right">Biên ròng %</TableHead>}
                <TableHead className="text-right">Số đơn</TableHead>
                <TableHead className="text-right">Hoàn/bom %</TableHead>
                {coLai && <TableHead className="text-right">Δ</TableHead>}
              </TableRow>
            </TableHeader>
            <TableBody>
              {displayRows.map((r, i) => {
                const lai = rowsLai?.[i] ?? null;
                return (
                <TableRow
                  key={r.month}
                  onClick={coLai ? () => handleRowClick(r.month) : undefined}
                  className={coLai ? "cursor-pointer" : undefined}
                  title={coLai ? `Xem P&L tháng ${monthLabel(r.month)}` : undefined}
                >
                  <TableCell>{monthLabel(r.month)}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatVnd(r.revenue)}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatVnd(r.netRevenue)}</TableCell>
                  {lai && <TableCell className="text-right tabular-nums">{formatVnd(lai.netProfit)}</TableCell>}
                  {lai && (
                    <TableCell className="text-right tabular-nums text-muted-foreground">
                      {lai.marginPct === null ? "—" : formatPct1(lai.marginPct)}
                      {lai.financialIncome > 0 && (
                        <span title={chuThichBienRongCoThuNhap(lai.financialIncome) ?? ""}> *</span>
                      )}
                    </TableCell>
                  )}
                  <TableCell className="text-right tabular-nums">{r.orderCount.toLocaleString("vi-VN")}</TableCell>
                  <TableCell className="text-right tabular-nums text-muted-foreground">
                    {formatPct1(r.returnBomRatePct)}
                  </TableCell>
                  {lai && rowsLai && (
                    <TableCell className="text-right tabular-nums">{netProfitDelta(lai, rowsLai[i - 1])}</TableCell>
                  )}
                </TableRow>
                );
              })}
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
