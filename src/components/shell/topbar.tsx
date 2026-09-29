"use client";

import { usePathname } from "next/navigation";

import { OrdersTopbarDateFilter } from "@/components/orders/orders-topbar-date-filter";
import { DateRangePicker } from "./date-range-picker";
import { getPageTitle } from "./nav-config";
import { SyncNowButton } from "./sync-now-button";

export function Topbar() {
  const pathname = usePathname();
  const title = getPageTitle(pathname);

  return (
    // Dưới xl: 2 hàng — tiêu đề + đồng bộ ở hàng 1, bộ chọn kỳ tụt xuống hàng 2 cuộn ngang toàn
    // bề rộng (design-spec "date-range picker tụt xuống thành hàng tab cuộn ngang ngay dưới top bar").
    // Nút ☰ đã bỏ 26/09 — tab "Thêm" của thanh tab dưới thay nó.
    // Một hàng cao 64px CHỈ từ xl (1280px): md–xl có sidebar 240px, cột nội dung còn ~480–990px
    // không đủ cho tiêu đề + 7 nút chọn kỳ + trạng thái + nút đồng bộ ⇒ trước 26/09 hàng này làm
    // TRÀN NGANG cả trang ở 768–1279px (bắt được bởi smoke xoay ngang iPhone 844px).
    <header className="flex flex-wrap items-center gap-3 border-b border-hairline bg-canvas px-4 py-3 md:px-6 xl:h-16 xl:flex-nowrap xl:py-0">
      <div className="flex min-w-0 flex-1 items-center gap-3">
        <h1 className="truncate font-serif text-2xl tracking-tight text-ink">{title}</h1>
      </div>

      {/* Cùng ô: chỉ 1 trong 2 hiện theo route (picker toàn cục tự ẩn ngoài
          Dashboard/Tài chính/Kênh/Báo cáo; bộ lọc Đơn hàng chỉ hiện ở /don-hang). */}
      <div className="order-3 w-full xl:order-none xl:w-auto">
        <DateRangePicker />
        <OrdersTopbarDateFilter />
      </div>

      <SyncNowButton trongTopbar />
    </header>
  );
}
