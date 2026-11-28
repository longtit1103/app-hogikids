import type { OrderStatus } from "@/generated/prisma/client";

import { parseDateRange, resolveRangePreset } from "@/lib/date-range";
import { formatNgayVn } from "@/lib/dinh-dang-ngay-gio-vn";
import {
  CHIP_CAN_GIA_VON,
  CHIP_LOC_DON_HANG,
  KIEU_SAP_XEP_DON_HANG,
  SAP_XEP_CAN_GIA_VON,
  type BoLocDonHang,
  type ChipLocDonHang,
  type KieuSapXepDonHang,
  type KyLocDonHang,
  type ThamSoDonHang,
} from "@/lib/orders/don-hang-kieu-du-lieu";
import { slugToStatus } from "@/lib/orders/order-status-meta";
import { docSoTrang } from "@/lib/pagination";
import type { QuyenGiaVon } from "@/lib/queries/che-gia-von-types";

/**
 * Đọc/ghi query trang Đơn hàng (hợp đồng URL ở spec trang đơn hàng mới §3). Hàm thuần, không I/O.
 *
 * Bộ đọc là LỚP 1 của che giá vốn: chip `lo`/`thieu_gv` và sắp `lai_*` bị bỏ NGAY tại đây khi người
 * xem thiếu quyền giá vốn — tập đơn sau lọc hay thứ tự dòng đều tự lộ lãi. Hàm truy vấn kẹp lại một
 * lần nữa (lớp 2); đừng bỏ lớp nào.
 */

type ThamSoTho = Readonly<Record<string, string | undefined>>;

const SO_KENH_TOI_DA = 10;
const DO_DAI_TIM_TOI_DA = 100;
const DUONG_DAN = "/don-hang";

/** Tách chuỗi phẩy: trim, bỏ rỗng, bỏ trùng (giữ thứ tự xuất hiện đầu tiên). */
function tachDanhSach(giaTri: string | undefined): string[] {
  return [...new Set((giaTri ?? "").split(",").map((s) => s.trim()).filter(Boolean))];
}

function docKy(sp: ThamSoTho, now: Date): KyLocDonHang {
  // Ngày hợp lệ (đủ hai vế, đúng khuôn, không đảo ngược) luôn thắng `ky`.
  const range = sp.ngay_tu && sp.ngay_den ? parseDateRange({ tu: sp.ngay_tu, den: sp.ngay_den }) : null;
  if (range) return { loai: "khoang", from: range.from, to: range.to, nguon: "url" };
  if (sp.ky === "tat_ca") return { loai: "tat_ca" };
  // Không ngày hợp lệ ⇒ trọn Tháng này (gồm cả ngày hỏng — cùng luật "không có ngày").
  const thangNay = resolveRangePreset("this_month", now);
  return { loai: "khoang", from: thangNay.from, to: thangNay.to, nguon: "mac_dinh" };
}

function laChip(s: string): s is ChipLocDonHang {
  return (CHIP_LOC_DON_HANG as readonly string[]).includes(s);
}

function laKieuSapXep(s: string): s is KieuSapXepDonHang {
  return (KIEU_SAP_XEP_DON_HANG as readonly string[]).includes(s);
}

export function docThamSoDonHang(sp: ThamSoTho, quyen: QuyenGiaVon, now: Date): BoLocDonHang {
  const statuses: OrderStatus[] = [...new Set(slugToStatus(sp.trang_thai ?? ""))];

  const loc = tachDanhSach(sp.loc)
    .filter(laChip)
    .filter((c) => quyen.coQuyenGiaVon || !CHIP_CAN_GIA_VON.includes(c));

  const sxTho = sp.sx ?? "";
  const sx: KieuSapXepDonHang =
    laKieuSapXep(sxTho) && (quyen.coQuyenGiaVon || !SAP_XEP_CAN_GIA_VON.includes(sxTho)) ? sxTho : "moi";

  // Cắt theo ký tự Unicode (không theo đơn vị UTF-16) để không tách đôi emoji/ký tự ghép.
  const q = Array.from((sp.q ?? "").trim()).slice(0, DO_DAI_TIM_TOI_DA).join("");
  const don = (sp.don ?? "").trim();

  return {
    ky: docKy(sp, now),
    statuses,
    channels: tachDanhSach(sp.kenh).slice(0, SO_KENH_TOI_DA),
    q,
    loc,
    sx,
    trang: docSoTrang(sp.trang),
    don: don === "" ? null : don,
  };
}

/** Chép tham số hiện tại, bỏ giá trị rỗng/thiếu. */
function chepThamSo(hienTai: ThamSoTho): URLSearchParams {
  const p = new URLSearchParams();
  for (const [khoa, giaTri] of Object.entries(hienTai)) {
    if (giaTri !== undefined && giaTri !== "") p.set(khoa, giaTri);
  }
  return p;
}

/** Dấu phẩy hợp lệ trong query — giữ nguyên cho link dễ đọc (`trang_thai=a,b`); URLSearchParams vẫn đọc đúng. */
function thanhChuoi(p: URLSearchParams): string {
  return p.toString().replace(/%2C/gi, ",");
}

/**
 * Dựng `/don-hang?…` từ tham số hiện tại + thay đổi (null/"" = xoá, thiếu khoá = giữ nguyên).
 * - Đổi bất kỳ khoá nào ngoài `trang`/`don` ⇒ bỏ `trang` (về trang 1), trừ khi `doi.trang` được chỉ định.
 * - Đặt `ngay_tu`/`ngay_den` ⇒ bỏ `ky`; đặt `ky` ⇒ bỏ hai ngày.
 * - Giá trị mặc định không ghi lên URL: `trang=1`, `sx=moi`.
 * - Khoá lạ được giữ nguyên.
 */
export function hrefDonHang(hienTai: ThamSoTho, doi: Partial<Record<ThamSoDonHang, string | null>>): string {
  const p = chepThamSo(hienTai);
  const cacDoi = (Object.entries(doi) as [ThamSoDonHang, string | null | undefined][]).filter(
    (e): e is [ThamSoDonHang, string | null] => e[1] !== undefined,
  );
  const dat = (khoa: ThamSoDonHang) => cacDoi.some(([k, v]) => k === khoa && v !== null && v !== "");

  for (const [khoa, giaTri] of cacDoi) {
    if (giaTri === null || giaTri === "") p.delete(khoa);
    else p.set(khoa, giaTri);
  }

  const doiBoLoc = cacDoi.some(([k]) => k !== "trang" && k !== "don");
  if (doiBoLoc && doi.trang === undefined) p.delete("trang");
  if (dat("ngay_tu") || dat("ngay_den")) p.delete("ky");
  if (dat("ky")) {
    p.delete("ngay_tu");
    p.delete("ngay_den");
  }
  if (p.get("trang") === "1") p.delete("trang");
  if (p.get("sx") === "moi") p.delete("sx");

  const qs = thanhChuoi(p);
  return qs ? `${DUONG_DAN}?${qs}` : DUONG_DAN;
}

/**
 * Link "mở đơn này" từ màn khác (Tài chính, đối soát): kèm `ky=tat_ca` để đơn tháng cũ vẫn nằm trong danh sách
 * phía sau drawer — không có thì nền là "Tháng này", cụm ‹ › báo "ngoài lọc" và đóng drawer là mất đơn vừa xem.
 */
export function hrefMoDonHang(id: string): string {
  return hrefDonHang({}, { ky: "tat_ca", don: id });
}

/** Chuỗi query cho `/api/export/don-hang` — tham số hiện tại bỏ `trang`, `don`; "" khi rỗng. */
export function queryXuatDonHang(hienTai: ThamSoTho): string {
  const p = chepThamSo(hienTai);
  p.delete("trang");
  p.delete("don");
  return thanhChuoi(p);
}

/** "01/11/2026 – 30/11/2026" | "Tất cả thời gian" — giờ VN ở mọi máy (formatNgayVn). */
export function nhanKyDonHang(ky: KyLocDonHang): string {
  if (ky.loai === "tat_ca") return "Tất cả thời gian";
  return `${formatNgayVn(ky.from, "dd/MM/yyyy")} – ${formatNgayVn(ky.to, "dd/MM/yyyy")}`;
}
