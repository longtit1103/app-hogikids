import Link from "next/link";
import { redirect } from "next/navigation";
import { endOfDay } from "date-fns";

import { AddChannelAdsButton } from "@/components/kenh/add-channel-ads-button";
import { ChannelAdsExpensesTab } from "@/components/kenh/channel-ads-expenses-tab";
import { feeBadgeLabel } from "@/components/kenh/channel-format";
import { ChannelKpiCards, type KpiKenhDuLieu } from "@/components/kenh/channel-kpi-cards";
import { ChannelOrdersTab } from "@/components/kenh/channel-orders-tab";
import { ChannelRevenueAdsChart } from "@/components/kenh/channel-revenue-ads-chart";
import { SanPhamBanChayKenh } from "@/components/kenh/san-pham-ban-chay-kenh";
import { Badge } from "@/components/ui/badge";
import { clampRangeEndToNow, khoangServerThuocTinh, previousComparableRange, resolveRangeFromParams, serializeDateRange } from "@/lib/date-range";
import { docLuaChonDaLuu } from "@/lib/date-range-cookie-server";
import { sangExpenseRow, type ExpenseRow } from "@/lib/expenses/expense-queries";
import { slugToStatus } from "@/lib/orders/order-status-meta";
import { docSoTrang } from "@/lib/pagination";
import { prisma } from "@/lib/prisma";
import { quyenGiaVonCua } from "@/lib/queries/che-gia-von-types";
import { getOrderListPage } from "@/lib/queries/orders";
import { yeuCauQuyenTrang } from "@/lib/quyen/cong-trang";
import { coQuyen } from "@/lib/quyen/nguoi-dung-phien";
import { computeChannelRevenueAdsSeries } from "@/lib/reports/daily-series";
import { calcPnl } from "@/lib/reports/pnl";
import { boPnlTheoQuyen } from "@/lib/reports/pnl-che";
import { computeProductReport } from "@/lib/reports/product-report";
import { cn } from "@/lib/utils";

const TOP_SAN_PHAM_LIMIT = 10;

type SearchParams = {
  tu?: string;
  den?: string;
  range?: string;
  so_sanh?: string;
  tab?: string;
  q?: string;
  trang_thai?: string;
  trang?: string;
};

type ChannelTab = "don-hang" | "quang-cao";

function isChannelTab(v: string | undefined): v is ChannelTab {
  return v === "don-hang" || v === "quang-cao";
}

/**
 * `/kenh/:id` — drill-down 1 kênh (design spec 8.1). Kỳ theo date-range toàn
 * cục (đã bật cho prefix `/kenh` ở `date-range-provider.tsx`, gồm cả
 * `/kenh/*`) — page.tsx KHÔNG tự dựng picker riêng. `:id` không hợp lệ →
 * redirect `/kenh?loi=khong_tim_thay` (toast đã có sẵn ở `channel-not-found-toast.tsx`).
 */
export default async function KenhChiTietPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<SearchParams>;
}) {
  const nd = await yeuCauQuyenTrang("/kenh", "kenh:xem");
  const quyen = quyenGiaVonCua(nd);
  // Thêm/sửa/xoá chi phí ads gắn kênh là ghi Sổ chi phí — đòi `chi-phi:sua` (action cũng tự kiểm).
  const suaChiPhi = coQuyen(nd, "chi-phi:sua");

  const { id } = await params;
  const channel = await prisma.channel.findUnique({ where: { id } });
  if (!channel) {
    redirect("/kenh?loi=khong_tim_thay");
  }

  const sp = await searchParams;
  const now = new Date();
  // Giống /kenh: provider chỉ ghi ?tu=&den= khi chọn "Tùy chọn" — preset khác
  // không có trong URL nên mặc định "this_month". Kẹp biên phải về hôm nay; kỳ
  // trước (ChannelKpiCards) dùng previousComparableRange để ca "Tháng này" khớp
  // hàng KPI Dashboard (cùng số ngày đầu tháng trước).
  const range = clampRangeEndToNow(
    resolveRangeFromParams({ tu: sp.tu, den: sp.den, range: sp.range }, now, await docLuaChonDaLuu(now)),
    now,
  );
  const tab: ChannelTab = isChannelTab(sp.tab) ? sp.tab : "don-hang";
  const page = docSoTrang(sp.trang);
  const statuses = slugToStatus(sp.trang_thai ?? "");

  const [current, previous, series, topSanPham, orderPage, adsExpenseRecords, categories, activeChannels] =
    await Promise.all([
      calcPnl(range, { channelId: id }),
      calcPnl(previousComparableRange(range, now), { channelId: id }),
      computeChannelRevenueAdsSeries(range, id),
      computeProductReport(range, { channelId: id }, quyen),
      getOrderListPage({
        channels: [id],
        from: range.from,
        to: range.to,
        page,
        q: sp.q,
        statuses: statuses.length ? statuses : undefined,
      }),
      prisma.expense.findMany({
        where: {
          categoryId: "ads",
          channelId: id,
          date: { gte: range.from, lte: endOfDay(range.to) },
        },
        orderBy: { date: "desc" },
        include: { category: true, channel: true },
      }),
      prisma.expenseCategory.findMany({ where: { isHidden: false } }),
      prisma.channel.findMany({ where: { isActive: true }, orderBy: { sortOrder: "asc" } }),
    ]);

  // Bảng ads của kênh — dựng dòng qua CÙNG hàm với Sổ chi phí (trang này là file P&L, không tự đọc
  // hồ sơ thẻ; ads cũng không bao giờ "trừ vào thẻ" ở khoản chi).
  const adsExpenseRows: ExpenseRow[] = adsExpenseRecords.map(sangExpenseRow);

  const roas = current.ads > 0 ? current.revenue / current.ads : null;
  // `calcPnl` tính đủ (ngoại lệ chốt 30/09) — thiếu quyền giá vốn thì chiếu DTO che trước khi vào props.
  const kpiKenh: KpiKenhDuLieu = boPnlTheoQuyen({ current, previous }, quyen);
  const topSanPhamCat = topSanPham.coQuyenGiaVon
    ? { coQuyenGiaVon: true as const, rows: topSanPham.rows.slice(0, TOP_SAN_PHAM_LIMIT) }
    : { coQuyenGiaVon: false as const, rows: topSanPham.rows.slice(0, TOP_SAN_PHAM_LIMIT) };

  // Chuyển tab giữ kỳ (tu/den) + so_sanh, KHÔNG giữ filter riêng tab Đơn hàng
  // (q/trang_thai/trang) — khớp cách /bao-cao đổi tab (chỉ giữ tu/den).
  function tabHref(target: ChannelTab): string {
    const qp = new URLSearchParams();
    if (target !== "don-hang") qp.set("tab", target);
    if (sp.tu && sp.den) {
      qp.set("tu", sp.tu);
      qp.set("den", sp.den);
    } else if (sp.range) {
      qp.set("range", sp.range);
    }
    if (sp.so_sanh) qp.set("so_sanh", sp.so_sanh);
    const qs = qp.toString();
    return qs ? `/kenh/${id}?${qs}` : `/kenh/${id}`;
  }

  return (
    <div className="flex flex-col gap-6" data-khoang-server={khoangServerThuocTinh(range)}>
      <nav className="flex items-center gap-1.5 text-sm text-muted-foreground">
        <Link href="/kenh" className="text-primary hover:underline">
          Kênh
        </Link>
        <span>/</span>
        <span className="text-ink">{channel.name}</span>
      </nav>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2.5">
          <span className="size-3 shrink-0 rounded-full" style={{ backgroundColor: channel.color }} />
          <h1 className="font-serif text-2xl text-ink">{channel.name}</h1>
          <Badge className="border-none bg-surface-cream-strong text-ink">
            {feeBadgeLabel(channel.platformFeePct + channel.paymentFeePct)}
          </Badge>
          {!channel.isActive && <Badge className="bg-surface-soft text-muted-foreground">Đã tắt</Badge>}
          <Link href="/cai-dat" className="text-sm text-primary hover:underline">
            Sửa trong Cài đặt
          </Link>
        </div>
        {suaChiPhi && (
          <AddChannelAdsButton
            channelId={id}
            channelName={channel.name}
            isActive={channel.isActive}
            categories={categories}
            channels={activeChannels}
          />
        )}
      </div>

      <ChannelKpiCards du={kpiKenh} />

      <ChannelRevenueAdsChart points={series} channelColor={channel.color} />

      <SanPhamBanChayKenh
        bang={topSanPhamCat}
        channelId={id}
        ky={serializeDateRange(range)}
      />

      <div className="rounded-xl border border-hairline bg-canvas p-4">
        <nav className="mb-4 flex gap-1 rounded-lg bg-surface-soft p-1" aria-label="Tab kênh">
          <Link
            href={tabHref("don-hang")}
            className={cn(
              "rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
              tab === "don-hang" ? "bg-canvas text-ink shadow-sm" : "text-muted-foreground hover:text-ink"
            )}
          >
            Đơn hàng
          </Link>
          <Link
            href={tabHref("quang-cao")}
            className={cn(
              "rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
              tab === "quang-cao" ? "bg-canvas text-ink shadow-sm" : "text-muted-foreground hover:text-ink"
            )}
          >
            Chi phí ads
          </Link>
        </nav>

        {tab === "don-hang" ? (
          <ChannelOrdersTab
            rows={orderPage.rows}
            total={orderPage.total}
            page={page}
            channelId={id}
            channelName={channel.name}
          />
        ) : (
          <ChannelAdsExpensesTab
            rows={adsExpenseRows}
            categories={categories}
            channels={activeChannels}
            roas={roas}
            choPhepSua={suaChiPhi}
          />
        )}
      </div>
    </div>
  );
}
