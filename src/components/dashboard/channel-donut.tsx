"use client";

import { useRouter } from "next/navigation";
import { Cell, Pie, PieChart, ResponsiveContainer } from "recharts";

import { formatVnd } from "@/lib/format";
import type { ChannelPnl } from "@/lib/reports/pnl";

const INACTIVE_COLOR = "#6c6a64"; // --muted

type Slice = { key: string; name: string; revenue: number; color: string; href: string };

function buildSlices(channels: ChannelPnl[]): Slice[] {
  const slices: Slice[] = channels
    .filter((c) => c.isActive)
    .map((c) => ({ key: c.channelId, name: c.name, revenue: c.revenue, color: c.color, href: `/kenh/${c.channelId}` }));

  const inactiveRevenue = channels.filter((c) => !c.isActive).reduce((sum, c) => sum + c.revenue, 0);
  if (inactiveRevenue > 0) {
    slices.push({ key: "inactive", name: "Kênh đã tắt", revenue: inactiveRevenue, color: INACTIVE_COLOR, href: "/kenh" });
  }
  return slices;
}

/**
 * Donut doanh thu theo kênh trong range toàn cục. Kênh tắt gộp 1 lát
 * "Kênh đã tắt" màu `--muted` (không tách riêng — lịch sử của kênh đã tắt vẫn
 * cần thấy nhưng không cần chi tiết từng kênh). Click lát/dòng chú giải →
 * `/kenh/{id}`; lát gộp → `/kenh` (mục "Kênh đã tắt" cuối trang đó).
 */
export function ChannelDonut({ channels }: { channels: ChannelPnl[] }) {
  const router = useRouter();
  const slices = buildSlices(channels);
  const total = slices.reduce((sum, s) => sum + s.revenue, 0);

  if (total === 0) {
    return (
      <div className="rounded-xl border border-hairline bg-canvas p-4">
        <h3 className="font-serif text-lg text-ink">Doanh thu theo kênh</h3>
        <div className="mt-4 flex h-64 flex-col items-center justify-center gap-3">
          <div className="size-32 rounded-full border border-hairline" />
          <p className="text-sm text-muted-foreground">Chưa có doanh thu</p>
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-hairline bg-canvas p-4">
      <h3 className="font-serif text-lg text-ink">Doanh thu theo kênh</h3>
      <div className="relative mt-4 h-64 w-full">
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie
              data={slices}
              dataKey="revenue"
              nameKey="name"
              innerRadius="60%"
              outerRadius="90%"
              paddingAngle={slices.length > 1 ? 2 : 0}
              stroke="none"
            >
              {slices.map((s) => (
                <Cell
                  key={s.key}
                  fill={s.color}
                  cursor="pointer"
                  onClick={() => router.push(s.href)}
                />
              ))}
            </Pie>
          </PieChart>
        </ResponsiveContainer>
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
          <p className="text-xs text-muted-foreground">Tổng doanh thu</p>
          <p className="font-serif text-xl text-ink">{formatVnd(total)}</p>
        </div>
      </div>

      <div className="mt-4 flex flex-col gap-1">
        {slices.map((s) => {
          const pct = total > 0 ? (s.revenue / total) * 100 : 0;
          return (
            <button
              key={s.key}
              type="button"
              onClick={() => router.push(s.href)}
              className="flex items-center justify-between gap-2 rounded-lg px-2 py-1.5 text-left text-sm transition-colors hover:bg-surface-soft"
            >
              <span className="flex items-center gap-2 text-ink">
                <span className="size-2.5 shrink-0 rounded-full" style={{ backgroundColor: s.color }} />
                {s.name}
              </span>
              <span className="flex items-center gap-2">
                <span className="text-ink">{formatVnd(s.revenue)}</span>
                <span className="text-muted-foreground">{Math.round(pct)}%</span>
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
