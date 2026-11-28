import type { Ref } from "react";

import { usesRealPlatformFee } from "@/lib/channels/real-fee-channels";
import { KENH_BAN_TRUC_TIEP } from "@/lib/channels/kenh-ban-truc-tiep";
import type { ThongTinPhuDon } from "@/lib/orders/don-hang-kieu-du-lieu";
import { buildOrderProfitLines, buildSettlementLines } from "@/lib/orders/order-detail-lines";
import { calcOrderCogs } from "@/lib/orders/order-profit";
import { formatPlatformFeeRatio, isProvisionalPlatformFee, returnedOrderFeeDisplay } from "@/lib/orders/provisional-fee";
import type { OrderDetailTheoQuyen } from "@/lib/queries/orders";
import { DrawerBaOSo } from "./drawer-ba-o-so";
import { DrawerDauDon, type DieuHuongDon } from "./drawer-dau-don";
import { DrawerDongThoiGian } from "./drawer-dong-thoi-gian";
import { DrawerSanPhamTrongDon } from "./drawer-san-pham-trong-don";
import { DrawerSanQuyetToan, DrawerTienCuaDon } from "./drawer-tien-cua-don";

/**
 * Ruột drawer đơn (đầu + thân cuộn). Tách khỏi vỏ `Sheet` để dựng được ngoài cổng (portal) khi kiểm thử,
 * và để mỗi file ngắn. Phải nằm trong một `Sheet` (tiêu đề dùng ngữ cảnh hộp thoại).
 *
 * Số tiền KHÔNG có công thức riêng ở đây: ba ô số, cây "Tiền của đơn" và cột Lãi dòng đều đọc từ cùng
 * `buildOrderProfitLines` / `calcOrderCogs` (giá vốn HIỆN HÀNH). "Sàn quyết toán" là mạch độc lập.
 */

/** Dòng cây chỉ có nghĩa khi biết giá vốn — cắt khỏi cây ở nhánh che. */
function laDongGiaVon(id: string): boolean {
  return id === "cogs" || id.startsWith("cogs:") || id === "profit";
}

export function DrawerNoiDung({
  order,
  thongTinPhu,
  dieuHuong,
  now,
  onDong,
  refNutDong,
}: {
  order: OrderDetailTheoQuyen;
  thongTinPhu: ThongTinPhuDon | null;
  dieuHuong: DieuHuongDon | null;
  /** Mốc "bây giờ" của server (cùng mốc danh sách) — nhãn "tạm tính" không phụ thuộc giờ máy khách. */
  now: Date;
  onDong: () => void;
  refNutDong?: Ref<HTMLButtonElement>;
}) {
  const coGiaVon = order.coQuyenGiaVon;
  // Nhánh che: đưa `costPrice: null`/`cogs: 0` cho hàm dựng cây rồi CẮT các dòng phụ thuộc giá vốn — số
  // trên các dòng còn lại (doanh thu, phí sàn, thực nhận) không dùng tới chúng.
  const itemsTinh = order.coQuyenGiaVon ? order.items : order.items.map((it) => ({ ...it, costPrice: null }));
  const { cogs, missingCostCount } = order.coQuyenGiaVon
    ? calcOrderCogs(order.items)
    : { cogs: 0, missingCostCount: 0 };
  const daLoai = order.status === "RETURNED" || order.status === "CANCELLED";

  // Cây tính LUÔN cho mọi đơn (thuần, rẻ): khối quyết toán cần "Tiền sau voucher và phí sàn" của app, ba ô số đọc
  // dòng Thực nhận / Lãi của chính cây này.
  const tatCaDong = buildOrderProfitLines({
    itemsTotal: order.itemsTotal,
    discount: order.discount,
    platformFeeEst: order.platformFeeEst,
    cogs,
    items: itemsTinh,
    feeComponents: order.feeComponents,
    marketplaceFunded: order.marketplaceFunded,
  });
  const dongLai = coGiaVon ? tatCaDong : tatCaDong.filter((l) => !laDongGiaVon(l.id));
  const thucNhan = dongLai.find((l) => l.id === "netRevenue")?.value ?? 0;
  const laiDon = tatCaDong.find((l) => l.id === "profit")?.value ?? 0;
  // Đơn hoàn/hủy không có "thực nhận" (app cố tình loại khỏi Lãi/Lỗ) ⇒ truyền null để bỏ dòng chênh, thay
  // vì trừ một số không tồn tại rồi đỏ rực bằng đúng giá trị đơn.
  const dongQuyetToan = order.quyetToan ? buildSettlementLines(order.quyetToan, daLoai ? null : thucNhan) : null;

  return (
    <>
        <DrawerDauDon order={order} dieuHuong={dieuHuong} onDong={onDong} refNutDong={refNutDong} />

        <div className="flex min-h-0 flex-1 flex-col gap-3.5 overflow-x-hidden overflow-y-auto overscroll-contain px-3 pt-3 pb-8 sm:px-5 sm:pt-4">
          <DrawerBaOSo
            daLoai={daLoai}
            soDongHang={order.items.length}
            itemsTotal={order.itemsTotal}
            thucNhan={thucNhan}
            kenhTrucTiep={order.channelId === KENH_BAN_TRUC_TIEP}
            returnedFee={order.returnedFee}
            lai={coGiaVon ? { giaTri: laiDon, soDongThieuGiaVon: missingCostCount } : null}
          />
          {thongTinPhu && <DrawerDongThoiGian moc={thongTinPhu.dongThoiGian} />}
          <DrawerSanPhamTrongDon items={order.items} coGiaVon={coGiaVon} daLoai={daLoai} />
          <DrawerTienCuaDon
            daLoai={daLoai}
            order={order}
            returnedFeeDisplay={returnedOrderFeeDisplay(order, now)}
            dongLai={dongLai}
            phiTamTinh={isProvisionalPlatformFee(order)}
            phiSanThat={usesRealPlatformFee(order.channelId)}
            coGiaVon={coGiaVon}
            soDongThieuGiaVon={missingCostCount}
            tiLePhiSan={formatPlatformFeeRatio(order.platformFeeEst, order.itemsTotal)}
          />
          {dongQuyetToan && <DrawerSanQuyetToan dongQuyetToan={dongQuyetToan} />}
        </div>
    </>
  );
}
