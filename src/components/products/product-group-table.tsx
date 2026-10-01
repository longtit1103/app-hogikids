"use client";

import { useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { ChevronRight, Shirt } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  updateProductCost,
  updateProductThreshold,
  updateVariantCost,
  updateVariantThreshold,
} from "@/lib/actions/cost-price";
import { formatVnd } from "@/lib/format";
import type { KetQuaChe } from "@/lib/queries/che-gia-von-types";
import type { ProductRow, ProductRowChe, ProductVariantRowChe } from "@/lib/queries/products";
import { cn } from "@/lib/utils";
import { InlineMoneyCell } from "./inline-money-cell";
import { ProductApplyCell } from "./product-apply-cell";

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

/**
 * Phần giá vốn của một sản phẩm — null ở nhánh che (người thiếu `gia-von-loi-nhuan:xem`: server không
 * gửi giá vốn nào, bảng không có cột giá vốn). `sua` = được sửa giá vốn (`san-pham:sua` ∧ giá vốn).
 */
type GiaVonSp = {
  uniformCost: number | null;
  hasMissingCost: boolean;
  theoBienThe: Record<string, number>;
  sua: boolean;
};

type BangSanPham = KetQuaChe<{ products: ProductRow[]; suaGiaVon: boolean }, { products: ProductRowChe[] }>;

/** Narrow union MỘT lần: dòng hiển thị (trường không nhạy cảm) + phần giá vốn tách riêng. */
function ghepGiaVon(bang: BangSanPham): { product: ProductRowChe; giaVon: GiaVonSp | null }[] {
  if (!bang.coQuyenGiaVon) return bang.products.map((product) => ({ product, giaVon: null }));
  return bang.products.map((product) => ({
    product,
    giaVon: {
      uniformCost: product.uniformCost,
      hasMissingCost: product.hasMissingCost,
      theoBienThe: Object.fromEntries(product.variants.map((v) => [v.variantId, v.costPrice])),
      sua: bang.suaGiaVon,
    },
  }));
}

function priceRangeLabel(p: ProductRowChe): string {
  if (p.variantCount === 0) return "—";
  return p.sellPriceMin === p.sellPriceMax
    ? formatVnd(p.sellPriceMin)
    : `${formatVnd(p.sellPriceMin)} – ${formatVnd(p.sellPriceMax)}`;
}

export function ProductGroupTable({
  bang,
  suaNguong,
  total,
  page,
  defaultThreshold,
}: {
  bang: BangSanPham;
  /** `san-pham:sua` — thiếu thì ô ngưỡng chỉ hiển thị (action cũng tự từ chối). */
  suaNguong: boolean;
  total: number;
  page: number;
  defaultThreshold: number;
}) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const dong = ghepGiaVon(bang);

  function toggle(productId: string) {
    setExpanded((prev) => ({ ...prev, [productId]: !prev[productId] }));
  }

  return (
    <div className="overflow-x-auto rounded-xl border border-hairline">
      <Table className="min-w-[880px]">
        <TableHeader>
          <TableRow>
            <TableHead className="w-8"></TableHead>
            <TableHead>Sản phẩm</TableHead>
            <TableHead className="text-center">Số biến thể</TableHead>
            <TableHead className="text-right">Giá bán</TableHead>
            <TableHead className="text-right">Tổng tồn</TableHead>
            {bang.coQuyenGiaVon && (
              <TableHead className="bg-primary/5 text-right">
                {bang.suaGiaVon ? "Giá vốn (áp cho tất cả)" : "Giá vốn"}
              </TableHead>
            )}
            <TableHead className="text-right">Ngưỡng</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {dong.map(({ product: p, giaVon }) => (
            <ProductRowGroup
              key={p.productId}
              product={p}
              giaVon={giaVon}
              suaNguong={suaNguong}
              defaultThreshold={defaultThreshold}
              isExpanded={!!expanded[p.productId]}
              onToggle={() => toggle(p.productId)}
            />
          ))}
        </TableBody>
      </Table>

      <Pager page={page} total={total} />
    </div>
  );
}

function ProductRowGroup({
  product,
  giaVon,
  suaNguong,
  defaultThreshold,
  isExpanded,
  onToggle,
}: {
  product: ProductRowChe;
  giaVon: GiaVonSp | null;
  suaNguong: boolean;
  defaultThreshold: number;
  isExpanded: boolean;
  onToggle: () => void;
}) {
  const [imgError, setImgError] = useState(false);
  const { variants } = product;

  // Giá vốn cấp SP: 0 coi như trống (hiện placeholder + warn); lệch nhau → "Nhiều mức".
  const costMixed = giaVon !== null && giaVon.uniformCost === null && product.variantCount > 1;
  const costValue = giaVon?.uniformCost && giaVon.uniformCost > 0 ? giaVon.uniformCost : null;

  // Ngưỡng cấp SP: đồng nhất (kể cả cùng null=mặc định) hay lệch nhau.
  const thr0 = variants[0]?.lowStockThreshold ?? null;
  const thrAllSame = variants.length > 0 && variants.every((v) => (v.lowStockThreshold ?? null) === thr0);
  const thrValue = thrAllSame ? thr0 : null;
  const thrMixed = !thrAllSame && product.variantCount > 1;

  // Chỉ hỏi confirm khi mẫu có NHIỀU biến thể (ghi đè hàng loạt mới cần cảnh báo); 1 biến thể =
  // sửa trực tiếp, không bung confirm.
  function costConfirm(next: number | null): string | null {
    if (variants.length <= 1) return null;
    const n = variants.filter((v) => {
      const cost = giaVon?.theoBienThe[v.variantId] ?? 0;
      return cost > 0 && cost !== next;
    }).length;
    return n > 0 ? `Ghi đè giá vốn của ${n} biến thể đang có giá khác?` : null;
  }
  function thrConfirm(next: number | null): string | null {
    if (variants.length <= 1) return null;
    const n = variants.filter((v) => v.lowStockThreshold !== null && v.lowStockThreshold !== next).length;
    return n > 0 ? `Ghi đè ngưỡng riêng của ${n} biến thể?` : null;
  }

  return (
    <>
      <TableRow data-testid="product-row">
        <TableCell>
          <button
            type="button"
            onClick={onToggle}
            aria-label={isExpanded ? "Thu gọn biến thể" : "Xem biến thể"}
            aria-expanded={isExpanded}
            className="flex size-6 items-center justify-center rounded-md text-muted-foreground hover:bg-surface-soft hover:text-ink"
          >
            <ChevronRight className={cn("size-4 transition-transform", isExpanded && "rotate-90")} />
          </button>
        </TableCell>

        <TableCell>
          <div className="flex items-center gap-3">
            {product.imageUrl && !imgError ? (
              <Image
                src={product.imageUrl}
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
              <span className="max-w-[220px] truncate text-sm text-ink sm:max-w-[340px] lg:max-w-[520px]">
                {product.name}
              </span>
              {product.categoryName && (
                <Badge variant="outline" className="w-fit">
                  {product.categoryName}
                </Badge>
              )}
            </div>
          </div>
        </TableCell>

        <TableCell className="text-center text-sm text-muted-foreground">
          {product.variantCount} biến thể
        </TableCell>

        <TableCell className="text-right text-sm">{priceRangeLabel(product)}</TableCell>

        <TableCell className="text-right">
          <StockCell isOutOfStock={product.isOutOfStock} isLow={product.isLow} totalStock={product.totalStock} />
        </TableCell>

        {giaVon && (
          <TableCell className="text-right">
            {giaVon.sua ? (
              <ProductApplyCell
                value={costValue}
                isMixed={costMixed}
                placeholder="Nhập giá vốn"
                mixedLabel="Nhiều mức"
                formatDisplay={formatVnd}
                parseInput={parseMoneyInput}
                getConfirmMessage={costConfirm}
                onApply={(v) => updateProductCost(product.productId, v ?? 0)}
                warn={giaVon.hasMissingCost}
                warnTooltip="Có biến thể chưa có giá vốn — đơn chứa SKU này chưa tính được lãi"
                testId="gia-von-sp"
              />
            ) : (
              <ChiXem text={costMixed ? "Nhiều mức" : costValue === null ? "—" : formatVnd(costValue)} testId="gia-von-sp" />
            )}
          </TableCell>
        )}

        <TableCell className="text-right">
          {suaNguong ? (
            <ProductApplyCell
              value={thrValue}
              isMixed={thrMixed}
              placeholder={`${defaultThreshold} (mặc định)`}
              mixedLabel="Nhiều mức"
              formatDisplay={(v) => v.toLocaleString("vi-VN")}
              parseInput={parseThresholdInput}
              getConfirmMessage={thrConfirm}
              onApply={(v) => updateProductThreshold(product.productId, v)}
              testId="nguong-sp"
            />
          ) : (
            <ChiXem
              text={thrMixed ? "Nhiều mức" : thrValue === null ? `${defaultThreshold} (mặc định)` : thrValue.toLocaleString("vi-VN")}
              testId="nguong-sp"
            />
          )}
        </TableCell>
      </TableRow>

      {isExpanded && (
        <TableRow className="hover:bg-transparent">
          <TableCell colSpan={giaVon ? 7 : 6} className="bg-surface-soft/40 p-0">
            <VariantSubTable variants={variants} giaVon={giaVon} suaNguong={suaNguong} defaultThreshold={defaultThreshold} />
          </TableCell>
        </TableRow>
      )}
    </>
  );
}

/** Ô chỉ hiển thị (không có quyền sửa) — cùng `data-testid` với ô sửa để e2e đọc được giá trị. */
function ChiXem({ text, testId }: { text: string; testId: string }) {
  return (
    <span data-testid={testId} className="text-sm text-muted-foreground">
      {text}
    </span>
  );
}

function StockCell({
  isOutOfStock,
  isLow,
  totalStock,
}: {
  isOutOfStock: boolean;
  isLow: boolean;
  totalStock: number;
}) {
  if (isOutOfStock) {
    return (
      <span className="inline-flex items-center rounded-full bg-error px-2 py-0.5 text-xs font-medium text-on-dark">
        Hết hàng
      </span>
    );
  }
  return (
    <span className="inline-flex items-center justify-end gap-1.5">
      <span className="font-mono text-sm">{totalStock.toLocaleString("vi-VN")}</span>
      {isLow && (
        <span className="inline-flex items-center rounded-full bg-warning/15 px-2 py-0.5 text-xs font-medium text-warning">
          Sắp hết
        </span>
      )}
    </span>
  );
}

/** Sub-bảng biến thể khi mở rộng — sửa giá vốn/ngưỡng RIÊNG từng SKU (ngoại lệ). */
function VariantSubTable({
  variants,
  giaVon,
  suaNguong,
  defaultThreshold,
}: {
  variants: ProductVariantRowChe[];
  giaVon: GiaVonSp | null;
  suaNguong: boolean;
  defaultThreshold: number;
}) {
  return (
    <div className="px-3 py-2">
      <table className="w-full">
        <thead>
          <tr className="text-xs text-muted-foreground">
            <th className="py-1 pr-3 text-left font-medium">SKU</th>
            <th className="py-1 pr-3 text-left font-medium">Biến thể</th>
            <th className="py-1 pr-3 text-right font-medium">Tồn</th>
            {giaVon && <th className="py-1 pr-3 text-right font-medium">Giá vốn</th>}
            <th className="py-1 text-right font-medium">Ngưỡng</th>
          </tr>
        </thead>
        <tbody>
          {variants.map((v) => {
            const cost = giaVon?.theoBienThe[v.variantId] ?? 0;
            return (
            <tr key={v.variantId} data-testid="variant-row" className="border-t border-hairline/60">
              <td className="py-1.5 pr-3 font-mono text-xs text-muted-foreground">{v.sku}</td>
              <td className="py-1.5 pr-3">
                <Badge variant="outline" className="w-fit">
                  {v.label}
                </Badge>
              </td>
              <td className="py-1.5 pr-3 text-right text-sm">
                <span className={cn("font-mono", v.isLow && "text-warning")}>
                  {v.stock.toLocaleString("vi-VN")}
                </span>
              </td>
              {giaVon && (
                <td className="py-1.5 pr-3 text-right">
                  {giaVon.sua ? (
                    <InlineMoneyCell
                      value={cost}
                      formatDisplay={formatVnd}
                      parseInput={parseMoneyInput}
                      onSave={(val) => updateVariantCost(v.variantId, val ?? 0)}
                      warn={cost === 0}
                      warnTooltip="Chưa có giá vốn — đơn chứa SKU này chưa tính được lãi"
                      testId="gia-von"
                    />
                  ) : (
                    <ChiXem text={cost === 0 ? "—" : formatVnd(cost)} testId="gia-von" />
                  )}
                </td>
              )}
              <td className="py-1.5 text-right">
                {suaNguong ? (
                  <InlineMoneyCell
                    value={v.lowStockThreshold}
                    placeholder={`${defaultThreshold} (mặc định)`}
                    formatDisplay={(val) => val.toLocaleString("vi-VN")}
                    parseInput={parseThresholdInput}
                    onSave={(val) => updateVariantThreshold(v.variantId, val)}
                    testId="nguong"
                  />
                ) : (
                  <ChiXem
                    text={v.lowStockThreshold === null ? `${defaultThreshold} (mặc định)` : v.lowStockThreshold.toLocaleString("vi-VN")}
                    testId="nguong"
                  />
                )}
              </td>
            </tr>
            );
          })}
        </tbody>
      </table>
    </div>
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
        Hiển thị {from}–{to} / {total} sản phẩm
      </span>
      <div className="flex items-center gap-1">
        <Link
          href={hrefFor(Math.max(1, page - 1))}
          aria-label="Trang trước"
          aria-disabled={page <= 1}
          className={cn("rounded-md px-2 py-1 hover:bg-surface-soft", page <= 1 && "pointer-events-none opacity-40")}
        >
          ‹
        </Link>
        <Link
          href={hrefFor(Math.min(totalPages, page + 1))}
          aria-label="Trang sau"
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
