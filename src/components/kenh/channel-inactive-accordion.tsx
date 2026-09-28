"use client";

import { useState } from "react";
import Link from "next/link";

import { formatVnd } from "@/lib/format";
import type { ChannelPnl } from "@/lib/reports/pnl";

/**
 * Accordion "Kênh đã tắt (N)" cuối `channel-trend-chart.tsx` — chỉ render khi
 * có ≥1 kênh tắt còn phát sinh trong kỳ (caller đã lọc `!isActive`, đúng như
 * kết quả thô của `computeChannelPnl` vốn chỉ trả kênh có hoạt động). State
 * mở/đóng tự chứa trong component này — không ảnh hưởng phần chart/legend.
 */
export function ChannelInactiveAccordion({ channels }: { channels: ChannelPnl[] }) {
  const [open, setOpen] = useState(false);

  if (channels.length === 0) {
    return null;
  }

  return (
    <div className="rounded-xl border border-hairline bg-canvas p-4">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1.5 text-xs font-medium tracking-wide text-muted-foreground uppercase"
      >
        {open ? "▾" : "▸"} Kênh đã tắt ({channels.length})
      </button>
      {open && (
        <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
          {channels.map((c) => (
            <div
              key={c.channelId}
              className="flex items-center justify-between gap-3 rounded-lg bg-surface-soft p-3 opacity-70"
            >
              <span className="flex items-center gap-2">
                <span className="size-2.5 shrink-0 rounded-full" style={{ backgroundColor: c.color }} />
                <span className="text-sm text-ink">{c.name}</span>
                <span className="rounded-full bg-surface-cream-strong px-2 py-0.5 text-[11px] text-muted-foreground">
                  Đã tắt
                </span>
              </span>
              <span className="flex items-center gap-3">
                <span className="text-sm text-ink">{formatVnd(c.revenue)}</span>
                <Link href={`/kenh/${c.channelId}`} className="text-xs text-primary hover:underline">
                  Xem chi tiết →
                </Link>
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
