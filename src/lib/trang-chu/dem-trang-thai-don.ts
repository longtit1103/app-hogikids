import { endOfDay } from "date-fns";

import { type DateRange } from "@/lib/date-range";
import { prisma } from "@/lib/prisma";

import type { OrderStatus } from "@/generated/prisma/client";

/**
 * Số đơn ĐẶT trong kỳ theo từng trạng thái — biểu đồ tròn "Tình trạng đơn" trang chủ (spec §4.4).
 * CÙNG biên kỳ với `calcPnl` (`orderedAt ∈ [from, endOfDay(to)]`, mọi kênh) ⇒ Σ = `orderCount +
 * returnBomOrderCount` của `calcPnl` cùng kỳ (test `tests/trang-chu/dem-trang-thai-don-va-chuoi-ngay`).
 * Đủ 5 khoá, trạng thái không phát sinh = 0.
 */
export async function demTrangThaiDon(range: DateRange): Promise<Record<OrderStatus, number>> {
  const nhom = await prisma.order.groupBy({
    by: ["status"],
    where: { orderedAt: { gte: range.from, lte: endOfDay(range.to) } },
    _count: { _all: true },
  });
  const kq: Record<OrderStatus, number> = { PENDING: 0, SHIPPING: 0, COMPLETED: 0, RETURNED: 0, CANCELLED: 0 };
  for (const n of nhom) kq[n.status] = n._count._all;
  return kq;
}
