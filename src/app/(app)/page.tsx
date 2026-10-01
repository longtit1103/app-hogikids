import { startOfDay, startOfMonth, subMonths } from "date-fns";

import { ChannelDonut } from "@/components/dashboard/channel-donut";
import { ChuaSyncEmptyState } from "@/components/dashboard/chua-sync-empty-state";
import { KpiCards, type KpiCardsDuLieu } from "@/components/dashboard/kpi-cards";
import { LowStockCard } from "@/components/dashboard/low-stock-card";
import { RevenueProfitChart } from "@/components/dashboard/revenue-profit-chart";
import { SyncStatusCard, type SyncStatusRow } from "@/components/dashboard/sync-status-card";
import { TopProductsCard } from "@/components/dashboard/top-products-card";
import {
  clampRangeEndToNow,
  khoangServerThuocTinh,
  lastMonthToSameDay,
  resolveRangeFromParams,
  resolveRangePreset,
  type DateRange,
} from "@/lib/date-range";
import { docLuaChonDaLuu } from "@/lib/date-range-cookie-server";
import { ensureRecurringExpensesForMonths, monthStartsInRange } from "@/lib/expenses/ensure-recurring-expenses";
import { prisma } from "@/lib/prisma";
import { quyenGiaVonCua } from "@/lib/queries/che-gia-von-types";
import { yeuCauQuyenTrang } from "@/lib/quyen/cong-trang";
import { coQuyen } from "@/lib/quyen/nguoi-dung-phien";
import { calcPnl, computeChannelPnl } from "@/lib/reports/pnl";
import { boPnlTheoQuyen, cheChannelPnl, dailySeriesTheoQuyen } from "@/lib/reports/pnl-che";
import { computeDailySeries } from "@/lib/reports/daily-series";
import { SYNC_KINDS_DASHBOARD, taiKhoiChiTietDashboard } from "@/lib/dashboard/khoi-chi-tiet-theo-quyen";
import { hrefDuocPhep } from "@/components/shell/nav-config";
import { PageTitle } from "@/components/shell/page-title";

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
  const nd = await yeuCauQuyenTrang("/", "tong-quan:xem");
  // Thiếu `gia-von-loi-nhuan:xem`: `calcPnl`/`computeChannelPnl`/`computeDailySeries` VẪN tính đủ trong
  // pnl.ts (ngoại lệ chốt 30/09, spec phân quyền §4.1) rồi chiếu DTO che TRƯỚC khi vào props bên dưới.
  const quyen = quyenGiaVonCua(nd);
  // Link trên trang chỉ dựng khi người xem vào được trang đích (cùng nguồn với menu).
  const hrefs = hrefDuocPhep(nd);

  const [pancakeSyncCount, orderCount] = await Promise.all([
    prisma.syncLog.count({ where: { kind: "PANCAKE" } }),
    prisma.order.count(),
  ]);
  if (pancakeSyncCount === 0 && orderCount === 0) {
    return <ChuaSyncEmptyState choPhepDongBo={coQuyen(nd, "cai-dat:sua")} hrefDuocPhep={hrefs} />;
  }

  const sp = await searchParams;
  // Range chung cho biểu đồ/donut/top: ?tu=&den= (Tùy chọn) → ?range=<preset> → this_month.
  // Hàng KPI phía dưới CỐ Ý độc lập range này (today/tháng-này/tháng-trước cố định — xem buildKpiRanges).
  const range = resolveRangeFromParams({ tu: sp.tu, den: sp.den, range: sp.range }, new Date(), await docLuaChonDaLuu());

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
    khoiChiTiet,
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
    // Top sản phẩm / tồn thấp / đồng bộ thuộc module khác: thiếu quyền ⇒ không query, không dựng thẻ.
    taiKhoiChiTietDashboard(nd, range, quyen),
  ]);
  const { productReport, lowStock, syncLogs } = khoiChiTiet;

  const syncRows: SyncStatusRow[] | null = syncLogs
    ? SYNC_KINDS_DASHBOARD.map((kind, i) => ({ kind, log: syncLogs[i] }))
    : null;
  // Rẽ nhánh che ở ĐÚNG một helper có test — không tự gọi `chePnl` rời ở page.
  const kpi: KpiCardsDuLieu = boPnlTheoQuyen(
    { today: todayPnl, thisMonth: thisMonthPnl, lastMonthSameDays: lastMonthSameDaysPnl },
    quyen,
  );

  return (
    <div className="flex flex-col gap-6" data-khoang-server={khoangServerThuocTinh(range)}>
      <PageTitle title="Dashboard">
        <p className="text-sm text-muted-foreground">Sức khỏe kinh doanh 30 giây — bấm vào bất kỳ số nào để đi sâu</p>
      </PageTitle>

      {/* Thẻ doanh thu / LN ròng chỉ link sang Lãi/Lỗ khi người xem vào được tab đó (loi-lo ∧ giá vốn). */}
      <KpiCards
        du={kpi}
        choPhepXemLoiLo={quyen.coQuyenGiaVon && coQuyen(nd, "tai-chinh-loi-lo:xem")}
        hrefDuocPhep={hrefs}
      />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-12">
        <div className="lg:col-span-8">
          <RevenueProfitChart series={dailySeriesTheoQuyen(dailySeries, quyen)} />
        </div>
        <div className="lg:col-span-4">
          {/* Donut chỉ cần doanh thu — luôn DTO che, kể cả chủ shop (bớt payload client). */}
          <ChannelDonut channels={cheChannelPnl(channelPnl)} />
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {productReport && (
          <TopProductsCard products={productReport.rows.slice(0, TOP_PRODUCTS_LIMIT)} hrefDuocPhep={hrefs} />
        )}
        {lowStock && <LowStockCard rows={lowStock.rows} total={lowStock.total} hrefDuocPhep={hrefs} />}
        {syncRows && <SyncStatusCard rows={syncRows} choPhepDongBo={coQuyen(nd, "cai-dat:sua")} hrefDuocPhep={hrefs} />}
      </div>
    </div>
  );
}
