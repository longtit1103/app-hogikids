"use client";

import { usePathname } from "next/navigation";
import { Menu } from "lucide-react";

import { OrdersTopbarDateFilter } from "@/components/orders/orders-topbar-date-filter";
import { Button } from "@/components/ui/button";
import { DateRangePicker } from "./date-range-picker";
import { getPageTitle } from "./nav-config";
import { SyncNowButton } from "./sync-now-button";

export function Topbar({ onOpenMobileNav }: { onOpenMobileNav: () => void }) {
  const pathname = usePathname();
  const title = getPageTitle(pathname);

  return (
    // Mobile: wraps to 2 rows — hamburger/title + sync on row 1, the
    // date-range picker dropped to its own full-width scrollable row 2
    // (matches design-spec "date-range picker tụt xuống thành hàng tab cuộn
    // ngang ngay dưới top bar"). Desktop (md:): single 64px-tall row, no wrap.
    <header className="flex flex-wrap items-center gap-3 border-b border-hairline bg-canvas px-4 py-3 md:h-16 md:flex-nowrap md:px-6 md:py-0">
      <div className="flex min-w-0 flex-1 items-center gap-3">
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="md:hidden"
          onClick={onOpenMobileNav}
          aria-label="Mở menu điều hướng"
        >
          <Menu className="size-5" />
        </Button>
        <h1 className="truncate font-serif text-2xl tracking-tight text-ink">{title}</h1>
      </div>

      {/* Cùng ô: chỉ 1 trong 2 hiện theo route (picker toàn cục tự ẩn ngoài
          Dashboard/Tài chính/Kênh/Báo cáo; bộ lọc Đơn hàng chỉ hiện ở /don-hang). */}
      <div className="order-3 w-full md:order-none md:w-auto">
        <DateRangePicker />
        <OrdersTopbarDateFilter />
      </div>

      <SyncNowButton />
    </header>
  );
}
