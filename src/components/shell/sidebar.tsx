"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { logout } from "@/lib/actions/auth";
import { cn } from "@/lib/utils";
import { NAV_ITEMS, SETTINGS_NAV_ITEM, isNavItemActive } from "./nav-config";

type SidebarProps = {
  shopName: string;
  missingCostCount: number;
  lowStockWarning: boolean;
  mobileOpen: boolean;
  onMobileOpenChange: (open: boolean) => void;
};

/**
 * Renders the sidebar twice with the same nav content: a persistent desktop
 * `<aside>` and a mobile `Sheet` (controlled by `ShellChrome`'s hamburger
 * button in the top bar) — kept as one component so the two never drift.
 */
export function Sidebar({ shopName, missingCostCount, lowStockWarning, mobileOpen, onMobileOpenChange }: SidebarProps) {
  return (
    <>
      <aside className="hidden border-r border-hairline bg-canvas md:sticky md:top-0 md:flex md:h-screen md:flex-col">
        <SidebarNavContent shopName={shopName} missingCostCount={missingCostCount} lowStockWarning={lowStockWarning} />
      </aside>

      <Sheet open={mobileOpen} onOpenChange={onMobileOpenChange}>
        <SheetContent side="left" className="w-72 max-w-[85vw] gap-0 bg-canvas p-0">
          <SheetTitle className="sr-only">Điều hướng</SheetTitle>
          <SidebarNavContent
            shopName={shopName}
            missingCostCount={missingCostCount}
            lowStockWarning={lowStockWarning}
            onNavigate={() => onMobileOpenChange(false)}
          />
        </SheetContent>
      </Sheet>
    </>
  );
}

function SidebarNavContent({
  shopName,
  missingCostCount,
  lowStockWarning,
  onNavigate,
}: {
  shopName: string;
  missingCostCount: number;
  lowStockWarning: boolean;
  onNavigate?: () => void;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const avatarLetter = shopName.trim().charAt(0).toUpperCase() || "H";

  async function handleLogout() {
    await logout();
    router.push("/dang-nhap");
    router.refresh();
  }

  return (
    <div className="flex h-full flex-col p-4">
      <Link href="/" onClick={onNavigate} className="flex flex-col gap-0.5 px-2 pb-6">
        <span className="font-serif text-xl text-ink">HogiKids</span>
        <span className="text-xs text-muted-foreground">Quản lý kinh doanh</span>
      </Link>

      <nav className="flex flex-1 flex-col gap-1">
        {NAV_ITEMS.map((item) => (
          <SidebarNavLink
            key={item.href}
            item={item}
            pathname={pathname}
            onNavigate={onNavigate}
            badgeCount={item.href === "/san-pham" && missingCostCount > 0 ? missingCostCount : undefined}
            warningDot={item.href === "/ton-kho" && lowStockWarning}
          />
        ))}
      </nav>

      <div className="flex flex-col gap-1 border-t border-hairline pt-3">
        <SidebarNavLink item={SETTINGS_NAV_ITEM} pathname={pathname} onNavigate={onNavigate} />

        <DropdownMenu>
          <DropdownMenuTrigger className="flex items-center gap-2.5 rounded-lg px-3 py-2 text-left text-sm font-medium text-ink transition-colors hover:bg-surface-soft">
            <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-surface-card font-serif text-ink">
              {avatarLetter}
            </span>
            <span className="truncate">{shopName}</span>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" side="top">
            <DropdownMenuItem render={<Link href="/cai-dat" onClick={onNavigate} />}>
              Cài đặt
            </DropdownMenuItem>
            <DropdownMenuItem onClick={handleLogout}>Đăng xuất</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
}

function SidebarNavLink({
  item,
  pathname,
  onNavigate,
  badgeCount,
  warningDot,
}: {
  item: (typeof NAV_ITEMS)[number];
  pathname: string;
  onNavigate?: () => void;
  badgeCount?: number;
  warningDot?: boolean;
}) {
  const Icon = item.icon;
  const active = isNavItemActive(pathname, item.href);

  return (
    <Link
      href={item.href}
      onClick={onNavigate}
      aria-current={active ? "page" : undefined}
      className={cn(
        "flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm font-medium transition-colors",
        active
          ? "bg-surface-card text-ink"
          : "text-muted-foreground hover:bg-surface-soft hover:text-ink"
      )}
    >
      <span className="relative shrink-0">
        <Icon className="size-5" />
        {warningDot && (
          <span className="absolute -top-0.5 -right-0.5 size-2 rounded-full bg-warning" aria-hidden="true" />
        )}
      </span>
      <span className="flex-1 truncate">{item.label}</span>
      {badgeCount !== undefined && (
        <span className="rounded-full bg-warning/15 px-1.5 py-0.5 text-xs font-medium text-warning">
          {badgeCount}
        </span>
      )}
    </Link>
  );
}
