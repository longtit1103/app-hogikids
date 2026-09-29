import Link from "next/link";

import { formatVnd } from "@/lib/format";
import type { ProductKpi } from "@/lib/queries/products";
import { cn } from "@/lib/utils";

function KpiCard({
  label,
  value,
  valueClassName,
  caption,
  captionClassName,
  href,
  dark,
}: {
  label: string;
  value: string;
  valueClassName?: string;
  caption?: React.ReactNode;
  captionClassName?: string;
  href?: string;
  dark?: boolean;
}) {
  const body = (
    <div
      className={cn(
        "rounded-xl border p-4",
        dark ? "border-transparent bg-surface-dark" : "border-hairline bg-canvas",
      )}
    >
      <p className={cn("text-sm", dark ? "text-on-dark/70" : "text-muted-foreground")}>{label}</p>
      <p className={cn("mt-1 font-serif text-2xl", dark ? "text-on-dark" : "text-ink", valueClassName)}>{value}</p>
      {caption && <p className={cn("mt-1 text-xs text-muted-foreground", captionClassName)}>{caption}</p>}
    </div>
  );
  return href ? (
    <Link href={href} className="transition-shadow hover:shadow-sm">
      {body}
    </Link>
  ) : (
    body
  );
}

export function ProductKpiCards({ kpi }: { kpi: ProductKpi }) {
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
      {/* Số SKU vốn nằm ở dòng mô tả tiêu đề trang — tiêu đề ẩn dưới md (PageTitle) nên giữ lại
          ở đây, CHỈ mobile (máy tính đã có ở tiêu đề; `md:hidden` trên chính <p> để khỏi dư khoảng).
          `print:hidden`: bản in dùng PageTitle (`print:flex`) đã có "x sản phẩm · y SKU" — thiếu dấu
          này thì bản in thừa dòng "y SKU" lặp lại (PageTitle + thẻ này cùng hiện khi in). */}
      <KpiCard
        label="Tổng sản phẩm"
        value={kpi.totalProducts.toLocaleString("vi-VN")}
        caption={`${kpi.totalVariants.toLocaleString("vi-VN")} SKU`}
        captionClassName="md:hidden print:hidden"
      />
      <KpiCard
        label="Thiếu giá vốn"
        value={kpi.missingCostProducts.toLocaleString("vi-VN")}
        valueClassName="text-warning"
        href="?loc=thieu_gia_von"
      />
      <KpiCard
        label="Sắp hết hàng"
        value={kpi.lowStockProducts.toLocaleString("vi-VN")}
        valueClassName="text-warning"
        href="?loc=sap_het"
      />
      <KpiCard
        label="Giá trị tồn theo vốn"
        value={formatVnd(kpi.stockValue)}
        dark
        caption={
          kpi.productsWithoutCostInValue > 0 ? (
            <Link href="?loc=thieu_gia_von" className="text-warning hover:underline">
              * {kpi.productsWithoutCostInValue} sản phẩm chưa có giá vốn
            </Link>
          ) : undefined
        }
      />
    </div>
  );
}
