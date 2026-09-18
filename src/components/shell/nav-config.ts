import type { LucideIcon } from "lucide-react";
import {
  BarChart3,
  LayoutDashboard,
  Megaphone,
  Package,
  Settings,
  ShoppingCart,
  TrendingUp,
  Wallet,
  Warehouse,
} from "lucide-react";

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

const ALL_NAV_ITEMS: readonly NavItem[] = [...NAV_ITEMS, SETTINGS_NAV_ITEM];

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
