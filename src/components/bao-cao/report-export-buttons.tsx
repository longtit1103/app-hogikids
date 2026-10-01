import { FileDown } from "lucide-react";

import { NutInBaoCao } from "@/components/bao-cao/nut-in-bao-cao";
import { Button, buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/** Link xuất Lãi/Lỗ của một tháng (`ky` = yyyy-MM). */
export function hrefXuatPnl(ky: string): string {
  return `/api/export/bao-cao?${new URLSearchParams({ tab: "pnl", ky }).toString()}`;
}

/**
 * Nút "Xuất Excel" = LINK tới route xuất SERVER (spec phân quyền §4.3: cổng quyền + che giá vốn áp cho
 * file y như màn hình; trình duyệt không còn dựng file từ props) + nút in (client, giữ nguyên).
 *
 * Server component CỐ Ý (không `"use client"`): chỉ nút in là client. `href` null ⇒ người xem thiếu
 * `xuat-du-lieu` (hoặc thiếu quyền của tab): không nút Excel — route vẫn tự trả 403.
 */
export function ReportExportButtons({ hasData, href }: { hasData: boolean; href: string | null }) {
  return (
    <div className="flex gap-2 print:hidden">
      {href !== null &&
        (hasData ? (
          <a href={href} download className={cn(buttonVariants({ variant: "outline", size: "sm" }))}>
            <FileDown className="size-4" />
            Xuất Excel
          </a>
        ) : (
          <Button type="button" variant="outline" size="sm" disabled>
            <FileDown className="size-4" />
            Xuất Excel
          </Button>
        ))}
      <NutInBaoCao hasData={hasData} />
    </div>
  );
}
