import { Badge } from "@/components/ui/badge";
import { formatVnd } from "@/lib/format";
import { formatPlatformFeeRatio, RETURNED_FEE_TITLE } from "@/lib/orders/provisional-fee";
import type { OrderDetail } from "@/lib/queries/orders";

/**
 * Khối đơn HOÀN/HỦY — không tính vào P&L (doanh thu/COGS đơn bị loại), nhưng phí sàn
 * THỰC (`returnedFee`) sàn đã giữ lại thì vẫn vào lãi ròng P&L nên hiện riêng ở đây.
 * Tách khỏi `order-detail-drawer.tsx` để giữ file dưới ngưỡng modularize (~200 dòng).
 */
export function OrderReturnedPanel({
  order,
  returnedFeeDisplay,
}: {
  order: Pick<OrderDetail, "itemsTotal" | "platformFeeEst">;
  returnedFeeDisplay: { show: boolean; fee: number; provisional: boolean };
}) {
  return (
    <div className="flex flex-col gap-1.5 rounded-xl bg-surface-dark p-4 text-on-dark">
      <p className="text-sm">Đơn không tính vào P&L (đã hoàn/hủy)</p>
      {/* Phí sàn đơn hoàn/hủy = SỐ THỰC returnedFee, ĐÃ tính vào lãi ròng P&L
          (Task 3) — khác doanh thu/COGS của đơn (vẫn loại khỏi P&L). */}
      {returnedFeeDisplay.show && (
        <>
          <div className="mt-1 flex items-center justify-between border-t border-on-dark/20 pt-2 text-sm">
            <span className="inline-flex items-center gap-1.5 text-on-dark/80">
              Phí sàn đơn hoàn/hủy (thực thu)
              {returnedFeeDisplay.provisional && (
                <Badge variant="outline" className="border-on-dark/40 text-on-dark" title={RETURNED_FEE_TITLE}>
                  tạm tính
                </Badge>
              )}
            </span>
            <span className="inline-flex items-center gap-1.5">
              {formatVnd(returnedFeeDisplay.fee)}
              {formatPlatformFeeRatio(returnedFeeDisplay.fee, order.itemsTotal) && (
                <span className="text-xs text-on-dark/60">
                  · {formatPlatformFeeRatio(returnedFeeDisplay.fee, order.itemsTotal)}
                </span>
              )}
            </span>
          </div>
          {returnedFeeDisplay.provisional && order.platformFeeEst > 0 && (
            <p className="text-xs text-on-dark/70">
              Phí tạm sàn treo: {formatVnd(order.platformFeeEst)} (sàn có thể hoàn — theo dõi)
            </p>
          )}
        </>
      )}
    </div>
  );
}
