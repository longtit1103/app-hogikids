import Link from "next/link";

import {
  ChamKenh,
  lopKieuO,
  NhanTamTinh,
  VienThuocTrangThai,
} from "@/components/don-hang/manh-hien-thi-don-hang";
import { formatNgayVn } from "@/lib/dinh-dang-ngay-gio-vn";
import { formatVnd } from "@/lib/format";
import type { DongDonHangChe, TrangDonHang } from "@/lib/orders/don-hang-kieu-du-lieu";
import { laDonHopLe, laDongLo, oLaiDon, oPhiSan, oSanPham, type OChu } from "@/lib/orders/o-dong-don-hang";
import { cn } from "@/lib/utils";

function Cot(props: { nhan: string; chu: string; kieu?: OChu["kieu"]; canPhai?: boolean }) {
  return (
    <span className={cn("block min-w-0", props.canPhai && "text-right")}>
      <span className="block text-[11px] text-tq-chu-phu">{props.nhan}</span>
      <b className={cn("block text-[13px] font-semibold whitespace-nowrap", props.kieu ? lopKieuO(props.kieu) : "text-tq-chu-dam")}>
        {props.chu}
      </b>
    </span>
  );
}

function TheDon(props: {
  d: DongDonHangChe;
  lai: OChu | null;
  lo: boolean;
  dangMo: boolean;
  now: Date;
  href: string;
}) {
  const { d, lai, lo, dangMo, now, href } = props;
  const hopLe = laDonHopLe(d.status);
  const phi = oPhiSan(d, now);
  const sp = oSanPham(d);
  const them = d.soDongHang > 1 ? `+${d.soDongHang - 1}` : null;

  return (
    // Cả thẻ là một link thật (bấm/Enter mở drawer) — không cần onClick riêng như dòng bảng.
    <Link
      href={href}
      scroll={false}
      prefetch={false}
      data-testid="the-don-hang"
      data-dong-lo={lo ? "true" : undefined}
      data-dang-mo={dangMo ? "true" : undefined}
      className={cn(
        "block rounded-[10px] border border-[#ebebeb] p-3 tabular-nums hover:bg-[#f7f7f7]",
        dangMo ? "bg-[#eef3fb]" : "bg-white",
        lo && "shadow-[inset_3px_0_0_var(--tq-xau-chu)]",
        hopLe ? "text-tq-chu" : "text-tq-chu-phu",
      )}
    >
      <span className="flex items-center gap-2">
        <span className={cn("text-sm font-semibold normal-nums", hopLe ? "text-tq-chu-dam" : "text-tq-chu-phu")}>{d.code}</span>
        <span className="mr-auto text-[12px] text-tq-chu-phu">{formatNgayVn(d.orderedAt, "dd/MM HH:mm")}</span>
        <VienThuocTrangThai status={d.status} data-testid="trang-thai-don-the" />
      </span>
      <span className="mt-1.5 flex min-w-0 items-center gap-1.5 text-[13px]">
        <span className="min-w-0 truncate">
          {sp.ten} {sp.soLuong}
        </span>
        {them ? <span className="shrink-0 text-[12px] text-tq-chu-phu">{them}</span> : null}
        <ChamKenh ten={d.channelName} mau={d.channelColor} className="ml-auto shrink-0 text-[12px] text-tq-chu-phu" />
      </span>
      <span
        className={cn(
          "mt-2.5 grid gap-2 border-t border-[#f0f0f0] pt-2.5",
          lai ? "grid-cols-3" : "grid-cols-2",
        )}
      >
        <Cot nhan="Tiền hàng" chu={formatVnd(d.itemsTotal)} />
        <span className="block min-w-0 text-right">
          <span className="block text-[11px] text-tq-chu-phu">Phí sàn</span>
          <b className="block text-[13px] font-semibold whitespace-nowrap text-tq-chu-dam">
            {phi.so}
            {phi.tamTinh ? <NhanTamTinh /> : null}
          </b>
        </span>
        {lai ? <Cot nhan="Lãi đơn" chu={lai.so} kieu={lai.kieu} canPhai /> : null}
      </span>
    </Link>
  );
}

/**
 * Danh sách thẻ đơn cho màn dưới 1280px (1 cột dưới 900px, 2 cột từ 900px). Ba tầng: mã · giờ · trạng thái /
 * sản phẩm · kênh / Tiền hàng · Phí sàn · Lãi đơn (không quyền giá vốn: 2 ô). Đơn lỗ có vạch trái đỏ; đơn
 * hoàn/hủy chữ xám.
 */
export function TheDonHangDienThoai(props: {
  trang: TrangDonHang;
  donDangMo: string | null;
  now: Date;
  hrefDon: (id: string) => string;
}) {
  const { trang, donDangMo, now, hrefDon } = props;
  // Lãi chỉ đọc được SAU khi narrow theo quyền — nhánh che không có `laiDon`.
  const dong = trang.coQuyenGiaVon
    ? trang.rows.map((d) => ({ d, lai: oLaiDon(d), lo: laDongLo(d) }))
    : trang.rows.map((d) => ({ d, lai: null, lo: false }));

  return (
    <div className="grid grid-cols-1 gap-2.5 px-3 pt-1 pb-3 min-[900px]:grid-cols-2" data-testid="ds-the-don-hang">
      {dong.map((x) => (
        <TheDon key={x.d.id} d={x.d} lai={x.lai} lo={x.lo} dangMo={donDangMo === x.d.id} now={now} href={hrefDon(x.d.id)} />
      ))}
    </div>
  );
}
