import Link from "next/link";
import { differenceInCalendarDays, format } from "date-fns";

import type { SoQuyThangDayDu } from "@/lib/so-quy/so-quy-queries";

import { ShopeeImportButton } from "./shopee-import-button";

/**
 * Khối cảnh báo dữ liệu của thẻ "Quỹ còn lại" — tách khỏi `so-quy-card.tsx` để file đó dưới 200
 * dòng. Chỉ hiện khi CÓ ít nhất một dòng; mỗi dòng là một khoản quỹ đang thiếu.
 */

const NGAY_VI_COI_LA_CU = 15;

export function SoQuyCanhBao({
  soQuy,
  soKhoanVayCoKyCho,
  hrefKhoanVay = "#khoan-vay",
}: {
  soQuy: SoQuyThangDayDu;
  /** Số KHOẢN VAY còn hiệu lực đang có kỳ chờ duyệt (tối đa 1 kỳ/khoản) — page tính từ `listKhoanVay()`. */
  soKhoanVayCoKyCho: number;
  /** Đích của dòng "khoản vay có kỳ chưa ghi" — mặc định neo khối Khoản vay trên CÙNG trang (tab Dòng tiền). */
  hrefKhoanVay?: string;
}) {
  const c = soQuy.canhBao;
  const viCu =
    c.shopeeViToiNgay !== null &&
    differenceInCalendarDays(new Date(), c.shopeeViToiNgay) > NGAY_VI_COI_LA_CU;
  const coDong =
    c.tiktokPaidThieuNgay > 0 ||
    c.shopeeThieuTruocD0 ||
    viCu ||
    c.shopeeChuaPhanLoai > 0 ||
    c.coDinhKyActive ||
    c.adsViVuotSo ||
    soKhoanVayCoKyCho > 0;
  if (!coDong) return null;

  return (
    <div className="mt-3 flex flex-col gap-1.5 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-700">
      {c.tiktokPaidThieuNgay > 0 && (
        <p>⚠️ {c.tiktokPaidThieuNgay} lệnh TikTok đã trả nhưng thiếu ngày — chưa vào quỹ</p>
      )}
      {c.shopeeThieuTruocD0 && c.shopeeViTuNgay !== null && (
        <p>
          ⚠️ ví Shopee chỉ có dữ liệu từ {format(c.shopeeViTuNgay, "dd/MM")} — thiếu tiền rút Shopee
          trước đó
        </p>
      )}
      {viCu && c.shopeeViToiNgay !== null && (
        <p className="flex flex-wrap items-center gap-2">
          <span>⚠️ ví Shopee mới nhập tới {format(c.shopeeViToiNgay, "dd/MM")}</span>
          <ShopeeImportButton nhan="Nhập file ví Shopee" />
        </p>
      )}
      {/* "(toàn bộ)" là chỗ KHÁC với câu cùng chữ ở card Shopee bên dưới — câu kia đếm TRONG KỲ. */}
      {c.shopeeChuaPhanLoai > 0 && (
        <p>⚠️ {c.shopeeChuaPhanLoai} giao dịch Shopee chưa phân loại (toàn bộ)</p>
      )}
      {c.coDinhKyActive && <p>⚠️ chi phí định kỳ chỉ được ghi khi tháng đó được mở xem</p>}
      {c.adsViVuotSo && (
        <p>⚠️ sàn trừ ví ads TikTok nhiều hơn ads đã ghi Sổ chi phí — quỹ đang tính dư</p>
      )}
      {soKhoanVayCoKyCho > 0 && (
        <Link href={hrefKhoanVay} className="underline underline-offset-2">
          ⚠️ {soKhoanVayCoKyCho} khoản vay có kỳ trả nợ chưa ghi
        </Link>
      )}
    </div>
  );
}
