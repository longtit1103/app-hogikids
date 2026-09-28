"use client";

import { useState } from "react";
import { format, parse } from "date-fns";
import { Bar, CartesianGrid, ComposedChart, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

import { formatVnd, formatVndShort } from "@/lib/format";
import type { DailyPoint } from "@/lib/reports/daily-series";
import { cn } from "@/lib/utils";

/**
 * Combo chart doanh thu (cột) + LN ròng (đường) theo range toàn cục. Mirror
 * pattern Recharts của `expense-structure-chart.tsx`: màu SVG `fill`/`stroke`
 * dùng HEX trực tiếp (không `var(--token)`) — CSS custom property không đảm
 * bảo resolve nhất quán khi gán qua attribute SVG trên mọi trình duyệt.
 */
const REVENUE_COLOR = "#cc785c"; // --primary
const PROFIT_COLOR = "#141413"; // --ink

type SeriesKey = "revenue" | "netProfit";

function otherKey(key: SeriesKey): SeriesKey {
  return key === "revenue" ? "netProfit" : "revenue";
}

function dayLabel(dateStr: string): string {
  return format(parse(dateStr, "yyyy-MM-dd", new Date()), "dd/MM");
}

function fullDayLabel(dateStr: string): string {
  return format(parse(dateStr, "yyyy-MM-dd", new Date()), "dd/MM/yyyy");
}

function LegendToggle({
  label,
  color,
  hidden,
  disabled,
  onClick,
}: {
  label: string;
  color: string;
  hidden: boolean;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-pressed={!hidden}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border border-hairline px-2.5 py-1 text-xs transition-colors",
        hidden ? "text-muted-foreground" : "text-ink",
        disabled ? "cursor-not-allowed opacity-50" : "hover:bg-surface-soft"
      )}
    >
      <span className="size-2 rounded-full" style={{ backgroundColor: hidden ? "#a9a49a" : color }} />
      {label}
    </button>
  );
}

export function RevenueProfitChart({ points }: { points: DailyPoint[] }) {
  const [hidden, setHidden] = useState<Set<SeriesKey>>(new Set());
  // Kỳ 1 ngày → không đủ 2 điểm để vẽ đường có ý nghĩa, hiển thị LN ròng cũng
  // dạng cột (thay vì Line) — khớp design spec "chart chỉ có 1 điểm → cột".
  const singleDay = points.length <= 1;

  function toggleSeries(key: SeriesKey) {
    setHidden((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        if (next.has(otherKey(key))) return prev; // không cho tắt cả 2 series
        next.add(key);
      }
      return next;
    });
  }

  const showRevenue = !hidden.has("revenue");
  const showProfit = !hidden.has("netProfit");

  return (
    <div className="rounded-xl border border-hairline bg-canvas p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-serif text-lg text-ink">Doanh thu &amp; lợi nhuận theo ngày</h3>
        <div className="flex gap-2">
          <LegendToggle
            label="Doanh thu"
            color={REVENUE_COLOR}
            hidden={hidden.has("revenue")}
            disabled={!showRevenue && hidden.has("netProfit")}
            onClick={() => toggleSeries("revenue")}
          />
          <LegendToggle
            label="LN ròng"
            color={PROFIT_COLOR}
            hidden={hidden.has("netProfit")}
            disabled={!showProfit && hidden.has("revenue")}
            onClick={() => toggleSeries("netProfit")}
          />
        </div>
      </div>

      <div className="mt-4 h-72 w-full">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={points} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#e6dfd8" vertical={false} />
            <XAxis
              dataKey="date"
              tickFormatter={(v) => dayLabel(String(v))}
              tick={{ fontSize: 12 }}
              axisLine={false}
              tickLine={false}
            />
            <YAxis
              tickFormatter={(v) => formatVndShort(Number(v))}
              tick={{ fontSize: 12 }}
              axisLine={false}
              tickLine={false}
              width={64}
            />
            <Tooltip
              labelFormatter={(label) => fullDayLabel(String(label))}
              formatter={(value, name) => [formatVnd(Number(value)), name]}
              contentStyle={{
                borderRadius: 8,
                border: "1px solid #e6dfd8",
                backgroundColor: "#faf9f5",
                fontSize: 12,
              }}
            />
            {showRevenue && (
              <Bar dataKey="revenue" name="Doanh thu" fill={REVENUE_COLOR} fillOpacity={0.6} radius={[4, 4, 0, 0]} />
            )}
            {showProfit &&
              (singleDay ? (
                <Bar dataKey="netProfit" name="LN ròng" fill={PROFIT_COLOR} radius={[4, 4, 0, 0]} />
              ) : (
                <Line
                  type="monotone"
                  dataKey="netProfit"
                  name="LN ròng"
                  stroke={PROFIT_COLOR}
                  strokeWidth={2}
                  dot={false}
                />
              ))}
          </ComposedChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
