import { startOfDay, startOfMonth, subMonths } from "date-fns";

import { ChannelDonut } from "@/components/dashboard/channel-donut";
import { ChuaSyncEmptyState } from "@/components/dashboard/chua-sync-empty-state";
import { KpiCards } from "@/components/dashboard/kpi-cards";
import { LowStockCard } from "@/components/dashboard/low-stock-card";
import { RevenueProfitChart } from "@/components/dashboard/revenue-profit-chart";
import { SyncStatusCard, type SyncStatusRow } from "@/components/dashboard/sync-status-card";
import { TopProductsCard } from "@/components/dashboard/top-products-card";
import {
  clampRangeEndToNow,
  lastMonthToSameDay,
  resolveRangeFromParams,
  resolveRangePreset,
  type DateRange,
} from "@/lib/date-range";
import { ensureRecurringExpensesForMonths, monthStartsInRange } from "@/lib/expenses/ensure-recurring-expenses";
import { prisma } from "@/lib/prisma";
import { getLowStockPreview } from "@/lib/queries/variants";
import { calcPnl, computeChannelPnl } from "@/lib/reports/pnl";
import { computeDailySeries } from "@/lib/reports/daily-series";
import { computeProductReport } from "@/lib/reports/product-report";
import { requireUser } from "@/lib/session";

import type { SyncKind } from "@prisma/client";

const SYNC_KINDS: SyncKind[] = ["PANCAKE", "META_ADS", "TIKTOK_ADS", "TIKTOK_SHOP", "TIKTOK_SHOP_ANALYTICS"];
const TOP_PRODUCTS_LIMIT = 5;

type SearchParams = { tu?: string; den?: string; range?: string };

/**
 * Hàng KPI dùng 3 range CỐ ĐỊNH, ĐỘC LẬP date-range picker toàn cục (brief
 * Task 4): Hôm nay, Tháng này (tháng-tới-nay vì ngày tương lai rỗng), và "cùng
 * số ngày tháng trước" để so % — ngày 29–31 kẹp về ngày cuối tháng trước
 * (khớp quy tắc kẹp ngày của `ensure-recurring-expenses.ts`).
 */
function buildKpiRanges(now: Date): { today: DateRange; thisMonth: DateRange; lastMonthSameDays: DateRange } {
  return {
    today: { from: startOfDay(now), to: now },
    thisMonth: resolveRangePreset("this_month", now),
    // Cùng công thức với so-kỳ-trước /kenh — xem lastMonthToSameDay (nguồn duy nhất).
    lastMonthSameDays: lastMonthToSameDay(now),
  };
}

export default async function DashboardPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  await requireUser();

  const [pancakeSyncCount, orderCount] = await Promise.all([
    prisma.syncLog.count({ where: { kind: "PANCAKE" } }),
    prisma.order.count(),
  ]);
  if (pancakeSyncCount === 0 && orderCount === 0) {
    return <ChuaSyncEmptyState />;
  }

  const sp = await searchParams;
  // Range chung cho biểu đồ/donut/top: ?tu=&den= (Tùy chọn) → ?range=<preset> → this_month.
  // Hàng KPI phía dưới CỐ Ý độc lập range này (today/tháng-này/tháng-trước cố định — xem buildKpiRanges).
  const range = resolveRangeFromParams({ tu: sp.tu, den: sp.den, range: sp.range });

  const now = new Date();
  const { today, thisMonth, lastMonthSameDays } = buildKpiRanges(now);

  // Backfill chi phí định kỳ cho MỌI tháng sắp render TRƯỚC khi tính P&L:
  // tháng này + tháng trước (hàng KPI so sánh `lastMonthSameDays`) và các
  // tháng phủ `range` của biểu đồ/donut/top (range tùy chọn có thể là tháng
  // quá khứ). Thiếu bước này tháng cũ hụt chi phí định kỳ → netProfit cao ảo.
  await ensureRecurringExpensesForMonths([
    startOfMonth(now),
    startOfMonth(subMonths(now, 1)),
    ...monthStartsInRange(range),
  ]);

  const [
    todayPnl,
    thisMonthPnl,
    lastMonthSameDaysPnl,
    dailySeries,
    channelPnl,
    productReport,
    lowStock,
    syncLogs,
  ] = await Promise.all([
    calcPnl(today),
    calcPnl(thisMonth),
    calcPnl(lastMonthSameDays),
    // Biểu đồ kẹp mốc phải về HÔM NAY (giống /kenh). Preset mặc định "this_month" là TRỌN tháng
    // nên không kẹp thì mọi ngày còn lại của tháng ra point 0 — nhìn như doanh thu và lợi nhuận
    // vừa sụp về đáy. Donut/Top sản phẩm bên dưới KHÔNG cần kẹp: chúng cộng dồn, ngày tương lai
    // rỗng nên không đổi số nào.
    computeDailySeries(clampRangeEndToNow(range, now)),
    computeChannelPnl(range),
    computeProductReport(range),
    getLowStockPreview(),
    Promise.all(
      SYNC_KINDS.map((kind) => prisma.syncLog.findFirst({ where: { kind }, orderBy: { startedAt: "desc" } }))
    ),
  ]);

  const syncRows: SyncStatusRow[] = SYNC_KINDS.map((kind, i) => ({ kind, log: syncLogs[i] }));

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h1 className="font-serif text-2xl text-ink">Dashboard</h1>
        <p className="text-sm text-muted-foreground">Sức khỏe kinh doanh 30 giây — bấm vào bất kỳ số nào để đi sâu</p>
      </div>

      <KpiCards today={todayPnl} thisMonth={thisMonthPnl} lastMonthSameDays={lastMonthSameDaysPnl} />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-12">
        <div className="lg:col-span-8">
          <RevenueProfitChart points={dailySeries} />
        </div>
        <div className="lg:col-span-4">
          <ChannelDonut channels={channelPnl} />
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <TopProductsCard products={productReport.slice(0, TOP_PRODUCTS_LIMIT)} />
        <LowStockCard rows={lowStock.rows} total={lowStock.total} />
        <SyncStatusCard rows={syncRows} />
      </div>
    </div>
  );
}
