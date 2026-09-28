import Image from "next/image";
import Link from "next/link";
import { Shirt } from "lucide-react";

import { formatVnd } from "@/lib/format";
import type { ProductReportRow } from "@/lib/reports/product-report";

/**
 * Top 5 sản phẩm bán chạy (theo doanh thu) trong range toàn cục. Server
 * component thuần hiển thị — `page.tsx` truyền sẵn tối đa 5 dòng đã sort desc
 * bởi `computeProductReport`. Click dòng → tab Sản phẩm ở `/bao-cao` lọc đúng
 * 1 SP (route `/san-pham/{id}` KHÔNG tồn tại — không dùng).
 */
export function TopProductsCard({ products }: { products: ProductReportRow[] }) {
  return (
    <div className="rounded-xl bg-surface-card p-4">
      <h3 className="font-serif text-lg text-ink">Top 5 sản phẩm bán chạy</h3>

      {products.length === 0 ? (
        <p className="mt-4 py-6 text-center text-sm text-muted-foreground">Chưa có sản phẩm bán trong kỳ này</p>
      ) : (
        <div className="mt-3 flex flex-col gap-1">
          {products.map((p) => (
            <Link
              key={p.productId}
              href={`/bao-cao?tab=san-pham&sp=${p.productId}`}
              className="flex items-center gap-3 rounded-lg px-2 py-1.5 transition-colors hover:bg-surface-soft"
            >
              {p.imageUrl ? (
                <Image
                  src={p.imageUrl}
                  alt=""
                  width={32}
                  height={32}
                  unoptimized
                  className="size-8 shrink-0 rounded-md object-cover"
                />
              ) : (
                <div className="flex size-8 shrink-0 items-center justify-center rounded-md bg-surface-soft text-muted-foreground">
                  <Shirt className="size-4" />
                </div>
              )}
              <span className="min-w-0 flex-1 truncate text-sm text-ink">{p.name}</span>
              <span className="shrink-0 text-xs text-muted-foreground">{p.soldQty.toLocaleString("vi-VN")}</span>
              <span className="shrink-0 text-sm text-ink">{formatVnd(p.revenue)}</span>
            </Link>
          ))}
        </div>
      )}

      {products.length > 0 && (
        <Link
          href="/bao-cao?tab=san-pham"
          className="mt-3 inline-block text-xs text-primary hover:underline"
        >
          Xem báo cáo sản phẩm
        </Link>
      )}
    </div>
  );
}
