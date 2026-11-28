import Link from "next/link";
import type { ReactNode } from "react";

import { HuyHieuThayDoi } from "@/components/trang-chu/huy-hieu-thay-doi";
import { formatSoDem, formatVnd } from "@/lib/format";
import type { TongDonHangChe, TrangDonHang } from "@/lib/orders/don-hang-kieu-du-lieu";
import { chuThichKhopBangLaiLo, type KhopBangLaiLo } from "@/lib/orders/khop-bang-lai-lo";
import { phanTramCoDau } from "@/lib/orders/o-dong-don-hang";
import { phanTramThayDoi } from "@/lib/trang-chu/so-sanh-ky";
import { cn } from "@/lib/utils";

/** Một thẻ số tĩnh (không bấm được, không đường nhỏ) cùng khung với thẻ số trang chủ. */
function The(props: {
  testId: string;
  nhan: string;
  giaTri: string;
  mauSo?: string;
  huyHieu: ReactNode;
  dongPhu: ReactNode;
  className?: string;
  /** Lớp cho dòng nhãn — dành chỗ 2 dòng để số lớn thẳng hàng giữa các thẻ cùng hàng khi một nhãn xuống dòng. */
  nhanClassName?: string;
}) {
  return (
    <div
      data-testid={props.testId}
      className={cn("flex min-w-0 flex-col gap-1.5 rounded-xl bg-tq-the p-3 shadow-tq-the sm:p-4", props.className)}
    >
      <span className={cn("text-[12px] font-medium text-tq-chu-phu", props.nhanClassName)}>{props.nhan}</span>
      <span
        data-testid="gia-tri"
        className={cn("truncate text-lg font-semibold tabular-nums sm:text-2xl", props.mauSo ?? "text-tq-chu-dam")}
      >
        {props.giaTri}
      </span>
      {props.huyHieu ? <span className="flex flex-wrap items-center gap-1.5 text-[12px] text-tq-chu-phu">{props.huyHieu}</span> : null}
      <span className="text-[12px] text-tq-chu-phu">{props.dongPhu}</span>
    </div>
  );
}

/**
 * Nhãn "Tiền sau voucher và phí sàn" xuống 2 dòng ở thẻ hẹp (hai cột dưới 1024px; bốn cột từ 1024 tới dưới
 * 1280px). Hai thẻ đứng cạnh nó cùng hàng dành sẵn 2 dòng nhãn để số lớn không lệch nhau; từ 1280px nhãn
 * vừa một dòng nên bỏ chỗ dành sẵn.
 */
const NHAN_CAO_CUNG_HANG_DUOI = "max-xl:min-h-9"; // thẻ thứ ba + thẻ Lãi (cùng hàng dưới 1024px)
const NHAN_CAO_CUNG_HANG_BON_COT = "lg:max-xl:min-h-9"; // hai thẻ đầu: chỉ cùng hàng khi đủ bốn cột

/** Tỉ lệ trên Tiền hàng, "—" khi Tiền hàng 0 (không chia 0); số âm mang dấu trừ U+2212 như dòng đơn. */
const tiLe = phanTramCoDau;

/**
 * Bốn thẻ số của các đơn đang lọc (spec §4.2). Số do truy vấn trả sẵn — component chỉ định dạng, không cộng
 * lại. Nhánh thiếu quyền giá vốn KHÔNG có thẻ Lãi (kiểu `TrangDonHangChe` cũng không mang số lãi).
 * Huy hiệu so kỳ trước dùng `tangLaTot` cho cả bốn thẻ; không so khi `kyTruoc` null (tất cả thời gian / đang
 * tìm / chip phí tạm tính).
 *
 * Phí sàn đơn hoàn/hủy (`phiSanGiuHoanHuy`, không phải giá vốn) hiện ở thẻ Tiền sau voucher và phí sàn cho MỌI người khi > 0 —
 * đó là số duy nhất có nghĩa khi tập chỉ gồm đơn hoàn/hủy. `hrefThieuGiaVon` = link bật chip "Thiếu giá vốn"
 * (null khi chip đã bật).
 */
export function TheSoDonHang(props: {
  trang: TrangDonHang;
  dangTim: boolean;
  khop: KhopBangLaiLo;
  hrefThieuGiaVon: string | null;
}) {
  const { trang, dangTim, khop, hrefThieuGiaVon } = props;
  const tong: TongDonHangChe = trang.tong;
  const truoc: TongDonHangChe | null = trang.kyTruoc?.tong ?? null;

  const huyHieu = (nay: number, kyTruoc: number | undefined) =>
    kyTruoc === undefined ? null : <HuyHieuThayDoi phanTram={phanTramThayDoi(nay, kyTruoc)} tangLaTot />;

  const coLai = trang.coQuyenGiaVon;
  const lai = trang.coQuyenGiaVon ? trang.tong.lai : 0;
  const laiTruoc = trang.coQuyenGiaVon && trang.kyTruoc ? trang.kyTruoc.tong.lai : undefined;
  const soThieuGiaVon = trang.coQuyenGiaVon ? trang.tong.soDonThieuGiaVon : 0;
  const chuThich = chuThichKhopBangLaiLo(khop, tong.phiSanGiuHoanHuy, coLai);
  // Tập chỉ có đơn hoàn/hủy: "phí sàn — · voucher —" chẳng nói gì — chỉ giữ số phí sàn đơn hoàn/hủy.
  const anTiLe = tong.tienHang === 0 && tong.phiSanGiuHoanHuy > 0;

  return (
    <div className="flex flex-col gap-2.5">
      <section
        aria-label="Tổng của các đơn đang lọc"
        className={cn("grid grid-cols-2 gap-2.5 lg:gap-3.5", coLai ? "lg:grid-cols-4" : "lg:grid-cols-3")}
      >
        <The
          testId="the-so-don"
          nhan="Đơn"
          nhanClassName={NHAN_CAO_CUNG_HANG_BON_COT}
          giaTri={`${formatSoDem(tong.soDon)} đơn`}
          huyHieu={
            <>
              {huyHieu(tong.soDon, truoc?.soDon)}
              {dangTim ? <span>không so kỳ khi đang tìm</span> : null}
            </>
          }
          dongPhu={`${formatSoDem(tong.soHopLe)} hợp lệ · ${formatSoDem(tong.soHoanHuy)} hoàn/hủy`}
        />
        <The
          testId="the-so-tien-hang"
          nhan="Tiền hàng"
          nhanClassName={NHAN_CAO_CUNG_HANG_BON_COT}
          giaTri={formatVnd(tong.tienHang)}
          huyHieu={huyHieu(tong.tienHang, truoc?.tienHang)}
          dongPhu="không tính đơn hoàn/hủy"
        />
        <The
          testId="the-so-thuc-nhan"
          // Số TÍNH TỪ ĐƠN (tiền hàng − voucher − phí sàn), không phải tiền đã về tài khoản ⇒ nhãn nói đúng
          // phép tính, không nói "thực nhận". Dòng cùng số ở bảng Lãi/Lỗ vẫn tên "Thực nhận từ sàn".
          nhan="Tiền sau voucher và phí sàn"
          nhanClassName={NHAN_CAO_CUNG_HANG_DUOI}
          giaTri={formatVnd(tong.thucNhan)}
          huyHieu={huyHieu(tong.thucNhan, truoc?.thucNhan)}
          // `title` mang số tiền (đã có dấu trừ) cho rê chuột — và là chỗ e2e đối chiếu dòng "Phí sàn" /
          // "Doanh thu" của bảng Lãi/Lỗ.
          dongPhu={
            <>
              {anTiLe ? null : (
                <>
                  {"phí sàn "}
                  <span data-testid="phi-san-tong" title={`Phí sàn ${formatVnd(-tong.phiSan)}`}>
                    {tiLe(tong.phiSan, tong.tienHang)}
                  </span>
                  {" · voucher "}
                  <span data-testid="voucher-tong" title={`Voucher ${formatVnd(-tong.voucher)}`}>
                    {tiLe(tong.voucher, tong.tienHang)}
                  </span>
                </>
              )}
              {tong.phiSanGiuHoanHuy > 0 ? (
                <span data-testid="phi-san-hoan-huy-tong" className="block">
                  {`phí sàn đơn hoàn/hủy ${formatVnd(-tong.phiSanGiuHoanHuy)}`}
                </span>
              ) : null}
            </>
          }
          // Không quyền: còn 3 thẻ, thẻ thứ ba chiếm cả hàng dưới 1024px (2 cột).
          className={coLai ? undefined : "col-span-2 lg:col-span-1"}
        />
        {trang.coQuyenGiaVon ? (
          <The
            testId="the-so-lai"
            nhan="Lãi đơn"
            nhanClassName={NHAN_CAO_CUNG_HANG_DUOI}
            giaTri={formatVnd(lai)}
            mauSo={lai < 0 ? "text-tq-xau-chu" : lai > 0 ? "text-tq-loi-nhuan-chu" : undefined}
            huyHieu={huyHieu(lai, laiTruoc)}
            dongPhu={
              <>
                {`biên ${tiLe(lai, tong.tienHang)} · chưa gồm quảng cáo, chi phí chung`}
                {soThieuGiaVon > 0 ? <CanhBaoThieuGiaVon so={soThieuGiaVon} href={hrefThieuGiaVon} /> : null}
              </>
            }
          />
        ) : null}
      </section>

      <p
        data-testid="ghi-chu-the"
        role="status"
        className={cn(
          "text-[11.5px] text-tq-chu-phu",
          chuThich ? "px-0.5" : "rounded-lg bg-warning/10 px-3 py-2 text-tq-chu-dam",
        )}
      >
        {chuThich ?? (
          <>
            Đang lọc — số trên thẻ chỉ gồm <b>{formatSoDem(tong.soDon)} đơn</b> khớp bộ lọc, <b>không</b> khớp bảng
            Lãi/Lỗ của tháng. Xóa lọc để đối chiếu.
          </>
        )}
      </p>
    </div>
  );
}

/** Dòng cảnh báo dưới thẻ Lãi: lãi đang cao hơn thực tế vì có đơn thiếu giá vốn; bấm = bật chip "Thiếu giá vốn". */
function CanhBaoThieuGiaVon({ so, href }: { so: number; href: string | null }) {
  const chu = `⚠ ${formatSoDem(so)} đơn thiếu giá vốn — lãi đang cao hơn thực tế`;
  const lop = "mt-0.5 block text-warning";
  return href ? (
    <Link href={href} scroll={false} data-testid="canh-bao-thieu-gia-von" className={cn(lop, "underline-offset-2 hover:underline")}>
      {chu}
    </Link>
  ) : (
    <span data-testid="canh-bao-thieu-gia-von" className={lop}>
      {chu}
    </span>
  );
}
