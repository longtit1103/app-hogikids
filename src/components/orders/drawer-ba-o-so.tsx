import type { ReactNode } from "react";

import { formatVnd } from "@/lib/format";
import { phanTramCoDau } from "@/lib/orders/o-dong-don-hang";
import { cn } from "@/lib/utils";

/**
 * Ba ô số đầu drawer: Tiền hàng · Tiền sau voucher và phí sàn · Lãi đơn (hai ô khi không có quyền giá vốn).
 * Mọi số do drawer truyền vào từ CÙNG cây `buildOrderProfitLines` mà khối "Tiền của đơn" vẽ — ô này
 * không tự cộng trừ lần thứ hai.
 *
 * Đơn hoàn/hủy không tính vào Lãi/Lỗ: Tiền hàng xám, Tiền sau voucher và phí sàn "—", Lãi chỉ là phần phí sàn sàn giữ
 * (xám, KHÔNG BAO GIỜ đỏ như đơn lỗ).
 */
export type DrawerBaOSoProps = {
  daLoai: boolean; // đơn hoàn/hủy
  soDongHang: number;
  itemsTotal: number;
  thucNhan: number; // dòng "Thực nhận từ sàn" của cây
  kenhTrucTiep: boolean;
  returnedFee: number;
  /** null = không có quyền giá vốn ⇒ không ô Lãi. `giaTri` = dòng "Lãi đơn" của cây. */
  lai: { giaTri: number; soDongThieuGiaVon: number } | null;
};

function O({ nhan, giaTri, phu, mau }: { nhan: string; giaTri: string; phu: ReactNode; mau?: string }) {
  return (
    // Cột dọc, nhãn `flex-1`: nhãn dài ("Tiền sau voucher và phí sàn") xuống 2–3 dòng ở điện thoại thì phần dư
    // dồn vào nhãn, số lớn của ba ô vẫn nằm cùng một hàng (lưới giãn ba ô cao bằng nhau).
    <div className="flex min-w-0 flex-col rounded-xl bg-tq-the p-2.5 shadow-tq-the sm:px-3.5 sm:py-3">
      <div className="flex-1 text-[12px] font-medium text-tq-chu-phu">{nhan}</div>
      <div className={cn("mt-1 text-sm font-semibold whitespace-nowrap tabular-nums sm:text-lg", mau ?? "text-tq-chu-dam")}>
        {giaTri}
      </div>
      <div className="mt-0.5 text-[12px] text-tq-chu-phu">{phu}</div>
    </div>
  );
}

export function DrawerBaOSo(p: DrawerBaOSoProps) {
  const xam = "text-tq-chu-phu";

  let oLai: ReactNode = null;
  if (p.lai) {
    if (p.daLoai) {
      const giu = p.returnedFee > 0;
      oLai = (
        <O
          nhan="Lãi đơn"
          giaTri={giu ? formatVnd(-p.returnedFee) : "—"}
          phu={giu ? "phí sàn giữ" : "sàn không giữ phí"}
          mau={xam}
        />
      );
    } else {
      const { giaTri, soDongThieuGiaVon } = p.lai;
      oLai = (
        <O
          nhan="Lãi đơn"
          giaTri={formatVnd(giaTri)}
          mau={giaTri < 0 ? "text-tq-xau-chu" : "text-tq-loi-nhuan-chu"}
          phu={
            soDongThieuGiaVon > 0 ? (
              <span className="text-warning">⚠ thiếu giá vốn</span>
            ) : p.itemsTotal > 0 ? (
              `biên ${phanTramCoDau(giaTri, p.itemsTotal)}`
            ) : (
              "biên —"
            )
          }
        />
      );
    }
  }

  return (
    <div className={cn("grid gap-1.5 sm:gap-2.5", oLai ? "grid-cols-3" : "grid-cols-2")}>
      <O
        nhan="Tiền hàng"
        giaTri={formatVnd(p.itemsTotal)}
        phu={p.daLoai ? "không tính (hoàn/hủy)" : `${p.soDongHang} dòng hàng`}
        mau={p.daLoai ? xam : undefined}
      />
      <O
        nhan="Tiền sau voucher và phí sàn"
        giaTri={p.daLoai ? "—" : formatVnd(p.thucNhan)}
        phu={p.daLoai ? "đơn hoàn/hủy" : p.kenhTrucTiep ? "không phí sàn" : "app tính từ đơn"}
        mau={p.daLoai ? xam : undefined}
      />
      {oLai}
    </div>
  );
}
