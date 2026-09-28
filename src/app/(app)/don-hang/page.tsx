import { OrderDetailDrawer } from "@/components/orders/order-detail-drawer";
import { OrderFilters } from "@/components/orders/order-filters";
import { OrderTable } from "@/components/orders/order-table";
import { OrderTotalsStrip } from "@/components/orders/order-totals-strip";
import { SyncBanner } from "@/components/orders/sync-banner";
import { parseDateRange } from "@/lib/date-range";
import { docSoTrang, veTrangCuoiNeuVuot } from "@/lib/pagination";
import {
  getLastPancakeSyncAt,
  getOrderDetail,
  getOrderListPage,
  ORDER_PAGE_SIZE,
} from "@/lib/queries/orders";
import { slugToStatus } from "@/lib/orders/order-status-meta";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";

type SearchParams = {
  q?: string;
  kenh?: string;
  trang_thai?: string;
  ngay_tu?: string;
  ngay_den?: string;
  trang?: string;
  don?: string;
};

export default async function DonHangPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  // Canh phiên NGAY TẠI TRANG, không chỉ dựa vào `(app)/layout.tsx`: một request RSC dựng tay có
  // thể xin riêng segment trang mà không chạy lại layout ⇒ dữ liệu đơn hàng lọt ra ngoài phiên,
  // và mốc thu hồi phiên (đổi mật khẩu) cũng không được soi. 6 trang khác trong nhóm này đã làm vậy.
  await requireUser("/don-hang");

  const sp = await searchParams;
  const page = docSoTrang(sp.trang);
  const channels = sp.kenh?.split(",").filter(Boolean);
  const statuses = slugToStatus(sp.trang_thai ?? "");
  const range = sp.ngay_tu && sp.ngay_den ? parseDateRange({ tu: sp.ngay_tu, den: sp.ngay_den }) : null;

  const [{ rows, total, totals }, lastSyncAt, orderDetail, channelOptions] = await Promise.all([
    getOrderListPage({
      q: sp.q,
      channels,
      statuses: statuses.length ? statuses : undefined,
      from: range?.from,
      to: range?.to,
      page,
    }),
    getLastPancakeSyncAt(),
    sp.don ? getOrderDetail(sp.don) : Promise.resolve(null),
    prisma.channel.findMany({ orderBy: { sortOrder: "asc" }, select: { id: true, name: true, color: true } }),
  ]);

  veTrangCuoiNeuVuot({ duongDan: "/don-hang", sp, trang: page, tong: total, soDongMoiTrang: ORDER_PAGE_SIZE });

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h1 className="font-serif text-2xl text-ink">Đơn hàng</h1>
        <p className="text-sm text-muted-foreground">{total} đơn</p>
      </div>

      <SyncBanner lastSyncAt={lastSyncAt} />
      <OrderFilters channels={channelOptions} />

      {rows.length > 0 ? (
        <>
          <OrderTotalsStrip
            totals={totals}
            orderCount={total}
            range={range}
            statuses={statuses}
            channelNames={channelOptions.filter((c) => channels?.includes(c.id)).map((c) => c.name)}
            q={sp.q}
          />
          <OrderTable rows={rows} total={total} page={page} sp={sp} />
        </>
      ) : (
        <p className="py-12 text-center text-sm text-muted-foreground">Không tìm thấy đơn khớp bộ lọc</p>
      )}

      <OrderDetailDrawer order={orderDetail} />
    </div>
  );
}
