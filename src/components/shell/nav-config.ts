import type { LucideIcon } from "lucide-react";
import {
  BarChart3,
  LayoutDashboard,
  Megaphone,
  Package,
  Settings,
  ShieldCheck,
  ShoppingCart,
  TrendingUp,
  Wallet,
  Warehouse,
} from "lucide-react";

import type { Quyen } from "@/lib/quyen/danh-muc-quyen";
import type { NguoiDung } from "@/lib/quyen/nguoi-dung-phien";

export type NavItem = {
  href: string;
  label: string;
  icon: LucideIcon;
};

/**
 * The 8 primary sidebar destinations. Task 5 brief's "đủ 9 mục nav" = these 8
 * plus SETTINGS_NAV_ITEM below. Intentionally has NO badge/count fields —
 * "SKU thiếu giá vốn" and "tồn kho thấp" badges are deferred to Phase 3 and
 * must not be faked with a hardcoded placeholder here.
 */
export const NAV_ITEMS: readonly NavItem[] = [
  { href: "/", label: "Dashboard", icon: LayoutDashboard },
  { href: "/don-hang", label: "Đơn hàng", icon: ShoppingCart },
  { href: "/san-pham", label: "Sản phẩm", icon: Package },
  { href: "/ton-kho", label: "Tồn kho", icon: Warehouse },
  { href: "/tai-chinh", label: "Tài chính", icon: Wallet },
  { href: "/kenh", label: "Kênh", icon: Megaphone },
  { href: "/marketing", label: "Marketing", icon: TrendingUp },
  { href: "/bao-cao", label: "Báo cáo", icon: BarChart3 },
];

/** Pinned separately at the sidebar bottom, above the user block. */
export const SETTINGS_NAV_ITEM: NavItem = {
  href: "/cai-dat",
  label: "Cài đặt",
  icon: Settings,
};

/** Mục Quản trị tài khoản — chỉ chủ shop, ghim cạnh Cài đặt (không nằm trong 8 mục chính). */
export const QUAN_TRI_NAV_ITEM: NavItem = {
  href: "/quan-tri",
  label: "Quản trị",
  icon: ShieldCheck,
};

const ALL_NAV_ITEMS: readonly NavItem[] = [...NAV_ITEMS, SETTINGS_NAV_ITEM, QUAN_TRI_NAV_ITEM];

/**
 * Exact match for "/", prefix match for everything else — so nested routes
 * (e.g. a future `/kenh/:id`) still highlight/title their parent nav item.
 */
export function isNavItemActive(pathname: string, href: string): boolean {
  if (href === "/") {
    return pathname === "/";
  }
  return pathname === href || pathname.startsWith(`${href}/`);
}

/** Resolves the top bar's page title from the current pathname. */
export function getPageTitle(pathname: string): string {
  const match = ALL_NAV_ITEMS.find((item) => isNavItemActive(pathname, item.href));
  return match?.label ?? "HogiKids";
}

/**
 * 4 mục có tab riêng trên thanh tab dưới (mobile) — MỘT nguồn cho `BottomTabBar` và bộ lọc ngăn
 * kéo "Thêm" (ngăn kéo chỉ liệt kê mục KHÔNG có ở đây). Chủ shop chốt 26/09 từ ảnh iPhone thật.
 */
export const TAB_CHINH_HREFS: readonly string[] = ["/", "/tai-chinh", "/don-hang", "/ton-kho"];

export const TAB_CHINH_ITEMS: readonly NavItem[] = TAB_CHINH_HREFS.map((href) => {
  const item = NAV_ITEMS.find((i) => i.href === href);
  if (!item) throw new Error(`TAB_CHINH_HREFS có ${href} không nằm trong NAV_ITEMS`);
  return item;
});

/** Route hiện tại thuộc một trong 4 tab chính? Không ⇒ tab "Thêm" active. */
export function laTrangTabChinh(pathname: string): boolean {
  return TAB_CHINH_HREFS.some((href) => isNavItemActive(pathname, href));
}

/**
 * Quyền cần để thấy từng mục menu: mảng = có ÍT NHẤT MỘT; `chuShop` = chỉ OWNER. Khớp đúng cổng
 * trang của từng route (menu chỉ là tiện lợi — bảo vệ thật nằm ở cổng trang/action).
 */
export const QUYEN_THEO_HREF: Record<string, { quyen?: readonly Quyen[]; chuShop?: true }> = {
  "/": { quyen: ["tong-quan:xem"] },
  "/don-hang": { quyen: ["don-hang:xem"] },
  "/san-pham": { quyen: ["san-pham:xem"] },
  "/ton-kho": { quyen: ["ton-kho:xem"] },
  "/tai-chinh": {
    quyen: ["tai-chinh-loi-lo:xem", "tai-chinh-dong-tien:xem", "tai-chinh-so-quy:xem", "chi-phi:xem"],
  },
  "/kenh": { quyen: ["kenh:xem"] },
  "/marketing": { quyen: ["marketing:xem"] },
  "/bao-cao": { quyen: ["bao-cao:xem"] },
  "/cai-dat": { quyen: ["cai-dat:xem"] },
  "/quan-tri": { chuShop: true },
};

/**
 * SERVER: tập href người dùng được vào — CHỈ `string[]` để truyền qua ranh giới RSC (NavItem mang
 * `icon` là component, không serializable). Tự chứa, KHÔNG import hàm từ `nguoi-dung-phien` (file đó
 * kéo Prisma vào bundle client vì nav-config cũng được client import).
 */
export function hrefDuocPhep(nd: Pick<NguoiDung, "role" | "quyen">): string[] {
  const chu = nd.role === "OWNER";
  const tatCa = [...NAV_ITEMS, SETTINGS_NAV_ITEM, QUAN_TRI_NAV_ITEM];
  return tatCa
    .map((i) => i.href)
    .filter((href) => {
      const y = QUYEN_THEO_HREF[href];
      if (chu) return true;
      if (!y || y.chuShop) return false;
      return (y.quyen ?? []).some((q) => nd.quyen.has(q));
    });
}

/** CLIENT: lọc mảng NavItem theo tập href được phép, giữ thứ tự gốc. */
export function locNavTheoHref(items: readonly NavItem[], hrefs: readonly string[]): NavItem[] {
  const tap = new Set(hrefs);
  return items.filter((i) => tap.has(i.href));
}

/** Tab dưới đáy sau khi lọc — tab đầu tiên là mục đầu còn lại (không cứng Dashboard). */
export function tabChinhTheoHref(hrefs: readonly string[]): NavItem[] {
  return locNavTheoHref(TAB_CHINH_ITEMS, hrefs);
}

/**
 * Đích `href` (có thể kèm `?query`/`#hash`) thuộc tập trang người dùng được vào? So theo phần đường
 * dẫn — `/don-hang?trang_thai=…` xét như `/don-hang`. Thẻ/link trên trang khác dùng để chỉ dựng `<a>`
 * khi bấm vào sẽ tới được trang, không thì hiện chữ thường (bấm chỉ gặp "không có quyền").
 */
export function coTheVaoHref(hrefsDuocPhep: readonly string[], href: string): boolean {
  const duongDan = href.split(/[?#]/, 1)[0];
  return hrefsDuocPhep.includes(duongDan);
}
