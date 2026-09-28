"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowDown, ArrowUp, ChevronsUpDown } from "lucide-react";

import { formatPct1, formatRoas } from "@/components/kenh/channel-format";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatVnd } from "@/lib/format";
import type { ChannelPnl } from "@/lib/reports/pnl";
import { cn } from "@/lib/utils";

/**
 * Chế độ Bảng của /kenh — hàng = kênh đang bật (đã zero-fill ở page.tsx) +
 * hàng "Tổng" ghim cuối (không tham gia sort, không click). Sort THUẦN CLIENT
 * (dữ liệu đã tải hết, không cần round-trip URL như bảng /chi-phi).
 */

type ColumnKey = "name" | "revenue" | "orderCount" | "aov" | "ads" | "platformFee" | "returnBom" | "netProfit" | "roas";

const COLUMNS: { key: ColumnKey; label: string; align: "left" | "right" }[] = [
  { key: "name", label: "Kênh", align: "left" },
  { key: "revenue", label: "Doanh thu", align: "right" },
  { key: "orderCount", label: "Số đơn", align: "right" },
  { key: "aov", label: "AOV", align: "right" },
  { key: "ads", label: "Ads", align: "right" },
  { key: "platformFee", label: "Phí sàn", align: "right" },
  { key: "returnBom", label: "Hoàn/Bom", align: "right" },
  { key: "netProfit", label: "LN ròng", align: "right" },
  { key: "roas", label: "ROAS", align: "right" },
];

function sortValue(c: ChannelPnl, key: ColumnKey): number | string | null {
  switch (key) {
    case "name":
      return c.name;
    case "revenue":
      return c.revenue;
    case "orderCount":
      return c.orderCount;
    case "aov":
      return c.aov;
    case "ads":
      return c.ads;
    case "platformFee":
      return c.platformFee;
    case "returnBom":
      return c.returnBomRatePct;
    case "netProfit":
      return c.netProfit;
    case "roas":
      return c.roas;
  }
}

/** Hàng "Tổng": tiền/đếm cộng dồn; tỉ lệ (AOV/Hoàn-Bom/ROAS/margin) TÍNH LẠI từ tổng — không cộng trung bình các % lại. */
function computeTotalRow(channels: ChannelPnl[]): ChannelPnl {
  const revenue = channels.reduce((s, c) => s + c.revenue, 0);
  const orderCount = channels.reduce((s, c) => s + c.orderCount, 0);
  const ads = channels.reduce((s, c) => s + c.ads, 0);
  const platformFee = channels.reduce((s, c) => s + c.platformFee, 0);
  const returnBomOrderCount = channels.reduce((s, c) => s + c.returnBomOrderCount, 0);
  const netProfit = channels.reduce((s, c) => s + c.netProfit, 0);
  const returnDenom = orderCount + returnBomOrderCount;

  return {
    channelId: "__total__",
    name: "Tổng",
    color: "transparent",
    isActive: true,
    revenue,
    orderCount,
    aov: orderCount ? revenue / orderCount : null,
    ads,
    platformFee,
    returnBomOrderCount,
    returnBomRatePct: returnDenom ? (returnBomOrderCount / returnDenom) * 100 : null,
    netProfit,
    roas: ads > 0 ? revenue / ads : null,
    marginPct: revenue ? (netProfit / revenue) * 100 : null,
  };
}

function DataRow({ c, isTotal, onClick }: { c: ChannelPnl; isTotal?: boolean; onClick?: () => void }) {
  return (
    <TableRow
      onClick={onClick}
      className={cn(isTotal ? "cursor-default font-medium hover:bg-transparent" : "cursor-pointer")}
    >
      <TableCell>
        <span className="flex items-center gap-2">
          {!isTotal && <span className="size-2.5 shrink-0 rounded-full" style={{ backgroundColor: c.color }} />}
          {c.name}
        </span>
      </TableCell>
      <TableCell className="text-right">{formatVnd(c.revenue)}</TableCell>
      <TableCell className="text-right">{c.orderCount.toLocaleString("vi-VN")}</TableCell>
      <TableCell className="text-right">{c.aov === null ? "—" : formatVnd(c.aov)}</TableCell>
      <TableCell className="text-right">{formatVnd(c.ads)}</TableCell>
      <TableCell className="text-right">{formatVnd(c.platformFee)}</TableCell>
      <TableCell className="text-right">
        {c.returnBomRatePct === null ? "—" : formatPct1(c.returnBomRatePct)} · {c.returnBomOrderCount.toLocaleString("vi-VN")} đơn
      </TableCell>
      <TableCell className={cn("bg-surface-soft text-right", c.netProfit < 0 && "text-error")}>
        {formatVnd(c.netProfit)}
      </TableCell>
      <TableCell className="bg-surface-soft text-right">
        {c.roas === null ? (
          <span title="Chưa có chi phí ads">—</span>
        ) : (
          formatRoas(c.roas)
        )}
      </TableCell>
    </TableRow>
  );
}

export function ChannelCompareTable({ channels }: { channels: ChannelPnl[] }) {
  const router = useRouter();
  const [sort, setSort] = useState<{ key: ColumnKey; dir: "asc" | "desc" }>({ key: "revenue", dir: "desc" });

  function toggleSort(key: ColumnKey) {
    setSort((prev) => (prev.key === key ? { key, dir: prev.dir === "desc" ? "asc" : "desc" } : { key, dir: "desc" }));
  }

  const sorted = [...channels].sort((a, b) => {
    const av = sortValue(a, sort.key);
    const bv = sortValue(b, sort.key);
    if (av === null && bv === null) return 0;
    if (av === null) return 1; // null luôn xuống cuối bất kể chiều sort
    if (bv === null) return -1;
    const cmp = typeof av === "string" ? av.localeCompare(bv as string) : av - (bv as number);
    return sort.dir === "asc" ? cmp : -cmp;
  });

  const totalRow = computeTotalRow(channels);

  return (
    <div className="rounded-xl border border-hairline bg-canvas">
      {/* Desktop: bảng (9 cột — cuộn ngang nếu màn hẹp hơn md) */}
      <div className="hidden overflow-x-auto md:block">
        <Table>
          <TableHeader>
            <TableRow>
              {COLUMNS.map((col) => {
                const active = sort.key === col.key;
                return (
                  <TableHead key={col.key} className={col.align === "right" ? "text-right" : undefined}>
                    <button
                      type="button"
                      onClick={() => toggleSort(col.key)}
                      className={cn(
                        "inline-flex items-center gap-1 hover:text-ink",
                        col.align === "right" && "flex-row-reverse"
                      )}
                    >
                      {col.label}
                      {active ? (
                        sort.dir === "desc" ? (
                          <ArrowDown className="size-3.5" />
                        ) : (
                          <ArrowUp className="size-3.5" />
                        )
                      ) : (
                        <ChevronsUpDown className="size-3.5 opacity-40" />
                      )}
                    </button>
                  </TableHead>
                );
              })}
            </TableRow>
          </TableHeader>
          <TableBody>
            {sorted.map((c) => (
              <DataRow key={c.channelId} c={c} onClick={() => router.push(`/kenh/${c.channelId}`)} />
            ))}
            <DataRow c={totalRow} isTotal />
          </TableBody>
        </Table>
      </div>

      {/* Mobile: card dọc — chỉ số chính (doanh thu/đơn/LN ròng/ROAS), bấm vào để xem chi tiết kênh */}
      <div className="flex flex-col gap-2 p-3 md:hidden">
        {sorted.map((c) => (
          <button
            key={c.channelId}
            type="button"
            onClick={() => router.push(`/kenh/${c.channelId}`)}
            className="flex flex-col gap-1.5 rounded-lg border border-hairline p-3 text-left"
          >
            <div className="flex items-center justify-between">
              <span className="flex items-center gap-2 text-sm text-ink">
                <span className="size-2.5 shrink-0 rounded-full" style={{ backgroundColor: c.color }} />
                {c.name}
              </span>
              <span className="text-sm font-medium text-ink">{formatVnd(c.revenue)}</span>
            </div>
            <div className="flex items-center justify-between text-xs text-muted-foreground">
              <span>
                {c.orderCount.toLocaleString("vi-VN")} đơn · AOV {c.aov === null ? "—" : formatVnd(c.aov)}
              </span>
              <span>ROAS {c.roas === null ? "—" : formatRoas(c.roas)}</span>
            </div>
            <div className="flex items-center justify-between text-sm">
              <span className="text-muted-foreground">LN ròng</span>
              <span className={cn(c.netProfit < 0 && "text-error")}>{formatVnd(c.netProfit)}</span>
            </div>
          </button>
        ))}
        <div className="flex flex-col gap-1.5 rounded-lg border border-hairline bg-surface-soft p-3">
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium text-ink">Tổng</span>
            <span className="text-sm font-medium text-ink">{formatVnd(totalRow.revenue)}</span>
          </div>
          <div className="flex items-center justify-between text-sm">
            <span className="text-muted-foreground">LN ròng</span>
            <span className={cn(totalRow.netProfit < 0 && "text-error")}>{formatVnd(totalRow.netProfit)}</span>
          </div>
        </div>
      </div>
    </div>
  );
}
