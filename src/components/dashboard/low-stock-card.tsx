import Link from "next/link";

import { Badge } from "@/components/ui/badge";
import type { LowStockPreviewRow } from "@/lib/queries/variants";

/**
 * Cảnh báo tồn kho thấp — 5 biến thể tồn ≤ ngưỡng (thấp nhất trước) + badge
 * tổng số đang cảnh báo. Server component thuần hiển thị; dữ liệu tới từ
 * `getLowStockPreview()` (`src/lib/queries/variants.ts`, tái dùng predicate
 * ngưỡng phase 3 — không viết lại SQL ở đây).
 */
export function LowStockCard({ rows, total }: { rows: LowStockPreviewRow[]; total: number }) {
  return (
    <div className="rounded-xl bg-surface-card p-4">
      <div className="flex items-center justify-between gap-2">
        <h3 className="font-serif text-lg text-ink">Cảnh báo tồn kho thấp</h3>
        {total > 0 && <Badge className="bg-warning/20 text-ink">{total}</Badge>}
      </div>

      {rows.length === 0 ? (
        <p className="mt-4 py-6 text-center text-sm text-success">✓ Tồn kho ổn định — không SKU nào dưới ngưỡng</p>
      ) : (
        <>
          <div className="mt-3 flex flex-col gap-1">
            {rows.map((v) => (
              <Link
                key={v.variantId}
                href="/ton-kho?loc=sap_het"
                className="flex items-center justify-between gap-2 rounded-lg px-2 py-1.5 transition-colors hover:bg-surface-soft"
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm text-ink">
                    {v.productName} — {v.label}
                  </span>
                  <span className="font-mono text-xs text-muted-foreground">{v.sku}</span>
                </span>
                {v.stock === 0 ? (
                  <Badge className="shrink-0 bg-error text-white">Hết hàng</Badge>
                ) : (
                  <Badge className="shrink-0 bg-warning/20 text-ink">Còn {v.stock.toLocaleString("vi-VN")}</Badge>
                )}
              </Link>
            ))}
          </div>
          <Link href="/ton-kho?loc=sap_het" className="mt-3 inline-block text-xs text-primary hover:underline">
            Xem tất cả ({total})
          </Link>
        </>
      )}
    </div>
  );
}
