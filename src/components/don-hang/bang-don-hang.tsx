"use client";

import Link from "next/link";
import type { MouseEvent, ReactNode } from "react";

import {
  ChamKenh,
  lopKieuO,
  NhanTamTinh,
  VienThuocTrangThai,
} from "@/components/don-hang/manh-hien-thi-don-hang";
import { TH, TieuDeSapXep } from "@/components/don-hang/tieu-de-sap-xep-bang-don-hang";
import { formatNgayVn } from "@/lib/dinh-dang-ngay-gio-vn";
import { formatVnd } from "@/lib/format";
import type { BoLocDonHang, DongDonHangChe, KieuSapXepDonHang, TrangDonHang } from "@/lib/orders/don-hang-kieu-du-lieu";
import { laDonHopLe, laDongLo, oLaiDon, oPhiSan, oSanPham, type OChu } from "@/lib/orders/o-dong-don-hang";
import { cn } from "@/lib/utils";

type DongHienThi = { d: DongDonHangChe; lai: OChu | null; lo: boolean };

// Ô bảng: viền dưới mảnh, đệm gọn hơn dưới 1440px để 7 cột vừa 1280px không cuộn ngang.
const O = "border-b border-[#f0f0f0] px-3 py-[11px] align-top max-[1439px]:px-2.5";
// Cột số (tiền, phí sàn, lãi) và ngày giờ dùng chữ số đều bề rộng như Trang chủ; mã đơn 18 chữ số KHÔNG dùng
// (bề rộng đều làm mã dài hơn, tràn sang cột Ngày ở 1280px).
const O_SO = `${O} text-right whitespace-nowrap tabular-nums`;
const DONG_PHU = "mt-0.5 truncate text-[12px] text-tq-chu-phu";

/** Cột độ rộng cố định (table-fixed): 1440 thoáng, 1280–1439 gọn; "Sản phẩm" nhận phần còn lại. */
function Cot(props: { className?: string }) {
  return <col className={props.className} />;
}

function DongBang(props: {
  dong: DongHienThi;
  dangMo: boolean;
  now: Date;
  coLai: boolean;
  hrefDon: (id: string) => string;
  onMoDon: (id: string) => void;
}) {
  const { dong, dangMo, now, coLai, hrefDon, onMoDon } = props;
  const { d, lai, lo } = dong;
  const hopLe = laDonHopLe(d.status);
  const phi = oPhiSan(d, now);
  const sp = oSanPham(d);

  function khiBamDong(e: MouseEvent<HTMLTableRowElement>) {
    // Người dùng đang bôi đen chữ (vd chép mã sàn) thì không mở drawer.
    if (typeof window !== "undefined" && (window.getSelection()?.toString() ?? "") !== "") return;
    if ((e.target as HTMLElement).closest("a,button")) return;
    onMoDon(d.id);
  }

  const dongPhuDon: ReactNode = d.maSan ?? (d.channelId === "direct" ? "bán tại shop" : " ");

  return (
    <tr
      data-testid="dong-don-hang"
      data-id={d.id}
      data-dong-lo={lo ? "true" : undefined}
      data-dang-mo={dangMo ? "true" : undefined}
      onClick={khiBamDong}
      className={cn(
        "cursor-pointer",
        hopLe ? "[&>td]:text-tq-chu" : "[&>td]:text-tq-chu-phu",
        dangMo ? "[&>td]:bg-[#eef3fb]" : "hover:[&>td]:bg-[#f7f7f7]",
        // Vạch trái đỏ chỉ cho đơn lỗ (hoàn/hủy không bao giờ có).
        lo && "[&>td:first-child]:shadow-[inset_3px_0_0_var(--tq-xau-chu)]",
      )}
    >
      <td className={O}>
        <Link
          href={hrefDon(d.id)}
          scroll={false}
          prefetch={false}
          onClick={(e) => e.stopPropagation()}
          className="font-semibold text-inherit hover:underline"
        >
          <span className={hopLe ? "text-tq-chu-dam" : undefined}>{d.code}</span>
        </Link>
        <div className={DONG_PHU} title={d.maSan ? `Mã sàn ${d.maSan}` : undefined}>
          {dongPhuDon}
        </div>
        {/* 1280–1439px: bảng 7 cột, kênh gộp vào ô Đơn; từ 1440px có cột Kênh riêng. */}
        <div className="mt-0.5 text-[12px] min-[1440px]:hidden">
          <ChamKenh ten={d.channelName} mau={d.channelColor} />
        </div>
      </td>
      <td className={cn(O, "tabular-nums")}>
        {formatNgayVn(d.orderedAt, "dd/MM HH:mm")}
        {d.statusChangedAt ? <div className={DONG_PHU}>cập nhật {formatNgayVn(d.statusChangedAt, "dd/MM")}</div> : null}
      </td>
      <td className={cn(O, "hidden min-[1440px]:table-cell")}>
        <ChamKenh ten={d.channelName} mau={d.channelColor} />
      </td>
      <td className={O}>
        <div className="flex min-w-0 gap-1">
          <span className="truncate" title={sp.ten}>
            {sp.ten}
          </span>
          <span className="shrink-0 text-tq-chu-phu">{sp.soLuong}</span>
        </div>
        <div className={DONG_PHU}>{sp.phu ?? " "}</div>
      </td>
      <td className={O_SO}>
        {formatVnd(d.itemsTotal)}
        <div className={DONG_PHU}>{hopLe ? " " : "không tính"}</div>
      </td>
      <td className={O_SO}>
        {phi.so}
        <div className={DONG_PHU}>
          {phi.phu ?? " "}
          {phi.tamTinh ? <NhanTamTinh /> : null}
        </div>
      </td>
      {coLai ? (
        <td className={O_SO}>
          {lai ? (
            <>
              <span
                data-testid="lai-don"
                className={cn(lai.kieu === "xam" ? "font-medium" : "font-semibold", lopKieuO(lai.kieu))}
              >
                {lai.so}
              </span>
              <div className={cn(DONG_PHU, lai.kieu !== "thuong" && lopKieuO(lai.kieu))}>{lai.phu ?? " "}</div>
            </>
          ) : null}
        </td>
      ) : null}
      <td className={O}>
        <VienThuocTrangThai status={d.status} data-testid="trang-thai-don" />
      </td>
    </tr>
  );
}

/**
 * Bảng đơn (từ 1280px). 8 cột từ 1440px, 7 cột ở 1280–1439px (Kênh gộp vào ô Đơn); không quyền giá vốn thì
 * bớt cột Lãi. Bấm bất kỳ đâu trên dòng mở drawer; mã đơn vẫn là link thật cho bàn phím/đọc màn hình.
 */
export function BangDonHang(props: {
  trang: TrangDonHang;
  boLoc: BoLocDonHang;
  now: Date;
  hrefDon: (id: string) => string;
  onMoDon: (id: string) => void;
  onSapXep: (sx: KieuSapXepDonHang) => void;
}) {
  const { trang, boLoc, now, hrefDon, onMoDon, onSapXep } = props;
  const coLai = trang.coQuyenGiaVon;

  // Lãi chỉ đọc được SAU khi narrow theo quyền — nhánh che không có `laiDon`.
  const dong: DongHienThi[] = trang.coQuyenGiaVon
    ? trang.rows.map((d) => ({ d, lai: oLaiDon(d), lo: laDongLo(d) }))
    : trang.rows.map((d) => ({ d, lai: null, lo: false }));

  return (
    <table className="w-full table-fixed border-separate border-spacing-0 text-[13px]" data-testid="bang-don-hang">
      <colgroup>
        <Cot className="w-[140px] min-[1440px]:w-[156px]" />
        <Cot className="w-[112px] min-[1440px]:w-[122px]" />
        <Cot className="hidden w-[124px] min-[1440px]:table-column" />
        <Cot />
        <Cot className="w-[114px] min-[1440px]:w-[124px]" />
        {/* Đủ chỗ cho dòng phụ dài nhất "sàn giữ · tạm tính" (đơn hủy chưa chốt phí) bằng Inter 12px. */}
        <Cot className="w-[128px] min-[1440px]:w-[134px]" />
        {coLai ? <Cot className="w-[126px] min-[1440px]:w-[140px]" /> : null}
        <Cot className="w-[116px] min-[1440px]:w-[124px]" />
      </colgroup>
      <thead>
        <tr>
          <th scope="col" className={TH}>
            Đơn
          </th>
          <TieuDeSapXep cot="ngay" nhan="Ngày" sx={boLoc.sx} onSapXep={onSapXep} />
          <th scope="col" className={cn(TH, "hidden min-[1440px]:table-cell")}>
            Kênh
          </th>
          <th scope="col" className={TH}>
            Sản phẩm
          </th>
          <TieuDeSapXep cot="tien" nhan="Tiền hàng" sx={boLoc.sx} soPhai onSapXep={onSapXep} />
          <th scope="col" className={cn(TH, "text-right")}>
            Phí sàn
          </th>
          {coLai ? <TieuDeSapXep cot="lai" nhan="Lãi đơn" sx={boLoc.sx} soPhai onSapXep={onSapXep} /> : null}
          <th scope="col" className={TH}>
            Trạng thái
          </th>
        </tr>
      </thead>
      <tbody>
        {dong.map((x) => (
          <DongBang
            key={x.d.id}
            dong={x}
            dangMo={boLoc.don === x.d.id}
            now={now}
            coLai={coLai}
            hrefDon={hrefDon}
            onMoDon={onMoDon}
          />
        ))}
      </tbody>
    </table>
  );
}
