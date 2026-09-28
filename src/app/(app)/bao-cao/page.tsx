import Link from "next/link";
import { redirect } from "next/navigation";
import { format, startOfMonth, subMonths } from "date-fns";

import { ProductReportTab } from "@/components/bao-cao/product-report-tab";
import { ReportExportButtons } from "@/components/bao-cao/report-export-buttons";
import { TrendTab } from "@/components/bao-cao/trend-tab";
import { resolveRangeFromParams } from "@/lib/date-range";
import { ensureRecurringExpensesForMonths } from "@/lib/expenses/ensure-recurring-expenses";
import { prisma } from "@/lib/prisma";
import { computeMonthlyTrend } from "@/lib/reports/monthly-trend";
import { computeProductReport } from "@/lib/reports/product-report";
import { requireUser } from "@/lib/session";
import { cn } from "@/lib/utils";

type ReportTab = "san-pham" | "xu-huong";

const TAB_ITEMS: { key: ReportTab; label: string }[] = [
  { key: "san-pham", label: "Sản phẩm" },
  { key: "xu-huong", label: "Xu hướng" },
];

const DEFAULT_SLOW_SELLER_MAX_ORDERS = 2;

function isReportTab(value: string | undefined): value is ReportTab {
  return value === "san-pham" || value === "xu-huong";
}

type SearchParams = { tu?: string; den?: string; range?: string; tab?: string; sp?: string; kenh?: string };

/**
 * `/bao-cao` — 2 tab (Sản phẩm / Xu hướng) chọn qua `?tab=`, mặc định
 * `san-pham`. Tab P&L đã DỜI sang hub Tài chính (`/tai-chinh?tab=loi-lo`);
 * `?tab=pnl` cũ redirect sang đó (KHÔNG giữ tu/den/range — về tháng mặc định).
 * Mỗi tab dữ liệu khác nhau nên chỉ fetch đúng tab đang mở.
 */
export default async function BaoCaoPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  await requireUser();

  const sp = await searchParams;
  // P&L cũ đã dời về hub — bookmark/link cũ `?tab=pnl` không rơi nhầm tab Sản phẩm.
  if (sp.tab === "pnl") {
    redirect("/tai-chinh?tab=loi-lo");
  }
  const tab: ReportTab = isReportTab(sp.tab) ? sp.tab : "san-pham";
  // Range chung: ?tu=&den= (Tùy chọn) → ?range=<preset> → this_month.
  const range = resolveRangeFromParams({ tu: sp.tu, den: sp.den, range: sp.range });

  // Chuyển tab giữ nguyên range đang xem — KHÔNG giữ sp/kenh (đặc thù tab Sản phẩm).
  function tabHref(target: ReportTab): string {
    const params = new URLSearchParams();
    if (target !== "san-pham") params.set("tab", target);
    if (sp.tu && sp.den) {
      params.set("tu", sp.tu);
      params.set("den", sp.den);
    } else if (sp.range) {
      params.set("range", sp.range);
    }
    const qs = params.toString();
    return qs ? `/bao-cao?${qs}` : "/bao-cao";
  }

  let content: React.ReactNode;
  let exportButtons: React.ReactNode;
  let printPeriodLabel: string;

  if (tab === "san-pham") {
    const channelId = sp.kenh || undefined;
    const [rows, channels, slowSetting] = await Promise.all([
      computeProductReport(range, { channelId }),
      prisma.channel.findMany({
        where: { isActive: true },
        orderBy: { sortOrder: "asc" },
        select: { id: true, name: true, color: true },
      }),
      prisma.setting.findUnique({ where: { key: "slowSellerMaxOrders" } }),
    ]);
    const slowSellerMaxOrders = slowSetting
      ? Number.parseInt(slowSetting.value, 10) || DEFAULT_SLOW_SELLER_MAX_ORDERS
      : DEFAULT_SLOW_SELLER_MAX_ORDERS;

    content = <ProductReportTab rows={rows} channels={channels} slowSellerMaxOrders={slowSellerMaxOrders} />;
    printPeriodLabel = `${format(range.from, "dd/MM/yyyy")} – ${format(range.to, "dd/MM/yyyy")}`;

    const ky = `${format(range.from, "yyMMdd")}-${format(range.to, "yyMMdd")}`;
    exportButtons = <ReportExportButtons ky={ky} hasData={rows.length > 0} data={{ tab: "san-pham", rows }} />;
  } else {
    // Backfill chi phí định kỳ cho cả 12 tháng của cửa sổ trend (khớp cách
    // `computeMonthlyTrend` dựng danh sách tháng) TRƯỚC khi tính.
    const trendNow = new Date();
    await ensureRecurringExpensesForMonths(
      Array.from({ length: 12 }, (_, i) => startOfMonth(subMonths(trendNow, i)))
    );
    const rows = await computeMonthlyTrend(12);
    content = <TrendTab rows={rows} />;
    printPeriodLabel = "12 tháng gần nhất";

    const hasData = rows.some((r) => r.orderCount > 0);
    exportButtons = (
      <ReportExportButtons ky={format(new Date(), "yyyy-MM")} hasData={hasData} data={{ tab: "xu-huong", rows }} />
    );
  }

  return (
    <div className="flex flex-col gap-6">
      {/* Chỉ hiện khi in (window.print()) — sidebar/topbar bị ẩn qua @media print. */}
      <div className="hidden print:block">
        <p className="font-serif text-xl text-ink">HogiKids</p>
        <p className="text-sm text-muted-foreground">
          {TAB_ITEMS.find((t) => t.key === tab)?.label} — {printPeriodLabel}
        </p>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3 print:hidden">
        <nav className="flex gap-1 rounded-lg bg-surface-soft p-1" aria-label="Loại báo cáo">
          {TAB_ITEMS.map((t) => (
            <Link
              key={t.key}
              href={tabHref(t.key)}
              className={cn(
                "rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
                tab === t.key ? "bg-canvas text-ink shadow-sm" : "text-muted-foreground hover:text-ink"
              )}
            >
              {t.label}
            </Link>
          ))}
        </nav>
        {exportButtons}
      </div>

      {content}
    </div>
  );
}
