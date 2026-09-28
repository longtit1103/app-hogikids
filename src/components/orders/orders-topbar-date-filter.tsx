"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { format } from "date-fns";

import { DATE_RANGE_PRESETS, DateRangePresetTabs } from "@/components/shell/date-range-preset-tabs";
import { parseDateRange, resolveRangePreset, type RangePreset } from "@/lib/date-range";

const ORDERS_PATH = "/don-hang";

/**
 * Bộ lọc ngày của /don-hang, render TRONG topbar (cùng dòng nút "Đồng bộ ngay")
 * để đồng bộ vị trí với picker toàn cục ở Dashboard/Tài chính. Tự ẩn ngoài
 * /don-hang. CỐ Ý KHÔNG dùng provider toàn cục (`?range=`/localStorage): trang
 * Đơn hàng đọc URL `ngay_tu`/`ngay_den` cho server query + hợp đồng drill P&L
 * (`pnl-drill-href.ts`) — đổi param scheme sẽ phá 2 thứ đó.
 */
export function OrdersTopbarDateFilter() {
  const pathname = usePathname();
  const router = useRouter();
  const searchParams = useSearchParams();

  if (pathname !== ORDERS_PATH) {
    return null;
  }

  const ngayTu = searchParams.get("ngay_tu");
  const ngayDen = searchParams.get("ngay_den");
  // Range đang áp (null khi thiếu/hỏng — server bỏ lọc y hệt qua parseDateRange).
  const appliedRange = parseDateRange({ tu: ngayTu ?? undefined, den: ngayDen ?? undefined });
  // Tab sáng: URL khớp đúng yyyy-MM-dd của preset nào → sáng tab đó; có range mà
  // không khớp preset → "Tùy chọn"; không lọc ngày → không tab nào sáng.
  const activePreset: RangePreset | "custom" | null = appliedRange
    ? (DATE_RANGE_PRESETS.find((p) => {
        const r = resolveRangePreset(p.value);
        return format(r.from, "yyyy-MM-dd") === ngayTu && format(r.to, "yyyy-MM-dd") === ngayDen;
      })?.value ?? "custom")
    : null;

  function setDates(tu: string | undefined, den: string | undefined) {
    const params = new URLSearchParams(searchParams);
    if (tu) params.set("ngay_tu", tu);
    else params.delete("ngay_tu");
    if (den) params.set("ngay_den", den);
    else params.delete("ngay_den");
    params.delete("trang"); // đổi lọc → về trang 1
    const qs = params.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname);
  }

  function applyPreset(preset: RangePreset) {
    // Bấm lại tab đang sáng = bỏ lọc ngày (về "tất cả thời gian") — khớp toggle
    // của filter Kênh/Trạng thái; picker toàn cục không có trạng thái này.
    if (preset === activePreset) {
      setDates(undefined, undefined);
      return;
    }
    const range = resolveRangePreset(preset);
    setDates(format(range.from, "yyyy-MM-dd"), format(range.to, "yyyy-MM-dd"));
  }

  return (
    <DateRangePresetTabs
      presets={DATE_RANGE_PRESETS}
      activePreset={activePreset}
      range={appliedRange}
      onSelectPreset={applyPreset}
      onApplyCustomRange={(r) => setDates(format(r.from, "yyyy-MM-dd"), format(r.to, "yyyy-MM-dd"))}
    />
  );
}
