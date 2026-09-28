"use client";

import { useState } from "react";
import { Bar, CartesianGrid, ComposedChart, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

import { formatVnd, formatVndShort } from "@/lib/format";
import type { MonthlyTrendRow } from "@/lib/reports/monthly-trend";
import { formatPct1, monthLabel } from "@/lib/reports/trend-format";
import { cn } from "@/lib/utils";

// Màu SVG dùng HEX trực tiếp (không var(--token)) — cùng lý do đã ghi ở
// revenue-profit-chart.tsx: fill/stroke SVG là attribute, CSS custom property
// không đảm bảo resolve nhất quán trên mọi trình duyệt.
const REVENUE_COLOR = "#cc785c"; // --primary
const PROFIT_COLOR = "#141413"; // --ink
const RETURN_BOM_COLOR = "#c64545"; // --error

type SeriesKey = "revenue" | "netProfit" | "returnBomRatePct";
const SERIES: { key: SeriesKey; label: string; color: string }[] = [
  { key: "revenue", label: "Doanh thu", color: REVENUE_COLOR },
  { key: "netProfit", label: "LN ròng", color: PROFIT_COLOR },
  { key: "returnBomRatePct", label: "Tỷ lệ hoàn/bom", color: RETURN_BOM_COLOR },
];

/**
 * Bar doanh thu + Line LN ròng (trục trái, VND) + Line tỷ lệ hoàn/bom (trục
 * phải, %, nét đứt) + legend tự toggle từng series — tách khỏi `trend-tab.tsx`
 * (>200 dòng nếu gộp cả bảng — quy ước modularize). Tự quản lý state ẩn/hiện
 * series (không component cha nào khác cần biết trạng thái này).
 */
export function TrendChart({ rows }: { rows: MonthlyTrendRow[] }) {
  const [hidden, setHidden] = useState<Set<SeriesKey>>(new Set());

  function toggleSeries(key: SeriesKey) {
    setHidden((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        // Không cho tắt hết — giữ tối thiểu 1 series hiển thị.
        if (SERIES.every((s) => s.key === key || next.has(s.key))) return prev;
        next.add(key);
      }
      return next;
    });
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap gap-2 print:hidden">
        {SERIES.map((s) => (
          <button
            key={s.key}
            type="button"
            onClick={() => toggleSeries(s.key)}
            aria-pressed={!hidden.has(s.key)}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-full border border-hairline px-2.5 py-1 text-xs transition-colors",
              hidden.has(s.key) ? "text-muted-foreground" : "text-ink",
              "hover:bg-surface-soft"
            )}
          >
            <span className="size-2 rounded-full" style={{ backgroundColor: hidden.has(s.key) ? "#a9a49a" : s.color }} />
            {s.label}
          </button>
        ))}
      </div>

      <div className="h-72 w-full rounded-xl border border-hairline bg-canvas p-4">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={rows} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#e6dfd8" vertical={false} />
            <XAxis dataKey="month" tickFormatter={monthLabel} tick={{ fontSize: 12 }} axisLine={false} tickLine={false} />
            <YAxis
              yAxisId="left"
              tickFormatter={(v) => formatVndShort(Number(v))}
              tick={{ fontSize: 12 }}
              axisLine={false}
              tickLine={false}
              width={64}
            />
            <YAxis
              yAxisId="right"
              orientation="right"
              tickFormatter={(v) => `${v}%`}
              tick={{ fontSize: 12 }}
              axisLine={false}
              tickLine={false}
              width={40}
            />
            <Tooltip
              labelFormatter={(label) => `Tháng ${monthLabel(String(label))}`}
              formatter={(value, name) => [
                name === "Tỷ lệ hoàn/bom" ? formatPct1(Number(value)) : formatVnd(Number(value)),
                name,
              ]}
              contentStyle={{ borderRadius: 8, border: "1px solid #e6dfd8", backgroundColor: "#faf9f5", fontSize: 12 }}
            />
            {!hidden.has("revenue") && (
              <Bar yAxisId="left" dataKey="revenue" name="Doanh thu" fill={REVENUE_COLOR} fillOpacity={0.6} radius={[4, 4, 0, 0]} />
            )}
            {!hidden.has("netProfit") && (
              <Line yAxisId="left" type="monotone" dataKey="netProfit" name="LN ròng" stroke={PROFIT_COLOR} strokeWidth={2} dot={false} />
            )}
            {!hidden.has("returnBomRatePct") && (
              <Line
                yAxisId="right"
                type="monotone"
                dataKey="returnBomRatePct"
                name="Tỷ lệ hoàn/bom"
                stroke={RETURN_BOM_COLOR}
                strokeWidth={2}
                strokeDasharray="4 3"
                dot={false}
              />
            )}
          </ComposedChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
