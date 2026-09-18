import Link from "next/link";

import { cn } from "@/lib/utils";

/**
 * Thanh 5 tab của `/marketing` — khuôn `?tab=` của `/tai-chinh` (không đẻ cơ chế điều hướng mới).
 * Tách khỏi page.tsx vì `hrefTabMarketing` là hàm THUẦN và là chỗ duy nhất giữ luật "chuyển tab
 * giữ kỳ" — luật đó phải test được mà không dựng cả trang.
 */

export type MarketingTab = "tong-quan" | "noi-dung" | "creator" | "quang-cao" | "san-pham";

export type KyTrenUrl = { tu?: string; den?: string; range?: string };

const TAB_ITEMS: { key: MarketingTab; label: string }[] = [
  { key: "tong-quan", label: "Tổng quan" },
  { key: "noi-dung", label: "Nội dung" },
  { key: "creator", label: "Creator" },
  { key: "quang-cao", label: "Quảng cáo" },
  { key: "san-pham", label: "Sản phẩm" },
];

export function isMarketingTab(v: string | undefined): v is MarketingTab {
  return TAB_ITEMS.some((t) => t.key === v);
}

/**
 * Chuyển tab GIỮ kỳ đang xem. `tu`/`den` chỉ được ghi khi có ĐỦ CẶP: provider chỉ đặt cặp này ở chế
 * độ "Tùy chọn", và `resolveRangeFromParams` bỏ qua nửa khoảng rồi rơi về mặc định — ghi nửa khoảng
 * là đổi kỳ trong im lặng.
 */
export function hrefTabMarketing(target: MarketingTab, sp: KyTrenUrl): string {
  const p = new URLSearchParams();
  if (target !== "tong-quan") p.set("tab", target);
  if (sp.tu && sp.den) {
    p.set("tu", sp.tu);
    p.set("den", sp.den);
  } else if (sp.range) {
    p.set("range", sp.range);
  }
  const qs = p.toString();
  return qs ? `/marketing?${qs}` : "/marketing";
}

export function MarketingTabNav({ tab, sp }: { tab: MarketingTab; sp: KyTrenUrl }) {
  return (
    <nav className="flex gap-1 overflow-x-auto rounded-lg bg-surface-soft p-1" aria-label="Lăng kính marketing">
      {TAB_ITEMS.map((t) => (
        <Link
          key={t.key}
          href={hrefTabMarketing(t.key, sp)}
          className={cn(
            "shrink-0 rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
            tab === t.key ? "bg-canvas text-ink shadow-sm" : "text-muted-foreground hover:text-ink"
          )}
        >
          {t.label}
        </Link>
      ))}
    </nav>
  );
}
