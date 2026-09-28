import Link from "next/link";
import { ArrowDown, ArrowUp } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatVnd } from "@/lib/format";
import type { VariantRow } from "@/lib/queries/variants";
import { cn } from "@/lib/utils";

const PAGE_SIZE = 20;

function hrefWith(sp: Record<string, string | undefined>, overrides: Record<string, string | undefined>): string {
  const params = new URLSearchParams();
  const merged = { ...sp, ...overrides };
  for (const [k, v] of Object.entries(merged)) if (v) params.set(k, v);
  const qs = params.toString();
  return qs ? `/ton-kho?${qs}` : "/ton-kho";
}

function SortHeader({
  label,
  field,
  sp,
  sort,
  dir,
}: {
  label: string;
  field: "ton" | "von";
  sp: Record<string, string | undefined>;
  sort: "ton" | "von";
  dir: "asc" | "desc";
}) {
  const active = sort === field;
  const nextDir = active && dir === "desc" ? "asc" : "desc";
  return (
    <Link
      href={hrefWith(sp, { sap_xep: field, chieu: nextDir, trang: undefined })}
      className={cn("inline-flex items-center gap-1 hover:text-ink", active && "text-ink")}
    >
      {label}
      {active && (dir === "desc" ? <ArrowDown className="size-3" /> : <ArrowUp className="size-3" />)}
    </Link>
  );
}

export function InventoryTable({
  rows,
  total,
  page,
  sort,
  dir,
  sp,
}: {
  rows: VariantRow[];
  total: number;
  page: number;
  sort: "ton" | "von";
  dir: "asc" | "desc";
  sp: Record<string, string | undefined>;
}) {
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const from = total === 0 ? 0 : (page - 1) * PAGE_SIZE + 1;
  const to = Math.min(page * PAGE_SIZE, total);

  return (
    <div className="rounded-xl border border-hairline">
      {/* Desktop: bảng */}
      <Table className="hidden md:table">
        <TableHeader>
          <TableRow>
            <TableHead>SKU</TableHead>
            <TableHead>Sản phẩm</TableHead>
            <TableHead className="text-right">
              <SortHeader label="Tồn" field="ton" sp={sp} sort={sort} dir={dir} />
            </TableHead>
            <TableHead className="text-right">Ngưỡng</TableHead>
            <TableHead className="text-right">Giá vốn</TableHead>
            <TableHead className="text-right">
              <SortHeader label="Giá trị vốn" field="von" sp={sp} sort={sort} dir={dir} />
            </TableHead>
            <TableHead>Trạng thái</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((v) => (
            <TableRow key={v.variantId} className={cn(v.isLow && "bg-warning/5")}>
              <TableCell className="font-mono text-sm">{v.sku}</TableCell>
              <TableCell>
                <div className="flex flex-col gap-0.5">
                  <span className="text-sm text-ink">{v.productName}</span>
                  <Badge variant="outline" className="w-fit">
                    {v.label}
                  </Badge>
                </div>
              </TableCell>
              <TableCell className="text-right text-sm">{v.stock.toLocaleString("vi-VN")}</TableCell>
              <TableCell className="text-right text-sm">
                {v.effectiveThreshold.toLocaleString("vi-VN")}
                {v.lowStockThreshold === null && "*"}
              </TableCell>
              <TableCell className="text-right text-sm">{formatVnd(v.costPrice)}</TableCell>
              <TableCell className="text-right text-sm">
                {v.costPrice === 0 ? (
                  <span title="Chưa có giá vốn — cập nhật ở Sản phẩm" className="text-muted-foreground">
                    —
                  </span>
                ) : (
                  formatVnd(v.stockValue)
                )}
              </TableCell>
              <TableCell>
                {v.stock === 0 ? (
                  <Badge className="bg-error text-white">Hết hàng</Badge>
                ) : v.isLow ? (
                  <Badge className="bg-warning/20 text-ink">Sắp hết</Badge>
                ) : null}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>

      {/* Mobile: card dọc */}
      <div className="flex flex-col gap-2 p-3 md:hidden">
        {rows.map((v) => (
          <div
            key={v.variantId}
            className={cn("flex flex-col gap-1.5 rounded-lg border border-hairline p-3", v.isLow && "bg-warning/5")}
          >
            <div className="flex items-center justify-between">
              <div className="flex flex-col gap-0.5">
                <span className="text-sm text-ink">{v.productName}</span>
                <span className="flex items-center gap-1.5">
                  <Badge variant="outline" className="w-fit">
                    {v.label}
                  </Badge>
                  <span className="font-mono text-xs text-muted-foreground">{v.sku}</span>
                </span>
              </div>
              {v.stock === 0 ? (
                <Badge className="bg-error text-white">Hết hàng</Badge>
              ) : v.isLow ? (
                <Badge className="bg-warning/20 text-ink">Sắp hết</Badge>
              ) : null}
            </div>
            <div className="flex items-center justify-between text-xs text-muted-foreground">
              <span>
                Tồn: {v.stock.toLocaleString("vi-VN")} · Ngưỡng: {v.effectiveThreshold.toLocaleString("vi-VN")}
                {v.lowStockThreshold === null && "*"}
              </span>
            </div>
            <div className="flex items-center justify-between text-sm">
              <span className="text-muted-foreground">Giá vốn: {formatVnd(v.costPrice)}</span>
              <span className="text-ink">
                {v.costPrice === 0 ? (
                  <span title="Chưa có giá vốn — cập nhật ở Sản phẩm" className="text-muted-foreground">
                    —
                  </span>
                ) : (
                  formatVnd(v.stockValue)
                )}
              </span>
            </div>
          </div>
        ))}
      </div>

      <div className="flex items-center justify-between border-t border-hairline px-4 py-3 text-sm text-muted-foreground">
        <span>
          Hiển thị {from}–{to} / {total}
        </span>
        <div className="flex items-center gap-1">
          <Link
            href={hrefWith(sp, { trang: String(Math.max(1, page - 1)) })}
            aria-disabled={page <= 1}
            className={cn("rounded-md px-2 py-1 hover:bg-surface-soft", page <= 1 && "pointer-events-none opacity-40")}
          >
            ‹
          </Link>
          <Link
            href={hrefWith(sp, { trang: String(Math.min(totalPages, page + 1)) })}
            aria-disabled={page >= totalPages}
            className={cn(
              "rounded-md px-2 py-1 hover:bg-surface-soft",
              page >= totalPages && "pointer-events-none opacity-40",
            )}
          >
            ›
          </Link>
        </div>
      </div>
    </div>
  );
}
