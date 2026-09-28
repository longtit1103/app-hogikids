"use client";

import { format, parse } from "date-fns";
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

import { formatRoas } from "@/components/kenh/channel-format";
import { formatVnd, formatVndShort } from "@/lib/format";
import { groupByWeek } from "@/lib/reports/group-by-week";

/**
 * Chart "Doanh thu vs Chi phí ads theo ngày" của `/kenh/:id` — 2 đường: Doanh
 * thu (màu nhận diện kênh) + Ads (`--accent-amber`, nét đứt). Ads dùng HEX
 * trực tiếp (không `var(--token)`), cùng lý do đã ghi ở `revenue-profit-chart.tsx`
 * (CSS custom property không đảm bảo resolve nhất quán qua thuộc tính SVG).
 * `points` từ `computeChannelRevenueAdsSeries` — > 90 ngày gộp tuần bằng
 * `groupByWeek` (group-by-week.ts), khớp `channel-trend-chart.tsx` (Task 6).
 */

const ADS_COLOR = "#e8a55a"; // --accent-amber
const WEEK_GROUP_THRESHOLD_DAYS = 90;

type Point = { date: string; revenue: number; ads: number };

function dayLabel(dateStr: string): string {
  return format(parse(dateStr, "yyyy-MM-dd", new Date()), "dd/MM");
}

function fullDayLabel(dateStr: string): string {
  return format(parse(dateStr, "yyyy-MM-dd", new Date()), "dd/MM/yyyy");
}

/** Props tối thiểu Recharts truyền vào `Tooltip content=` — xem ghi chú tương tự `channel-trend-tooltip.tsx`. */
type ChartTooltipPayloadItem = { dataKey?: unknown; value?: unknown };

function RevenueAdsTooltip({
  active,
  payload,
  label,
}: {
  active?: boolean;
  payload?: readonly ChartTooltipPayloadItem[];
  label?: unknown;
}) {
  if (!active || !payload || payload.length === 0) return null;

  const revenue = Number(payload.find((p) => p.dataKey === "revenue")?.value ?? 0);
  const ads = Number(payload.find((p) => p.dataKey === "ads")?.value ?? 0);
  const roas = ads > 0 ? revenue / ads : null;

  return (
    <div className="rounded-lg border border-hairline bg-canvas p-2.5 text-xs shadow-sm">
      <p className="font-medium text-ink">{fullDayLabel(String(label))}</p>
      <div className="mt-1 flex flex-col gap-0.5">
        <div className="flex items-center justify-between gap-4 text-ink">
          <span>Doanh thu</span>
          <span>{formatVnd(revenue)}</span>
        </div>
        <div className="flex items-center justify-between gap-4 text-ink">
          <span>Ads</span>
          <span>{formatVnd(ads)}</span>
        </div>
        <div className="mt-1 flex items-center justify-between gap-4 border-t border-hairline pt-1 font-medium text-ink">
          <span>ROAS</span>
          <span>{roas === null ? "—" : formatRoas(roas)}</span>
        </div>
      </div>
    </div>
  );
}

export function ChannelRevenueAdsChart({ points, channelColor }: { points: Point[]; channelColor: string }) {
  const groupedByWeek = points.length > WEEK_GROUP_THRESHOLD_DAYS;
  const data = groupedByWeek ? groupByWeek(points, ["revenue", "ads"]) : points;

  return (
    <div className="rounded-xl border border-hairline bg-canvas p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-serif text-lg text-ink">Doanh thu vs Chi phí ads theo ngày</h3>
        {groupedByWeek && <p className="text-xs text-muted-foreground">Gộp theo tuần</p>}
      </div>

      <div className="mt-4 h-72 w-full">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={data} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
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
            <Tooltip content={RevenueAdsTooltip} />
            <Line type="monotone" dataKey="revenue" name="Doanh thu" stroke={channelColor} strokeWidth={2} dot={false} />
            <Line
              type="monotone"
              dataKey="ads"
              name="Ads"
              stroke={ADS_COLOR}
              strokeWidth={2}
              strokeDasharray="4 4"
              dot={false}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
