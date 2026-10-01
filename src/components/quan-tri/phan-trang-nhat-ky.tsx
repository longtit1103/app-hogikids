import Link from "next/link";

import { cn } from "@/lib/utils";

/** Thanh phân trang của nhật ký — server component thuần, `hrefTrang(n)` do trang dựng (giữ bộ lọc). */
export function PhanTrangNhatKy({
  trang,
  tongTrang,
  tong,
  hrefTrang,
}: {
  trang: number;
  tongTrang: number;
  tong: number;
  hrefTrang: (n: number) => string;
}) {
  if (tongTrang <= 1) {
    return <p className="mt-2 text-xs text-muted-foreground">{tong} dòng nhật ký</p>;
  }
  return (
    <div className="mt-2 flex items-center justify-between gap-2 text-xs text-muted-foreground">
      <p>
        {tong} dòng · Trang {trang}/{tongTrang}
      </p>
      <div className="flex items-center gap-1">
        <Link
          href={hrefTrang(Math.max(1, trang - 1))}
          aria-label="Trang trước"
          aria-disabled={trang <= 1}
          className={cn("rounded-md border border-hairline px-2 py-1 hover:bg-surface-soft", trang <= 1 && "pointer-events-none opacity-40")}
        >
          ‹
        </Link>
        <Link
          href={hrefTrang(Math.min(tongTrang, trang + 1))}
          aria-label="Trang sau"
          aria-disabled={trang >= tongTrang}
          className={cn("rounded-md border border-hairline px-2 py-1 hover:bg-surface-soft", trang >= tongTrang && "pointer-events-none opacity-40")}
        >
          ›
        </Link>
      </div>
    </div>
  );
}
