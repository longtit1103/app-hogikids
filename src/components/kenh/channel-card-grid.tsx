import Link from "next/link";

import { DeltaLine, findLeaderChannelId, MetricCell } from "@/components/kenh/channel-card-metric";
import { feeBadgeLabel, formatPct1, formatRoas } from "@/components/kenh/channel-format";
import { Badge } from "@/components/ui/badge";
import { formatVnd } from "@/lib/format";
import type { ChannelPnl } from "@/lib/reports/pnl";
import { cn } from "@/lib/utils";

/**
 * Grid thẻ so sánh kênh — mỗi thẻ 1 kênh ĐANG BẬT. `channels` đã được zero-fill
 * ở page.tsx (kênh bật nhưng 0 hoạt động trong kỳ vẫn phải có thẻ 0 ₫, không
 * được biến mất như kết quả thô của `computeChannelPnl`). Kênh dẫn đầu lợi
 * nhuận ròng (duy nhất, dương, ≥2 kênh) nhận nền tối + badge "DẪN ĐẦU" — xem
 * `findLeaderChannelId` (channel-card-metric.tsx, cùng `DeltaLine`/`MetricCell`).
 */

export function ChannelCardGrid({
  channels,
  prevChannels,
  feePctByChannel,
  compareOn,
}: {
  /** Kênh ĐANG BẬT, đã zero-fill — xem ghi chú đầu file. */
  channels: ChannelPnl[];
  /** Kết quả `computeChannelPnl(previousRange(range))` — KHÔNG zero-fill (kênh vắng = không có dữ liệu kỳ trước → "Mới"). */
  prevChannels: ChannelPnl[];
  feePctByChannel: Record<string, number>;
  compareOn: boolean;
}) {
  const prevById = new Map(prevChannels.map((c) => [c.channelId, c]));
  const leaderId = findLeaderChannelId(channels);

  return (
    <div className={cn("grid grid-cols-1 gap-4", channels.length > 1 && "sm:grid-cols-2")}>
      {channels.map((c) => {
        const prev = prevById.get(c.channelId) ?? null;
        const dark = c.channelId === leaderId;

        return (
          <Link
            key={c.channelId}
            href={`/kenh/${c.channelId}?so_sanh=${compareOn ? 1 : 0}`}
            className={cn(
              "block rounded-xl p-4 transition-colors",
              dark ? "bg-surface-dark text-on-dark" : "bg-surface-card hover:bg-surface-soft"
            )}
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="flex items-center gap-2">
                <span className="size-2.5 shrink-0 rounded-full" style={{ backgroundColor: c.color }} />
                <span className={cn("text-base font-medium", dark ? "text-on-dark" : "text-ink")}>{c.name}</span>
              </span>
              <div className="flex items-center gap-1.5">
                {dark && <Badge className="border-none bg-primary text-on-primary">DẪN ĐẦU</Badge>}
                <Badge className={cn("border-none", dark ? "bg-on-dark/15 text-on-dark" : "bg-surface-cream-strong text-ink")}>
                  {feeBadgeLabel(feePctByChannel[c.channelId] ?? 0)}
                </Badge>
              </div>
            </div>

            <p className={cn("mt-3 font-serif text-2xl", dark ? "text-on-dark" : "text-ink")}>{formatVnd(c.revenue)}</p>
            {compareOn && <DeltaLine current={c.revenue} previous={prev?.revenue ?? null} dark={dark} />}

            <div className="mt-4 grid grid-cols-2 gap-3">
              <MetricCell
                label="Số đơn"
                value={c.orderCount.toLocaleString("vi-VN")}
                dark={dark}
                delta={compareOn && <DeltaLine current={c.orderCount} previous={prev?.orderCount ?? null} dark={dark} />}
              />
              <MetricCell
                label="AOV"
                value={c.aov === null ? "—" : formatVnd(c.aov)}
                dark={dark}
                delta={compareOn && <DeltaLine current={c.aov} previous={prev?.aov ?? null} dark={dark} />}
              />
              <MetricCell
                label="Chi phí ads"
                value={formatVnd(c.ads)}
                dark={dark}
                delta={
                  compareOn && (
                    <DeltaLine current={c.ads} previous={prev?.ads ?? null} direction="lower-better" dark={dark} />
                  )
                }
              />
              <MetricCell
                label="Phí sàn (từ đơn) 🔗"
                value={formatVnd(c.platformFee)}
                dark={dark}
                delta={
                  compareOn && (
                    <DeltaLine
                      current={c.platformFee}
                      previous={prev?.platformFee ?? null}
                      direction="lower-better"
                      dark={dark}
                    />
                  )
                }
              />
              <MetricCell
                label="Hoàn/Bom"
                value={`${c.returnBomRatePct === null ? "—" : formatPct1(c.returnBomRatePct)} · ${c.returnBomOrderCount.toLocaleString("vi-VN")} đơn`}
                dark={dark}
                delta={
                  compareOn && (
                    <DeltaLine
                      current={c.returnBomRatePct}
                      previous={prev?.returnBomRatePct ?? null}
                      direction="lower-better"
                      dark={dark}
                    />
                  )
                }
              />
              <MetricCell
                label="LN ròng kênh"
                value={formatVnd(c.netProfit)}
                valueClassName={c.netProfit < 0 ? "text-error" : undefined}
                dark={dark}
                delta={compareOn && <DeltaLine current={c.netProfit} previous={prev?.netProfit ?? null} dark={dark} />}
              />
              <MetricCell
                label="ROAS"
                value={c.roas === null ? "—" : formatRoas(c.roas)}
                valueTitle={c.roas === null ? "Chưa có chi phí ads" : undefined}
                dark={dark}
                delta={compareOn && <DeltaLine current={c.roas} previous={prev?.roas ?? null} dark={dark} />}
              />
              <MetricCell
                label="Tỷ suất LN"
                value={c.marginPct === null ? "—" : formatPct1(c.marginPct)}
                dark={dark}
                delta={compareOn && <DeltaLine current={c.marginPct} previous={prev?.marginPct ?? null} dark={dark} />}
              />
            </div>

            <p className={cn("mt-4 text-sm", dark ? "text-on-dark" : "text-primary")}>Xem chi tiết →</p>
          </Link>
        );
      })}
    </div>
  );
}
