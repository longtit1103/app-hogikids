import type { OrderStatus, Prisma } from "@prisma/client";

import { REAL_FEE_CHANNELS } from "@/lib/channels/real-fee-channels";
import { sumPnlPlatformFee } from "@/lib/orders/order-list-totals";
import { prisma } from "@/lib/prisma";
import { tachChiTietPhiTuRaw, type PlatformFeeComponent } from "@/lib/reports/platform-fee-breakdown";
import { layQuyetToanDon, type QuyetToanDon } from "@/lib/reports/tiktok-quyet-toan-don";

export type OrderListParams = {
  q?: string;
  channels?: string[];
  statuses?: OrderStatus[];
  from?: Date;
  to?: Date;
  page: number;
};

export type OrderListRow = {
  id: string;
  code: string;
  /** Mã đơn hàng BÊN SÀN (Shopee/TikTok) để đối chiếu — null khi đơn không có mã sàn thật. */
  maSan: string | null;
  orderedAt: Date;
  statusChangedAt: Date | null; // thời điểm đơn VÀO trạng thái hiện tại (Pancake) — null khi thiếu dữ liệu

  channelId: string;
  channelName: string;
  channelColor: string;
  customerName: string | null;
  itemCount: number;
  itemsTotal: number;
  platformFeeEst: number;
  returnedFee: number;
  discount: number;
  status: OrderStatus;
};

/**
 * Tổng tiền của TOÀN BỘ đơn khớp bộ lọc (KHÔNG phải chỉ trang đang xem) — để đối chiếu
 * với các dòng tương ứng ở bảng P&L. Nhãn hiển thị: itemsTotal = "Doanh thu gộp",
 * platformFee = "Phí sàn", discount = "Voucher".
 *
 * `platformFee` = phí sàn THỰC vào P&L (`sumPnlPlatformFee`) — đơn hoàn/hủy
 * dùng `returnedFee`, đơn hợp lệ dùng `platformFeeEst`. Đặt tên KHÁC field
 * Prisma `platformFeeEst` cố ý: đây là tổng đã trộn 2 nguồn, không phải Σ
 * thẳng 1 field (review PR #37 — trước đó dùng nhầm Σ platformFeeEst thô nên
 * dải tổng lệch cột từng dòng trên view drill đơn hoàn/hủy).
 */
export type OrderListTotals = {
  itemsTotal: number;
  platformFee: number;
  discount: number;
};

export type OrderDetail = {
  id: string;
  pancakeId: string;
  /** Mã đơn hàng BÊN SÀN để đối chiếu — null khi đơn không có mã sàn thật (xem `maDonBenSan`). */
  maSan: string | null;
  code: string;
  status: OrderStatus;
  orderedAt: Date;
  statusChangedAt: Date | null;
  channelId: string;
  channelName: string;
  channelColor: string;
  customerName: string | null;
  itemsTotal: number;
  discount: number;
  platformFeeEst: number;
  returnedFee: number;
  shipFeeCustomer: number;
  syncedAt: Date;
  items: {
    sku: string;
    productName: string;
    quantity: number;
    unitPrice: number;
    lineDiscount: number;
    costPrice: number | null;
  }[];
  /** Chi tiết phí sàn của đơn này (tách từ `raw`) — dòng con "Phí sàn" ở drawer. Rỗng → dòng không bung. */
  feeComponents: PlatformFeeComponent[];
  /** Voucher SÀN tài trợ đã kẹp — hiện dạng dòng ghi chú, KHÔNG trừ vào doanh thu (bất biến #1). */
  marketplaceFunded: number;
  /** Số SÀN quyết toán cho đơn này (đối chiếu, đọc Bronze TikTok) — null = chưa quyết toán/không phải TikTok. */
  quyetToan: QuyetToanDon | null;
};

const PAGE_SIZE = 20;

/**
 * Mã đơn hàng BÊN SÀN — chính là `Order.pancakeId`: với đơn marketplace, Pancake dùng luôn
 * mã đơn của sàn làm `id` (Shopee dạng "MAU-DON-0001", TikTok 18 chữ số), khác `code`
 * (`system_id` — mã ngắn Pancake hiển thị). Trả null khi pancakeId KHÔNG phải mã sàn thật:
 *  - đơn bù từ bản sao kho (`backfilledFromMirror`): pancakeId là id mirror "AF…";
 *  - kênh ngoài sàn (facebook/website): pancakeId là id nội bộ Pancake.
 */
function maDonBenSan(o: { pancakeId: string; backfilledFromMirror: boolean; channelId: string }): string | null {
  if (o.backfilledFromMirror) return null;
  return REAL_FEE_CHANNELS.has(o.channelId) ? o.pancakeId : null;
}

function buildWhere(p: Pick<OrderListParams, "q" | "channels" | "statuses" | "from" | "to">): Prisma.OrderWhereInput {
  const where: Prisma.OrderWhereInput = {};
  if (p.q && p.q.trim()) {
    const q = p.q.trim();
    where.OR = [
      { code: { contains: q, mode: "insensitive" } },
      // pancakeId = mã đơn bên sàn (đơn marketplace) — chủ shop dán mã từ Shopee/TikTok vào để đối chiếu.
      { pancakeId: { contains: q, mode: "insensitive" } },
      { customerName: { contains: q, mode: "insensitive" } },
    ];
  }
  if (p.channels && p.channels.length > 0) where.channelId = { in: p.channels };
  if (p.statuses && p.statuses.length > 0) where.status = { in: p.statuses };
  if (p.from && p.to) where.orderedAt = { gte: p.from, lte: p.to };
  return where;
}

/**
 * Trang danh sách đơn (mới nhất trước) — itemCount = Σ quantity trong đơn.
 *
 * `totals` cố ý aggregate trên CÙNG `where` với findMany/count nhưng KHÔNG dính
 * skip/take: tổng phải theo BỘ LỌC, không theo trang, nếu không thì số hiển thị
 * sai âm thầm và mất luôn mục đích đối chiếu với P&L.
 */
export async function getOrderListPage(
  p: OrderListParams,
): Promise<{ rows: OrderListRow[]; total: number; totals: OrderListTotals }> {
  const where = buildWhere(p);
  const [orders, total, sumsByStatus] = await Promise.all([
    prisma.order.findMany({
      where,
      orderBy: { orderedAt: "desc" },
      skip: Math.max(0, (p.page - 1) * PAGE_SIZE),
      take: PAGE_SIZE,
      select: {
        id: true,
        code: true,
        pancakeId: true,
        backfilledFromMirror: true,
        orderedAt: true,
        statusChangedAt: true,
        customerName: true,
        itemsTotal: true,
        platformFeeEst: true,
        returnedFee: true,
        discount: true,
        status: true,
        channel: { select: { id: true, name: true, color: true } },
        items: { select: { quantity: true } },
      },
    }),
    prisma.order.count({ where }),
    // groupBy theo status (thay vì aggregate 1 tổng) để tách được platformFeeEst
    // (đơn hợp lệ) vs returnedFee (đơn hoàn/hủy) — `sumPnlPlatformFee` cần biết
    // status của từng nhóm mới trộn đúng công thức phí sàn THỰC vào P&L.
    prisma.order.groupBy({
      by: ["status"],
      where,
      _sum: { itemsTotal: true, platformFeeEst: true, discount: true, returnedFee: true },
    }),
  ]);

  return {
    total,
    totals: {
      // _sum trả null khi nhóm rỗng → sumPnlPlatformFee/?? 0 tự ép về 0.
      itemsTotal: sumsByStatus.reduce((s, g) => s + (g._sum.itemsTotal ?? 0), 0),
      platformFee: sumPnlPlatformFee(sumsByStatus),
      discount: sumsByStatus.reduce((s, g) => s + (g._sum.discount ?? 0), 0),
    },
    rows: orders.map((o) => ({
      id: o.id,
      code: o.code,
      maSan: maDonBenSan({ pancakeId: o.pancakeId, backfilledFromMirror: o.backfilledFromMirror, channelId: o.channel.id }),
      orderedAt: o.orderedAt,
      statusChangedAt: o.statusChangedAt,
      channelId: o.channel.id,
      channelName: o.channel.name,
      channelColor: o.channel.color,
      customerName: o.customerName,
      itemCount: o.items.reduce((s, it) => s + it.quantity, 0),
      itemsTotal: o.itemsTotal,
      platformFeeEst: o.platformFeeEst,
      returnedFee: o.returnedFee,
      discount: o.discount,
      status: o.status,
    })),
  };
}

/**
 * Voucher SÀN tài trợ THỰC SỰ đã áp cho đơn — suy bằng CHÊNH LỆCH giữa giảm giá
 * dòng THÔ của Pancake và phần shop chịu đã lưu ở Silver.
 *
 * Vì sao không gọi thẳng `voucherSanApDung(marketplace_voucher, Σ lineDiscount)`:
 * `OrderItem.lineDiscount` là phần SHOP CHỊU — mapping đã trừ voucher sàn ra khỏi
 * nó rồi (`giamGiaShopTheoDong`). Kẹp voucher bằng chính con số đã trừ nó đi là
 * kẹp nhầm: đơn có giảm giá dòng thô 40.000 và voucher sàn 35.000 sẽ ra 5.000 —
 * đúng bằng phần shop chịu, tức mất hẳn 30.000 tiền sàn tài trợ trên màn.
 *
 * Cách này còn tự động gồm cả phần `suyVoucherSanTuCod` bù thêm lúc ingest (đơn
 * Pancake quên khai `marketplace_voucher`), thứ mà đọc thẳng field gốc sẽ bỏ sót.
 *
 * Đẳng thức dựa vào: `lineDiscount[i] = thô[i] − voucherSànPhânBổ[i]`, và
 * `phanBoVoucherSanTheoDong` bảo đảm Σ phần phân bổ = đúng voucher đã áp dụng ⇒
 * `Σ thô − Σ lineDiscount = voucher sàn đã áp dụng`.
 */
function suyVoucherSanDaApDung(raw: unknown, items: { quantity: number; lineDiscount: number }[]): number {
  const rawItems = (raw as { items?: { quantity?: unknown; discount_each_product?: unknown }[] } | null)?.items;
  if (!Array.isArray(rawItems)) return 0;

  // Lặp lại ĐÚNG phép tính của `pancake-mapping.ts`: clamp ≥ 0, làm tròn, rồi nhân
  // số lượng (`discount_each_product` là giảm giá MỖI ĐƠN VỊ — bất biến #1).
  const tongTho = rawItems.reduce((s, it) => {
    const moiDonVi = Math.max(0, Math.round(Number(it.discount_each_product ?? 0)));
    const sl = Number(it.quantity ?? 0);
    return s + (Number.isFinite(moiDonVi) && Number.isFinite(sl) ? moiDonVi * sl : 0);
  }, 0);

  const shopChiu = items.reduce((s, it) => s + it.lineDiscount, 0);
  return Math.max(0, tongTho - shopChiu);
}

/**
 * Chi tiết đơn cho drawer — costPrice = giá vốn HIỆN HÀNH (không snapshot, quyết định grill).
 *
 * `raw` được SELECT để chắt ra `feeComponents`/`marketplaceFunded` nhưng KHÔNG bao giờ trả
 * nguyên cục ra client — payload nặng và có dữ liệu khách hàng (bất biến #1, #8 ranh giới dữ liệu).
 */
export async function getOrderDetail(id: string): Promise<OrderDetail | null> {
  const order = await prisma.order.findUnique({
    where: { id },
    select: {
      id: true,
      pancakeId: true,
      backfilledFromMirror: true,
      code: true,
      status: true,
      orderedAt: true,
      statusChangedAt: true,
      customerName: true,
      itemsTotal: true,
      discount: true,
      platformFeeEst: true,
      returnedFee: true,
      shipFeeCustomer: true,
      syncedAt: true,
      raw: true,
      channel: { select: { id: true, name: true, color: true } },
      items: {
        select: {
          sku: true,
          productName: true,
          quantity: true,
          unitPrice: true,
          lineDiscount: true,
          variant: { select: { costPrice: true } },
        },
      },
    },
  });
  if (!order) return null;

  const items = order.items.map((it) => ({
    sku: it.sku,
    productName: it.productName,
    quantity: it.quantity,
    unitPrice: it.unitPrice,
    lineDiscount: it.lineDiscount,
    costPrice: it.variant?.costPrice ?? null,
  }));

  const marketplaceFunded = suyVoucherSanDaApDung(order.raw, items);

  // CHỈ đơn TikTok mới tra quyết toán: `RawTiktokShopTransaction` là dữ liệu TikTok thuần — đơn kênh
  // khác quét bảng đó vừa tốn một lượt seq-scan mỗi lần mở drawer (bảng append-only, ~72ms ở 10,5k
  // dòng và phình dần), vừa có thể NHẬN NHẦM khối "Sàn quyết toán" nếu mã đơn hai sàn trùng nhau.
  const quyetToan = order.channel.id === "tiktok" ? await layQuyetToanDon(order.pancakeId) : null;

  return {
    id: order.id,
    pancakeId: order.pancakeId,
    maSan: maDonBenSan({
      pancakeId: order.pancakeId,
      backfilledFromMirror: order.backfilledFromMirror,
      channelId: order.channel.id,
    }),
    code: order.code,
    status: order.status,
    orderedAt: order.orderedAt,
    statusChangedAt: order.statusChangedAt,
    channelId: order.channel.id,
    channelName: order.channel.name,
    channelColor: order.channel.color,
    customerName: order.customerName,
    itemsTotal: order.itemsTotal,
    discount: order.discount,
    platformFeeEst: order.platformFeeEst,
    returnedFee: order.returnedFee,
    shipFeeCustomer: order.shipFeeCustomer,
    syncedAt: order.syncedAt,
    items,
    feeComponents: tachChiTietPhiTuRaw(order.raw),
    marketplaceFunded,
    quyetToan,
  };
}

/** SyncLog PANCAKE OK gần nhất — banner "Đồng bộ lúc…" trên /don-hang. */
export async function getLastPancakeSyncAt(): Promise<Date | null> {
  const log = await prisma.syncLog.findFirst({
    where: { kind: "PANCAKE", status: "OK" },
    orderBy: { finishedAt: "desc" },
    select: { finishedAt: true },
  });
  return log?.finishedAt ?? null;
}

/** Số dòng mỗi trang danh sách đơn — trang `/don-hang` cần để kẹp `?trang=` vượt cuối. */
export { PAGE_SIZE as ORDER_PAGE_SIZE };
