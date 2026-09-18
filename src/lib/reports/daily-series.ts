import { eachDayOfInterval, endOfDay, format, startOfDay } from "date-fns";

import { type DateRange } from "@/lib/date-range";
import { prisma } from "@/lib/prisma";
import {
  calcPnlCore,
  pnlOrderSelect,
  toPnlOrderInput,
  type PnlExpenseInput,
  type PnlIncomeInput,
} from "@/lib/reports/pnl";

import type { OrderStatus } from "@prisma/client";

/**
 * Chuỗi thời gian theo NGÀY cho các biểu đồ Dashboard/Kênh/Báo cáo. Mọi hàm ở
 * đây dùng LẠI `calcPnlCore` / predicate đơn hợp lệ của pnl.ts — KHÔNG viết lại
 * công thức tiền.
 *
 * Bucket theo NGÀY VN (+07): container prod chạy `TZ=Asia/Ho_Chi_Minh`, dev đã
 * UTC+7, và ngày lưu neo +07 → `format(d, "yyyy-MM-dd")` cho đúng ngày lịch VN.
 * Biên phải MỌI query = `endOfDay(range.to)` (khớp calcPnl) — KHÔNG `lte`
 * range.to thô (sót đơn/chi phí ngày cuối). Ngày trống vẫn phát point 0.
 */

const DAY_KEY = "yyyy-MM-dd";

/** Đơn hợp lệ cho doanh thu = status ∉ {RETURNED, CANCELLED} — cùng bất biến calcPnlCore/sumPlatformFeeEst. */
const VALID_ORDER_STATUS: { notIn: OrderStatus[] } = { notIn: ["RETURNED", "CANCELLED"] };

/** Danh sách khóa ngày VN (yyyy-MM-dd) phủ TRỌN range, kể cả ngày không có dữ liệu. */
function enumerateDayKeys(range: DateRange): string[] {
  return eachDayOfInterval({ start: startOfDay(range.from), end: endOfDay(range.to) }).map((d) =>
    format(d, DAY_KEY)
  );
}

export interface DailyPoint {
  date: string /* yyyy-MM-dd */;
  revenue: number;
  netProfit: number;
}

/**
 * Doanh thu + LN ròng từng ngày. Fetch orders + expenses 1 LẦN cho cả range,
 * bucket theo ngày, rồi chạy `calcPnlCore` cho từng bucket (KHÔNG gọi calcPnl
 * mỗi ngày → tránh N query). Ngày trống vẫn có point {revenue:0, netProfit:0}.
 */
export async function computeDailySeries(range: DateRange): Promise<DailyPoint[]> {
  const to = endOfDay(range.to);
  const [orders, expenses, incomes] = await Promise.all([
    prisma.order.findMany({
      where: { orderedAt: { gte: range.from, lte: to } },
      select: { orderedAt: true, ...pnlOrderSelect },
    }),
    prisma.expense.findMany({
      where: { date: { gte: range.from, lte: to } },
      select: { date: true, categoryId: true, adsSource: true, channelId: true, amount: true },
    }),
    prisma.thuNhap.findMany({
      where: { date: { gte: range.from, lte: to } },
      select: { date: true, amount: true },
    }),
  ]);

  const ordersByDay = new Map<string, ReturnType<typeof toPnlOrderInput>[]>();
  for (const o of orders) {
    const key = format(o.orderedAt, DAY_KEY);
    const bucket = ordersByDay.get(key) ?? [];
    bucket.push(toPnlOrderInput(o));
    ordersByDay.set(key, bucket);
  }

  const expensesByDay = new Map<string, PnlExpenseInput[]>();
  for (const e of expenses) {
    const key = format(e.date, DAY_KEY);
    const bucket = expensesByDay.get(key) ?? [];
    bucket.push({ categoryId: e.categoryId, adsSource: e.adsSource, channelId: e.channelId, amount: e.amount });
    expensesByDay.set(key, bucket);
  }

  // Thu nhập tài chính PHẢI bucket theo ngày như đơn và chi phí. Truyền cả kỳ vào mỗi ngày là
  // nhân bản khoản lãi lên số ngày; không truyền gì là Σ netProfit từng ngày ≠ netProfit cả kỳ —
  // biểu đồ Dashboard lệch bảng Lãi/Lỗ đúng bằng số lãi mà không màn nào báo.
  const incomesByDay = new Map<string, PnlIncomeInput[]>();
  for (const t of incomes) {
    const key = format(t.date, DAY_KEY);
    const bucket = incomesByDay.get(key) ?? [];
    bucket.push({ amount: t.amount });
    incomesByDay.set(key, bucket);
  }

  return enumerateDayKeys(range).map((date) => {
    const b = calcPnlCore(ordersByDay.get(date) ?? [], expensesByDay.get(date) ?? [], {
      incomes: incomesByDay.get(date) ?? [],
    });
    return { date, revenue: b.revenue, netProfit: b.netProfit };
  });
}

/**
 * Doanh thu theo KÊNH từng ngày (biểu đồ vùng chồng). `values` có 1 khóa cho MỖI
 * kênh có doanh thu trong kỳ (0 nếu ngày đó không phát sinh) → chuỗi khóa ổn
 * định qua mọi ngày. Chỉ đếm đơn hợp lệ.
 */
export async function computeChannelDailyRevenue(
  range: DateRange
): Promise<Array<{ date: string; values: Record<string, number> }>> {
  const to = endOfDay(range.to);
  const orders = await prisma.order.findMany({
    where: { orderedAt: { gte: range.from, lte: to }, status: VALID_ORDER_STATUS },
    select: { orderedAt: true, channelId: true, itemsTotal: true },
  });

  const channelIds = [...new Set(orders.map((o) => o.channelId))];
  const byDay = new Map<string, Map<string, number>>();
  for (const o of orders) {
    const key = format(o.orderedAt, DAY_KEY);
    const perChannel = byDay.get(key) ?? new Map<string, number>();
    perChannel.set(o.channelId, (perChannel.get(o.channelId) ?? 0) + o.itemsTotal);
    byDay.set(key, perChannel);
  }

  return enumerateDayKeys(range).map((date) => {
    const perChannel = byDay.get(date);
    const values: Record<string, number> = {};
    for (const cid of channelIds) values[cid] = perChannel?.get(cid) ?? 0;
    return { date, values };
  });
}

/**
 * Doanh thu vs CHI TIÊU quảng cáo của 1 kênh từng ngày (biểu đồ trang /kenh/:id).
 * `ads` = chi phí danh mục "ads" GẮN đúng kênh trong ngày (khớp quy tắc lọc chi
 * phí theo kênh của calcPnlCore). Ngày trống vẫn có point {revenue:0, ads:0}.
 */
export async function computeChannelRevenueAdsSeries(
  range: DateRange,
  channelId: string
): Promise<Array<{ date: string; revenue: number; ads: number }>> {
  const to = endOfDay(range.to);
  const [orders, adsRows] = await Promise.all([
    prisma.order.findMany({
      where: { orderedAt: { gte: range.from, lte: to }, status: VALID_ORDER_STATUS, channelId },
      select: { orderedAt: true, itemsTotal: true },
    }),
    prisma.expense.findMany({
      where: { date: { gte: range.from, lte: to }, categoryId: "ads", channelId },
      select: { date: true, amount: true },
    }),
  ]);

  const revenueByDay = new Map<string, number>();
  for (const o of orders) {
    const key = format(o.orderedAt, DAY_KEY);
    revenueByDay.set(key, (revenueByDay.get(key) ?? 0) + o.itemsTotal);
  }

  const adsByDay = new Map<string, number>();
  for (const a of adsRows) {
    const key = format(a.date, DAY_KEY);
    adsByDay.set(key, (adsByDay.get(key) ?? 0) + a.amount);
  }

  return enumerateDayKeys(range).map((date) => ({
    date,
    revenue: revenueByDay.get(date) ?? 0,
    ads: adsByDay.get(date) ?? 0,
  }));
}

/**
 * Đếm ĐƠN HỢP LỆ (Pancake, cùng predicate `VALID_ORDER_STATUS` với các hàm trên) của MỘT kênh
 * từng ngày. Dùng cho biểu đồ "Xu hướng ngày" của `/marketing` (tab Tổng quan) — đối chiếu đơn
 * THẬT với lượt truy cập do TikTok Shop Analytics báo. Chỉ ĐẾM, không đụng công thức doanh thu
 * (`revenue`/`ads` đã có sẵn ở `computeChannelRevenueAdsSeries`) ⇒ không phải viết lại `pnl.ts`.
 */
export async function computeChannelDailyOrderCount(
  range: DateRange,
  channelId: string
): Promise<Array<{ date: string; orderCount: number }>> {
  const to = endOfDay(range.to);
  const orders = await prisma.order.findMany({
    where: { orderedAt: { gte: range.from, lte: to }, status: VALID_ORDER_STATUS, channelId },
    select: { orderedAt: true },
  });

  const countByDay = new Map<string, number>();
  for (const o of orders) {
    const key = format(o.orderedAt, DAY_KEY);
    countByDay.set(key, (countByDay.get(key) ?? 0) + 1);
  }

  return enumerateDayKeys(range).map((date) => ({ date, orderCount: countByDay.get(date) ?? 0 }));
}

// Gộp point ngày → tuần: `group-by-week.ts` — module thuần riêng vì chart Client Component cũng
// gọi (import từ đây là kéo Prisma vào browser bundle của /kenh).
