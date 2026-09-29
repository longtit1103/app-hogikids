import Link from "next/link";

import { formatVnd } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { VariantKpi } from "@/lib/queries/variants";

function Card({
  label,
  value,
  valueClassName,
  caption,
  href,
  dark,
  className,
}: {
  label: string;
  value: string;
  valueClassName?: string;
  caption?: React.ReactNode;
  href?: string;
  dark?: boolean;
  /** Class ô lưới (vd `col-span-2`) — đặt lên phần tử NGOÀI CÙNG (Link khi có href). */
  className?: string;
}) {
  const body = (
    <div
      className={cn(
        dark ? "rounded-xl bg-surface-dark p-4 text-on-dark" : "rounded-xl border border-hairline bg-canvas p-4",
        !href && className,
      )}
    >
      <p className={dark ? "text-sm text-on-dark/70" : "text-sm text-muted-foreground"}>{label}</p>
      <p className={`mt-1 font-serif text-2xl ${dark ? "text-on-dark" : "text-ink"} ${valueClassName ?? ""}`}>
        {value}
      </p>
      {caption && <p className={`mt-1 text-xs ${dark ? "text-on-dark/70" : "text-muted-foreground"}`}>{caption}</p>}
    </div>
  );
  return href ? (
    <Link href={href} className={cn("block", className)}>
      {body}
    </Link>
  ) : (
    body
  );
}

export function InventoryKpiCards({ kpi }: { kpi: VariantKpi }) {
  return (
    // Mobile 2 cột: số đếm 1 cột, số tiền / thẻ dài chiếm đủ 2 cột (ảnh iPhone 26/09: 4 thẻ cao
    // xếp một cột cho 4 con số ngắn). Thứ tự DOM giữ nguyên = thứ tự nhìn.
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      <Card label="Tổng SKU" value={kpi.totalSku.toLocaleString("vi-VN")} />
      <Card label="Tổng tồn" value={`${kpi.totalStock.toLocaleString("vi-VN")} cái`} />
      <Card
        label="GIÁ TRỊ VỐN TỒN"
        value={formatVnd(kpi.stockValue)}
        dark
        className="col-span-2 sm:col-span-1"
        caption={
          kpi.skusWithoutCostInValue > 0 ? (
            <Link href="/san-pham?loc=thieu_gia_von" className="hover:underline">
              * {kpi.skusWithoutCostInValue} SKU chưa có giá vốn
            </Link>
          ) : undefined
        }
      />
      <Card
        label="SKU dưới ngưỡng"
        value={kpi.lowCount.toLocaleString("vi-VN")}
        valueClassName="text-warning"
        href="?loc=sap_het"
        className="col-span-2 sm:col-span-1"
      />
    </div>
  );
}
