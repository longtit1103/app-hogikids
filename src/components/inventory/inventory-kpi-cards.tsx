import Link from "next/link";

import { formatVnd } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { KetQuaChe } from "@/lib/queries/che-gia-von-types";
import type { VariantKpi, VariantKpiChe } from "@/lib/queries/variants";

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

/** Thiếu quyền giá vốn ⇒ không có thẻ "Giá trị vốn tồn" (props che từ server, không phải ẩn ở đây). */
export function InventoryKpiCards({ du }: { du: KetQuaChe<{ kpi: VariantKpi }, { kpi: VariantKpiChe }> }) {
  const { kpi } = du;
  return (
    // Mobile 2 cột: số đếm 1 cột, số tiền / thẻ dài chiếm đủ 2 cột (ảnh iPhone 26/09: 4 thẻ cao
    // xếp một cột cho 4 con số ngắn). Thứ tự DOM giữ nguyên = thứ tự nhìn.
    <div className={cn("grid grid-cols-2 gap-3", du.coQuyenGiaVon ? "lg:grid-cols-4" : "lg:grid-cols-3")}>
      <Card label="Tổng SKU" value={kpi.totalSku.toLocaleString("vi-VN")} />
      <Card label="Tổng tồn" value={`${kpi.totalStock.toLocaleString("vi-VN")} cái`} />
      {du.coQuyenGiaVon && (
        <Card
          label="GIÁ TRỊ VỐN TỒN"
          value={formatVnd(du.kpi.stockValue)}
          dark
          className="col-span-2 sm:col-span-1"
          caption={
            du.kpi.skusWithoutCostInValue > 0 ? (
              <Link href="/san-pham?loc=thieu_gia_von" className="hover:underline">
                * {du.kpi.skusWithoutCostInValue} SKU chưa có giá vốn
              </Link>
            ) : undefined
          }
        />
      )}
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
