import type { OrderStatus } from "@prisma/client";

/**
 * Phí sàn THỰC vào P&L của 1 tập đơn (nhóm theo status, vd `prisma.order.groupBy`):
 * đơn hoàn/hủy (RETURNED/CANCELLED) sàn giữ THẬT `returnedFee` (khớp
 * `returnedOrderFee` của `pnl.ts` + cột "Phí sàn" từng dòng ở `order-table.tsx`
 * cho nhóm này), đơn hợp lệ dùng `platformFeeEst` (khớp `platformFee` của
 * `pnl.ts`). Trộn platformFeeEst của đơn hoàn/hủy vào đây là BUG đã fix (PR #37
 * review): platformFeeEst là số TẠM trước đối soát, cao hơn nhiều lần
 * returnedFee thật → dải tổng lệch cột từng dòng.
 */
export function sumPnlPlatformFee(
  groups: { status: OrderStatus; _sum: { platformFeeEst: number | null; returnedFee: number | null } }[],
): number {
  return groups.reduce((s, g) => {
    const returned = g.status === "RETURNED" || g.status === "CANCELLED";
    return s + (returned ? (g._sum.returnedFee ?? 0) : (g._sum.platformFeeEst ?? 0));
  }, 0);
}
