import { PROVISIONAL_FEE_TITLE } from "@/lib/orders/provisional-fee";
import type { PnlLineItem } from "@/lib/reports/pnl-line-items";
import type { OrderDetail } from "@/lib/queries/orders";
import { DrawerKhoiThe } from "./drawer-khoi-the";
import { OrderProfitTree } from "./order-profit-tree";
import { OrderReturnedPanel } from "./order-returned-panel";

/**
 * Hai khối tiền của drawer đơn:
 *  1. "Tiền của đơn" — cây app TỰ TÍNH (`buildOrderProfitLines`, vẽ y như bảng Lãi/Lỗ), hoặc khối
 *     hoàn/hủy thay cho cây (đơn không tính vào Lãi/Lỗ).
 *  2. "Sàn quyết toán" — số SÀN thật trả về, đặt CẠNH để đối chiếu, TUYỆT ĐỐI không trộn vào phép tính
 *     của (1) (đếm hai lần). Chỉ hiện khi đơn đã quyết toán.
 */
export function DrawerTienCuaDon({
  daLoai,
  order,
  returnedFeeDisplay,
  dongLai,
  phiTamTinh,
  phiSanThat,
  coGiaVon,
  soDongThieuGiaVon,
  tiLePhiSan,
}: {
  daLoai: boolean;
  order: Pick<OrderDetail, "itemsTotal" | "platformFeeEst" | "status">;
  returnedFeeDisplay: { show: boolean; fee: number; provisional: boolean };
  /** Cây đã cắt nhánh giá vốn khi không quyền. */
  dongLai: PnlLineItem[];
  phiTamTinh: boolean;
  /** Shopee/TikTok = phí sàn THẬT từ Pancake; kênh khác = ước tính % kênh. */
  phiSanThat: boolean;
  coGiaVon: boolean;
  soDongThieuGiaVon: number;
  tiLePhiSan: string | null;
}) {
  return (
    <DrawerKhoiThe tieuDe="Tiền của đơn">
      {daLoai ? (
        <OrderReturnedPanel order={order} returnedFeeDisplay={returnedFeeDisplay} />
      ) : (
        <div className="flex flex-col gap-2">
          <OrderProfitTree
            items={dongLai}
            badges={phiTamTinh ? { platformFee: { label: "tạm tính", title: PROVISIONAL_FEE_TITLE } } : undefined}
            amountNotes={tiLePhiSan ? { platformFee: tiLePhiSan } : undefined}
          />
          <p className="text-[12px] text-tq-chu-phu">
            {phiSanThat ? "Phí sàn là số THẬT sàn trả về (qua Pancake)." : "Phí sàn ước tính theo % kênh (Cài đặt)."}
            {phiTamTinh &&
              " Sàn chưa đối soát xong — phí thật thường cao hơn (~27-36%), nên LÃI THẬT sẽ thấp hơn số đang hiện; tự cập nhật khi đơn được đồng bộ lại."}
            {coGiaVon && " Chưa gồm chi phí chung (ads, vận chuyển, đóng gói…)."}
            {soDongThieuGiaVon > 0 && ` ⚠ ${soDongThieuGiaVon} dòng chưa có giá vốn — lãi đang tính thiếu.`}
          </p>
        </div>
      )}
    </DrawerKhoiThe>
  );
}

export function DrawerSanQuyetToan({ dongQuyetToan }: { dongQuyetToan: PnlLineItem[] }) {
  return (
    <DrawerKhoiThe tieuDe="Sàn quyết toán" phu="số sàn thật trả về, đặt cạnh để đối chiếu">
      <div className="flex flex-col gap-2">
        <OrderProfitTree items={dongQuyetToan} />
        <p className="text-[12px] text-tq-chu-phu">
          Số trên là số SÀN thật sự trả về khi quyết toán — độc lập với số app tính ở trên, không cái nào sửa cái
          nào.
        </p>
      </div>
    </DrawerKhoiThe>
  );
}
