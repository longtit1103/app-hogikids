"use client";

import { useState } from "react";
import Link from "next/link";
import { format, parse } from "date-fns";
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

import { ChannelInactiveAccordion } from "@/components/kenh/channel-inactive-accordion";
import { ChannelTrendTooltip } from "@/components/kenh/channel-trend-tooltip";
import { formatVnd, formatVndShort } from "@/lib/format";
import { groupByWeek } from "@/lib/reports/group-by-week";
import type { ChannelPnl } from "@/lib/reports/pnl";
import { cn } from "@/lib/utils";

const WEEK_GROUP_THRESHOLD_DAYS = 90;
const HIDDEN_DOT_COLOR = "#a9a49a"; // --muted

/** 1 điểm ngày (hoặc tuần sau `groupByWeek`): date + doanh thu từng kênh bật, khóa = channelId. */
type ChartPoint = { date: string; [channelId: string]: number | string };

function dayLabel(dateStr: string): string {
  return format(parse(dateStr, "yyyy-MM-dd", new Date()), "dd/MM");
}

function buildPoints(
  dailyRevenue: Array<{ date: string; values: Record<string, number> }>,
  activeChannels: ChannelPnl[]
): ChartPoint[] {
  return dailyRevenue.map((d) => {
    const point: ChartPoint = { date: d.date };
    for (const c of activeChannels) point[c.channelId] = d.values[c.channelId] ?? 0;
    return point;
  });
}

/**
 * Line chart doanh thu theo kênh theo ngày + accordion "Kênh đã tắt" cuối
 * card (component riêng — `channel-inactive-accordion.tsx`). `channels` =
 * kênh đang bật (đã zero-fill ở page.tsx, dùng để vẽ đường + legend) GỘP
 * kênh đã tắt còn hoạt động trong kỳ (dùng cho accordion — `computeChannelPnl`
 * chỉ trả kênh có phát sinh nên không cần lọc thêm ở đây).
 */
export function ChannelTrendChart({
  dailyRevenue,
  channels,
}: {
  dailyRevenue: Array<{ date: string; values: Record<string, number> }>;
  channels: ChannelPnl[];
}) {
  const [hiddenIds, setHiddenIds] = useState<Set<string>>(new Set());

  const activeChannels = channels.filter((c) => c.isActive);
  const inactiveChannels = channels.filter((c) => !c.isActive);
  const totalRevenue = channels.reduce((sum, c) => sum + c.revenue, 0);
  const hasActiveChannels = activeChannels.length > 0;
  const showEmptyState = !hasActiveChannels || totalRevenue === 0;

  const rawPoints = buildPoints(dailyRevenue, activeChannels);
  const groupedByWeek = rawPoints.length > WEEK_GROUP_THRESHOLD_DAYS;
  const points = groupedByWeek
    ? groupByWeek(rawPoints, activeChannels.map((c) => c.channelId) as (keyof ChartPoint)[])
    : rawPoints;

  function toggleChannel(id: string) {
    setHiddenIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        // Không cho ẩn hết — phải còn ≥1 đường hiện.
        if (activeChannels.length - next.size <= 1) return prev;
        next.add(id);
      }
      return next;
    });
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="rounded-xl border border-hairline bg-canvas p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h3 className="font-serif text-lg text-ink">Doanh thu theo kênh theo ngày</h3>
            {groupedByWeek && <p className="text-xs text-muted-foreground">Gộp theo tuần</p>}
          </div>
          {hasActiveChannels && (
            <div className="flex flex-wrap gap-2">
              {activeChannels.map((c) => {
                const hidden = hiddenIds.has(c.channelId);
                return (
                  <button
                    key={c.channelId}
                    type="button"
                    aria-pressed={!hidden}
                    onClick={() => toggleChannel(c.channelId)}
                    className={cn(
                      "inline-flex items-center gap-1.5 rounded-full border border-hairline px-2.5 py-1 text-xs transition-colors hover:bg-surface-soft",
                      hidden ? "text-muted-foreground" : "text-ink"
                    )}
                  >
                    <span className="size-2 rounded-full" style={{ backgroundColor: hidden ? HIDDEN_DOT_COLOR : c.color }} />
                    {c.name}
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {showEmptyState ? (
          <div className="mt-4 flex h-64 flex-col items-center justify-center gap-2 text-center">
            <p className="font-serif text-xl text-muted-foreground">{formatVnd(0)}</p>
            <p className="text-sm text-muted-foreground">Chưa có dữ liệu trong kỳ — kiểm tra đồng bộ</p>
            <Link href="/cai-dat" className="text-sm text-primary hover:underline">
              Đi tới Cài đặt
            </Link>
          </div>
        ) : (
          <div className="mt-4 h-72 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={points} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
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
                <Tooltip content={ChannelTrendTooltip} />
                {activeChannels.map(
                  (c) =>
                    !hiddenIds.has(c.channelId) && (
                      <Line
                        key={c.channelId}
                        type="monotone"
                        dataKey={c.channelId}
                        name={c.name}
                        stroke={c.color}
                        strokeWidth={2}
                        dot={false}
                      />
                    )
                )}
              </LineChart>
            </ResponsiveContainer>
          </div>
        )}
      </div>

      <ChannelInactiveAccordion channels={inactiveChannels} />
    </div>
  );
}
