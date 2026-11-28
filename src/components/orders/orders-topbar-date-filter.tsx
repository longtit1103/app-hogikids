"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { format } from "date-fns";

import { DATE_RANGE_PRESETS, DateRangePresetTabs } from "@/components/shell/date-range-preset-tabs";
import { thamSoDauTienTuUrl } from "@/lib/chuan-hoa-search-params";
import { resolveRangePreset, type RangePreset } from "@/lib/date-range";
import { docThamSoDonHang, hrefDonHang } from "@/lib/orders/doc-tham-so-don-hang";

const ORDERS_PATH = "/don-hang";
const NGAY_URL = "yyyy-MM-dd";
/** Bộ chọn kỳ chỉ cần `ky` — quyền giá vốn không ảnh hưởng phần đó của bộ đọc URL. */
const KHONG_XET_QUYEN = { coQuyenGiaVon: false } as const;

/**
 * Bộ lọc ngày của /don-hang, render TRONG topbar (cùng dòng nút "Đồng bộ ngay")
 * để đồng bộ vị trí với picker toàn cục ở Dashboard/Tài chính. Tự ẩn ngoài
 * /don-hang. CỐ Ý KHÔNG dùng provider toàn cục (`?range=`/cookie lựa chọn đã lưu): trang
 * Đơn hàng đọc URL `ngay_tu`/`ngay_den` cho server query + hợp đồng drill P&L
 * (`pnl-drill-href.ts`) — đổi param scheme sẽ phá 2 thứ đó.
 *
 * Kỳ đọc bằng CÙNG bộ đọc URL với server (`docThamSoDonHang`): không có ngày hợp lệ ⇒ Tháng này (tab
 * "Tháng này" sáng); `ky=tat_ca` ⇒ không tab nào sáng. Bấm lại tab đang sáng ⇒ tất cả thời gian. Mọi
 * link dựng qua `hrefDonHang` nên đặt ngày tự bỏ `ky` + `trang`, đặt `ky` tự bỏ hai ngày.
 */
export function OrdersTopbarDateFilter() {
  const pathname = usePathname();
  const router = useRouter();
  const searchParams = useSearchParams();

  if (pathname !== ORDERS_PATH) {
    return null;
  }

  // Tham số lặp: giá trị ĐẦU, cùng luật server (`chuanHoaSearchParams`) — tab sáng đúng kỳ danh sách đang tính.
  const sp = thamSoDauTienTuUrl(searchParams);
  const now = new Date();
  const { ky } = docThamSoDonHang(sp, KHONG_XET_QUYEN, now);
  const range = ky.loai === "khoang" ? { from: ky.from, to: ky.to } : null;
  // Tab sáng: kỳ khớp đúng ngày (yyyy-MM-dd) của preset nào → tab đó; có kỳ mà không khớp → "Tùy chọn".
  const ngay = (d: Date) => format(d, NGAY_URL);
  const activePreset: RangePreset | "custom" | null = range
    ? (DATE_RANGE_PRESETS.find((p) => {
        const r = resolveRangePreset(p.value, now);
        return ngay(r.from) === ngay(range.from) && ngay(r.to) === ngay(range.to);
      })?.value ?? "custom")
    : null;

  function dieuHuong(href: string) {
    router.replace(href);
  }

  function datNgay(r: { from: Date; to: Date }) {
    dieuHuong(hrefDonHang(sp, { ngay_tu: ngay(r.from), ngay_den: ngay(r.to) }));
  }

  function applyPreset(preset: RangePreset) {
    // Bấm lại tab đang sáng = "tất cả thời gian" (khớp kiểu bật/tắt của chip lọc); picker toàn cục
    // không có trạng thái này.
    if (preset === activePreset) {
      dieuHuong(hrefDonHang(sp, { ky: "tat_ca" }));
      return;
    }
    datNgay(resolveRangePreset(preset, now));
  }

  return (
    <DateRangePresetTabs
      presets={DATE_RANGE_PRESETS}
      activePreset={activePreset}
      range={range}
      onSelectPreset={applyPreset}
      onApplyCustomRange={datNgay}
    />
  );
}
