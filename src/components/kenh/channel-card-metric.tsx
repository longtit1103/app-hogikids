import { cn } from "@/lib/utils";
import type { ChannelPnl } from "@/lib/reports/pnl";

/**
 * Primitives dùng chung bởi `channel-card-grid.tsx`: 1 ô chỉ số (label + giá
 * trị + delta) và dòng delta so kỳ trước. Tách khỏi file card layout chính vì
 * đây là 2 mối quan tâm khác nhau (khối dựng UI 1 chỉ số vs. bố cục toàn thẻ).
 */

type MetricDirection = "higher-better" | "lower-better";

/**
 * So kỳ trước theo % TƯƠNG ĐỐI — kỳ trước null/0 → "Mới" (không chia 0); kỳ
 * hiện tại null → không hiện delta (không có gì để so). Chi phí (ads/phí
 * sàn/hoàn-bom) giảm = tốt = success — `direction="lower-better"`.
 */
export function DeltaLine({
  current,
  previous,
  direction = "higher-better",
  dark,
}: {
  current: number | null;
  previous: number | null;
  direction?: MetricDirection;
  dark: boolean;
}) {
  const mutedClass = dark ? "text-on-dark/70" : "text-muted-foreground";

  if (current === null) return null;
  if (previous === null || previous === 0) {
    return <span className={cn("text-[11px]", mutedClass)}>Mới</span>;
  }

  const pct = ((current - previous) / previous) * 100;
  if (Math.round(Math.abs(pct)) === 0) {
    return <span className={cn("text-[11px]", mutedClass)}>0%</span>;
  }

  const up = pct > 0;
  const good = direction === "higher-better" ? up : !up;
  return (
    <span className={cn("text-[11px]", good ? "text-success" : "text-error")}>
      {up ? "▲" : "▼"} {Math.round(Math.abs(pct))}%
    </span>
  );
}

export function MetricCell({
  label,
  value,
  delta,
  dark,
  valueClassName,
  valueTitle,
}: {
  label: string;
  value: React.ReactNode;
  delta?: React.ReactNode;
  dark: boolean;
  valueClassName?: string;
  valueTitle?: string;
}) {
  return (
    <div>
      <p className={cn("text-xs", dark ? "text-on-dark/70" : "text-muted-foreground")}>{label}</p>
      <p
        title={valueTitle}
        className={cn("text-sm font-medium", dark ? "text-on-dark" : "text-ink", valueClassName)}
      >
        {value}
      </p>
      {delta}
    </div>
  );
}

/**
 * netProfit MAX DUY NHẤT (không hòa) và > 0, cần ≥2 kênh mới có ý nghĩa so
 * sánh — hòa hạng / toàn lỗ / chỉ 1 kênh → không ai nhận badge "DẪN ĐẦU".
 */
export function findLeaderChannelId(channels: ChannelPnl[]): string | null {
  if (channels.length < 2) return null;

  let max = -Infinity;
  let count = 0;
  let leaderId: string | null = null;
  for (const c of channels) {
    if (c.netProfit > max) {
      max = c.netProfit;
      count = 1;
      leaderId = c.channelId;
    } else if (c.netProfit === max) {
      count += 1;
    }
  }

  return count === 1 && max > 0 ? leaderId : null;
}
