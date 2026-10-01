"use client";

import { Fragment } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";

import { TableCell, TableRow } from "@/components/ui/table";
import { formatVnd } from "@/lib/format";
import type { ProductReportRowChe } from "@/lib/reports/product-report";

/** Phần COGS/lãi của một dòng — null ở nhánh che (server không tính). `skus` khớp chỉ số với `row.skus`. */
export type GiaVonDongSanPham = {
  cogs: number;
  grossProfit: number;
  marginPct: number | null;
  skus: { cogs: number; grossProfit: number }[];
};

function formatPct(n: number | null): string {
  return n === null ? "—" : `${n.toLocaleString("vi-VN", { maximumFractionDigits: 1 })}%`;
}

/**
 * 1 sản phẩm (+ dòng SKU con khi mở rộng) trong bảng tab Sản phẩm. Tách khỏi
 * `product-report-tab.tsx` (>200 dòng nếu gộp — quy ước modularize) — thuần
 * hiển thị, KHÔNG tự tính lại tổng: số dòng cha đã = Σ dòng con sẵn từ
 * `computeProductReport` (product-report.ts), ở đây chỉ render.
 */
export function ProductReportRow({
  row,
  giaVon,
  expanded,
  onToggle,
}: {
  row: ProductReportRowChe;
  giaVon: GiaVonDongSanPham | null;
  expanded: boolean;
  onToggle: () => void;
}) {
  return (
    <Fragment>
      <TableRow>
        <TableCell>
          <button
            type="button"
            onClick={onToggle}
            className="flex items-center gap-1.5 text-left hover:underline"
            aria-expanded={expanded}
          >
            {expanded ? (
              <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
            ) : (
              <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
            )}
            {row.name}
          </button>
        </TableCell>
        <TableCell className="text-right tabular-nums">{row.soldQty.toLocaleString("vi-VN")}</TableCell>
        <TableCell className="text-right tabular-nums">{formatVnd(row.revenue)}</TableCell>
        {giaVon && <TableCell className="text-right tabular-nums">{formatVnd(giaVon.cogs)}</TableCell>}
        {giaVon && <TableCell className="text-right tabular-nums">{formatVnd(giaVon.grossProfit)}</TableCell>}
        {giaVon && (
          <TableCell className="text-right tabular-nums text-muted-foreground">{formatPct(giaVon.marginPct)}</TableCell>
        )}
        <TableCell className="text-right tabular-nums">{row.currentStock.toLocaleString("vi-VN")}</TableCell>
      </TableRow>
      {expanded &&
        row.skus.map((s, i) => (
          <TableRow key={s.variantId ?? s.sku} className="bg-surface-soft/60">
            <TableCell className="pl-8 text-muted-foreground">
              {s.sku} · {s.label}
            </TableCell>
            <TableCell className="text-right tabular-nums text-muted-foreground">
              {s.soldQty.toLocaleString("vi-VN")}
            </TableCell>
            <TableCell className="text-right tabular-nums text-muted-foreground">{formatVnd(s.revenue)}</TableCell>
            {giaVon && (
              <TableCell className="text-right tabular-nums text-muted-foreground">{formatVnd(giaVon.skus[i]?.cogs ?? 0)}</TableCell>
            )}
            {giaVon && (
              <TableCell className="text-right tabular-nums text-muted-foreground">
                {formatVnd(giaVon.skus[i]?.grossProfit ?? 0)}
              </TableCell>
            )}
            {giaVon && <TableCell className="text-right text-muted-foreground">—</TableCell>}
            <TableCell className="text-right tabular-nums text-muted-foreground">
              {s.currentStock.toLocaleString("vi-VN")}
            </TableCell>
          </TableRow>
        ))}
    </Fragment>
  );
}
