"use client";

import { useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { Shirt } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { updateVariantCost, updateVariantThreshold } from "@/lib/actions/cost-price";
import { formatVnd } from "@/lib/format";
import type { VariantRow } from "@/lib/queries/variants";
import { cn } from "@/lib/utils";
import { InlineMoneyCell } from "./inline-money-cell";

const PAGE_SIZE = 20;

/** "45.000" hoặc "45000" → 45000 (int ≥0); rỗng/không hợp lệ → undefined (không lưu). */
function parseMoneyInput(raw: string): number | undefined {
  const cleaned = raw.replace(/[^\d]/g, "");
  if (cleaned === "") return undefined;
  const n = Number.parseInt(cleaned, 10);
  return Number.isFinite(n) ? n : undefined;
}

/** Như trên nhưng rỗng → null (xóa ngưỡng riêng, dùng mặc định). */
function parseThresholdInput(raw: string): number | null | undefined {
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  const cleaned = trimmed.replace(/[^\d]/g, "");
  if (cleaned === "") return undefined;
  const n = Number.parseInt(cleaned, 10);
  return Number.isFinite(n) ? n : undefined;
}

export function VariantCostTable({
  rows,
  total,
  page,
  defaultThreshold,
}: {
  rows: VariantRow[];
  total: number;
  page: number;
  defaultThreshold: number;
}) {
  return (
    <div className="rounded-xl border border-hairline">
      {/* Desktop: bảng */}
      <Table className="hidden md:table">
        <TableHeader>
          <TableRow>
            <TableHead className="w-14"></TableHead>
            <TableHead>Sản phẩm</TableHead>
            <TableHead>SKU</TableHead>
            <TableHead className="text-right">Giá bán</TableHead>
            <TableHead className="text-right">Tồn</TableHead>
            <TableHead className="text-right">Giá vốn</TableHead>
            <TableHead className="text-right">Ngưỡng</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((v) => (
            <VariantRowItem key={v.variantId} variant={v} defaultThreshold={defaultThreshold} />
          ))}
        </TableBody>
      </Table>

      {/* Mobile: card dọc — giá vốn/ngưỡng vẫn sửa inline được (InlineMoneyCell) */}
      <div className="flex flex-col gap-2 p-3 md:hidden">
        {rows.map((v) => (
          <VariantCardItem key={v.variantId} variant={v} defaultThreshold={defaultThreshold} />
        ))}
      </div>

      <Pager page={page} total={total} />
    </div>
  );
}

function VariantCardItem({ variant, defaultThreshold }: { variant: VariantRow; defaultThreshold: number }) {
  const [imgError, setImgError] = useState(false);

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-hairline p-3">
      <div className="flex items-center gap-3">
        {variant.imageUrl && !imgError ? (
          <Image
            src={variant.imageUrl}
            alt=""
            width={40}
            height={40}
            unoptimized
            className="size-10 shrink-0 rounded-md object-cover"
            onError={() => setImgError(true)}
          />
        ) : (
          <div className="flex size-10 shrink-0 items-center justify-center rounded-md bg-surface-soft text-muted-foreground">
            <Shirt className="size-5" />
          </div>
        )}
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="truncate text-sm text-ink">{variant.productName}</span>
          <span className="flex items-center gap-1.5">
            <Badge variant="outline" className="w-fit">
              {variant.label}
            </Badge>
            <span className="font-mono text-xs text-muted-foreground">{variant.sku}</span>
          </span>
        </div>
      </div>

      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <span>Giá bán: {formatVnd(variant.sellPrice)}</span>
        <span>Tồn: {variant.stock.toLocaleString("vi-VN")}</span>
      </div>

      <div className="flex items-center justify-between gap-2">
        <span className="text-xs text-muted-foreground">Giá vốn</span>
        <InlineMoneyCell
          value={variant.costPrice}
          formatDisplay={formatVnd}
          parseInput={parseMoneyInput}
          onSave={(v) => updateVariantCost(variant.variantId, v ?? 0)}
          warn={variant.costPrice === 0}
          warnTooltip="Chưa có giá vốn — đơn chứa SKU này chưa tính được lãi"
          testId="gia-von"
        />
      </div>

      <div className="flex items-center justify-between gap-2">
        <span className="text-xs text-muted-foreground">Ngưỡng</span>
        <InlineMoneyCell
          value={variant.lowStockThreshold}
          placeholder={`${defaultThreshold} (mặc định)`}
          formatDisplay={(v) => v.toLocaleString("vi-VN")}
          parseInput={parseThresholdInput}
          onSave={(v) => updateVariantThreshold(variant.variantId, v)}
          testId="nguong"
        />
      </div>
    </div>
  );
}

function VariantRowItem({ variant, defaultThreshold }: { variant: VariantRow; defaultThreshold: number }) {
  const [imgError, setImgError] = useState(false);

  return (
    <TableRow>
      <TableCell>
        {variant.imageUrl && !imgError ? (
          <Image
            src={variant.imageUrl}
            alt=""
            width={40}
            height={40}
            unoptimized
            className="size-10 rounded-md object-cover"
            onError={() => setImgError(true)}
          />
        ) : (
          <div className="flex size-10 items-center justify-center rounded-md bg-surface-soft text-muted-foreground">
            <Shirt className="size-5" />
          </div>
        )}
      </TableCell>
      <TableCell>
        <div className="flex flex-col gap-0.5">
          <span className="text-sm text-ink">{variant.productName}</span>
          <Badge variant="outline" className="w-fit">
            {variant.label}
          </Badge>
        </div>
      </TableCell>
      <TableCell className="font-mono text-sm">{variant.sku}</TableCell>
      <TableCell className="text-right text-sm">{formatVnd(variant.sellPrice)}</TableCell>
      <TableCell className="text-right text-sm">{variant.stock.toLocaleString("vi-VN")}</TableCell>
      <TableCell className="text-right">
        <InlineMoneyCell
          value={variant.costPrice}
          formatDisplay={formatVnd}
          parseInput={parseMoneyInput}
          onSave={(v) => updateVariantCost(variant.variantId, v ?? 0)}
          warn={variant.costPrice === 0}
          warnTooltip="Chưa có giá vốn — đơn chứa SKU này chưa tính được lãi"
          testId="gia-von"
        />
      </TableCell>
      <TableCell className="text-right">
        <InlineMoneyCell
          value={variant.lowStockThreshold}
          placeholder={`${defaultThreshold} (mặc định)`}
          formatDisplay={(v) => v.toLocaleString("vi-VN")}
          parseInput={parseThresholdInput}
          onSave={(v) => updateVariantThreshold(variant.variantId, v)}
          testId="nguong"
        />
      </TableCell>
    </TableRow>
  );
}

function Pager({ page, total }: { page: number; total: number }) {
  const searchParams = useSearchParams();
  const pathname = usePathname();
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const from = total === 0 ? 0 : (page - 1) * PAGE_SIZE + 1;
  const to = Math.min(page * PAGE_SIZE, total);

  function hrefFor(p: number): string {
    const params = new URLSearchParams(searchParams);
    params.set("trang", String(p));
    return `${pathname}?${params.toString()}`;
  }

  return (
    <div className="flex items-center justify-between border-t border-hairline px-4 py-3 text-sm text-muted-foreground">
      <span>
        Hiển thị {from}–{to} / {total}
      </span>
      <div className="flex items-center gap-1">
        <Link
          href={hrefFor(Math.max(1, page - 1))}
          aria-disabled={page <= 1}
          className={cn("rounded-md px-2 py-1 hover:bg-surface-soft", page <= 1 && "pointer-events-none opacity-40")}
        >
          ‹
        </Link>
        <Link
          href={hrefFor(Math.min(totalPages, page + 1))}
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
  );
}
