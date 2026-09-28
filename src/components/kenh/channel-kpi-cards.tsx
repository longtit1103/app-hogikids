"use client";

import { useState } from "react";
import { useSearchParams } from "next/navigation";

import { DeltaLine } from "@/components/kenh/channel-card-metric";
import { formatPct1, formatRoas } from "@/components/kenh/channel-format";
import { Switch } from "@/components/ui/switch";
import { formatVnd } from "@/lib/format";
import type { PnlBreakdown } from "@/lib/reports/pnl";
import { cn } from "@/lib/utils";

/**
 * Dải 8 KPI của `/kenh/:id` (design spec 8.1) — mỗi card thêm dòng "Kỳ trước:
 * X" mờ dưới delta, khác `channel-card-grid.tsx` (Task 6, chỉ có delta %).
 * Tái dùng NGUYÊN `DeltaLine` (channel-card-metric.tsx) cho phần ▲/▼% —
 * không viết lại cơ chế so kỳ trước, chỉ bổ sung dòng giá trị kỳ trước.
 *
 * `aov`/`returnBomRatePct`/`roas` suy ra TỪ `PnlBreakdown` bằng ĐÚNG công
 * thức `computeChannelPnl` (pnl.ts) đã dùng — không phải aggregate tiền mới,
 * chỉ là tỷ số hiển thị (cùng pattern `dashboard/kpi-cards.tsx` tự suy
 * `returnBomRatePct`/`marginPct` tại chỗ).
 */

type Ratios = { aov: number | null; returnBomRatePct: number | null; roas: number | null };

function deriveRatios(b: PnlBreakdown): Ratios {
  const returnDenom = b.orderCount + b.returnBomOrderCount;
  return {
    aov: b.orderCount ? b.revenue / b.orderCount : null,
    returnBomRatePct: returnDenom ? (b.returnBomOrderCount / returnDenom) * 100 : null,
    roas: b.ads > 0 ? b.revenue / b.ads : null,
  };
}

function KpiCard({
  label,
  valueText,
  valueClassName,
  current,
  previous,
  previousText,
  direction = "higher-better",
  compareOn,
}: {
  label: string;
  valueText: string;
  valueClassName?: string;
  current: number | null;
  previous: number | null;
  previousText: string;
  direction?: "higher-better" | "lower-better";
  compareOn: boolean;
}) {
  return (
    <div className="rounded-xl bg-surface-card p-4">
      <p className="text-xs text-muted-foreground uppercase tracking-wide">{label}</p>
      <p className={cn("mt-1 font-serif text-2xl text-ink", valueClassName)}>{valueText}</p>
      {compareOn && (
        <div className="mt-1 flex flex-col gap-0.5">
          <DeltaLine current={current} previous={previous} direction={direction} dark={false} />
          <span className="text-[11px] text-muted-foreground">Kỳ trước: {previousText}</span>
        </div>
      )}
    </div>
  );
}

export function ChannelKpiCards({ current, previous }: { current: PnlBreakdown; previous: PnlBreakdown }) {
  const searchParams = useSearchParams();
  // Khởi tạo từ `?so_sanh=` (link từ /kenh mang theo "0"/"1") — mặc định bật
  // khi param vắng mặt (điều hướng thẳng), khớp mặc định Task 6.
  const [compareOn, setCompareOn] = useState(() => searchParams.get("so_sanh") !== "0");

  const r = deriveRatios(current);
  const prevR = deriveRatios(previous);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex justify-end">
        <label className="flex items-center gap-2 text-sm text-ink">
          <Switch checked={compareOn} onCheckedChange={setCompareOn} />
          So với kỳ trước
        </label>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <KpiCard
          label="Doanh thu"
          valueText={formatVnd(current.revenue)}
          current={current.revenue}
          previous={previous.revenue}
          previousText={formatVnd(previous.revenue)}
          compareOn={compareOn}
        />
        <KpiCard
          label="Số đơn"
          valueText={current.orderCount.toLocaleString("vi-VN")}
          current={current.orderCount}
          previous={previous.orderCount}
          previousText={previous.orderCount.toLocaleString("vi-VN")}
          compareOn={compareOn}
        />
        <KpiCard
          label="AOV"
          valueText={r.aov === null ? "—" : formatVnd(r.aov)}
          current={r.aov}
          previous={prevR.aov}
          previousText={prevR.aov === null ? "—" : formatVnd(prevR.aov)}
          compareOn={compareOn}
        />
        <KpiCard
          label="Chi phí ads"
          valueText={formatVnd(current.ads)}
          current={current.ads}
          previous={previous.ads}
          previousText={formatVnd(previous.ads)}
          direction="lower-better"
          compareOn={compareOn}
        />
        <KpiCard
          label="Phí sàn (từ đơn) 🔗"
          valueText={formatVnd(current.platformFee)}
          current={current.platformFee}
          previous={previous.platformFee}
          previousText={formatVnd(previous.platformFee)}
          direction="lower-better"
          compareOn={compareOn}
        />
        <KpiCard
          label="Hoàn/Bom"
          valueText={`${r.returnBomRatePct === null ? "—" : formatPct1(r.returnBomRatePct)} · ${current.returnBomOrderCount.toLocaleString("vi-VN")} đơn`}
          current={r.returnBomRatePct}
          previous={prevR.returnBomRatePct}
          previousText={
            prevR.returnBomRatePct === null
              ? "—"
              : `${formatPct1(prevR.returnBomRatePct)} · ${previous.returnBomOrderCount.toLocaleString("vi-VN")} đơn`
          }
          direction="lower-better"
          compareOn={compareOn}
        />
        <KpiCard
          label="LN ròng"
          valueText={formatVnd(current.netProfit)}
          valueClassName={current.netProfit < 0 ? "text-error" : undefined}
          current={current.netProfit}
          previous={previous.netProfit}
          previousText={formatVnd(previous.netProfit)}
          compareOn={compareOn}
        />
        <KpiCard
          label="ROAS"
          valueText={r.roas === null ? "—" : formatRoas(r.roas)}
          current={r.roas}
          previous={prevR.roas}
          previousText={prevR.roas === null ? "—" : formatRoas(prevR.roas)}
          compareOn={compareOn}
        />
      </div>
    </div>
  );
}
