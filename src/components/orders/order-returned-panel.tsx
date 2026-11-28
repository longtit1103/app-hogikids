import { Badge } from "@/components/ui/badge";
import { formatVnd } from "@/lib/format";
import { formatPlatformFeeRatio, RETURNED_FEE_TITLE } from "@/lib/orders/provisional-fee";
import type { OrderDetail } from "@/lib/queries/orders";

/**
 * Khối đơn HOÀN/HỦY trong "Tiền của đơn" — thay cây lãi, không tô như đơn lỗ. Doanh thu/giá vốn của đơn
 * bị loại khỏi Lãi/Lỗ, nhưng phí sàn THỰC (`returnedFee`) sàn đã giữ lại vẫn trừ vào lãi ròng nên hiện
 * riêng ở đây. Tách khỏi `order-detail-drawer.tsx` để giữ file dưới ngưỡng modularize (~200 dòng).
 */
export function OrderReturnedPanel({
  order,
  returnedFeeDisplay,
}: {
  order: Pick<OrderDetail, "itemsTotal" | "platformFeeEst" | "status">;
  returnedFeeDisplay: { show: boolean; fee: number; provisional: boolean };
}) {
  const loai = order.status === "RETURNED" ? "hoàn" : "hủy";
  const tiLe = returnedFeeDisplay.show ? formatPlatformFeeRatio(returnedFeeDisplay.fee, order.itemsTotal) : null;

  return (
    <div className="flex flex-col gap-2">
      <div className="rounded-[10px] border border-border bg-[#fafafa] px-3.5 py-3 text-[13px]">
        <p className="mb-2 font-semibold text-tq-chu-dam">Đơn không tính vào Lãi/Lỗ (đã {loai})</p>
        <div className="flex justify-between gap-2.5 border-t border-border pt-2 text-tq-chu">
          {/* Phí sàn đơn hoàn/hủy = SỐ THỰC returnedFee, ĐÃ vào lãi ròng — khác doanh thu/giá vốn của đơn
              (vẫn loại khỏi Lãi/Lỗ). */}
          {returnedFeeDisplay.show ? (
            <>
              <span className="inline-flex flex-wrap items-center gap-1.5">
                Phí sàn đơn hoàn/hủy (thực thu)
                {returnedFeeDisplay.provisional && (
                  <Badge variant="outline" title={RETURNED_FEE_TITLE}>
                    tạm tính
                  </Badge>
                )}
              </span>
              <b className="whitespace-nowrap tabular-nums">
                {formatVnd(returnedFeeDisplay.fee)}
                {tiLe && <span className="ml-1 text-[12px] font-normal text-tq-chu-phu">· {tiLe}</span>}
              </b>
            </>
          ) : (
            <>
              <span>Phí sàn đơn hoàn/hủy (thực thu)</span>
              <b className="whitespace-nowrap">0 ₫ — sàn không giữ phí</b>
            </>
          )}
        </div>
        {returnedFeeDisplay.show && returnedFeeDisplay.provisional && order.platformFeeEst > 0 && (
          <p className="mt-2 text-[12px] text-tq-chu-phu">
            Phí tạm sàn treo: {formatVnd(order.platformFeeEst)} (sàn có thể hoàn — theo dõi)
          </p>
        )}
      </div>
      <p className="text-[12px] text-tq-chu-phu">
        Doanh thu và giá vốn của đơn này bị loại khỏi Lãi/Lỗ; riêng phí sàn giữ lại vẫn trừ vào lãi ròng.
      </p>
    </div>
  );
}
