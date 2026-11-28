import {
  CHIP_CAN_GIA_VON,
  CHIP_LOC_DON_HANG,
  SAP_XEP_CAN_GIA_VON,
  type BoLocDonHang,
  type ChipLocDonHang,
  type KieuSapXepDonHang,
  type ThamSoDonHang,
} from "@/lib/orders/don-hang-kieu-du-lieu";
import { trangThaiHienThi } from "@/lib/orders/trang-thai-don-hien-thi";

/**
 * Các lựa chọn lọc/sắp xếp của danh sách đơn + chip "đang áp". Hàm/hằng thuần dùng chung thanh lọc,
 * bottom-sheet và hàng chip. Chip và kiểu sắp xếp cần giá vốn bị bỏ khỏi danh sách khi thiếu quyền —
 * tập đơn sau lọc hay thứ tự dòng tự nó lộ lãi, nên không được chỉ ra lựa chọn đó.
 */

export const NHAN_CHIP_LOC: Record<ChipLocDonHang, string> = {
  lo: "Đơn lỗ",
  thieu_gv: "Thiếu giá vốn",
  phi_tam: "Phí tạm tính",
};

const NHAN_SAP_XEP: Record<KieuSapXepDonHang, string> = {
  moi: "Mới nhất",
  cu: "Cũ nhất",
  tien_cao: "Tiền hàng cao nhất",
  tien_thap: "Tiền hàng thấp nhất",
  lai_thap: "Lãi thấp nhất",
  lai_cao: "Lãi cao nhất",
};

/** Thứ tự hiển thị trong ô Sắp xếp. */
const THU_TU_SAP_XEP: readonly KieuSapXepDonHang[] = ["moi", "cu", "tien_cao", "tien_thap", "lai_thap", "lai_cao"];

export function chipHienThi(coQuyenGiaVon: boolean): { id: ChipLocDonHang; nhan: string }[] {
  return CHIP_LOC_DON_HANG.filter((c) => coQuyenGiaVon || !CHIP_CAN_GIA_VON.includes(c)).map((id) => ({
    id,
    nhan: NHAN_CHIP_LOC[id],
  }));
}

export function luaChonSapXep(coQuyenGiaVon: boolean): { id: KieuSapXepDonHang; nhan: string }[] {
  return THU_TU_SAP_XEP.filter((s) => coQuyenGiaVon || !SAP_XEP_CAN_GIA_VON.includes(s)).map((id) => ({
    id,
    nhan: NHAN_SAP_XEP[id],
  }));
}

/** Bật/tắt một chip trong danh sách `loc` hiện tại; trả chuỗi phẩy cho URL, rỗng ⇒ null (xoá khoá). */
export function locSauKhiBatTat(hienTai: readonly ChipLocDonHang[], chip: ChipLocDonHang): string | null {
  const moi = hienTai.includes(chip) ? hienTai.filter((c) => c !== chip) : [...hienTai, chip];
  return moi.length > 0 ? moi.join(",") : null;
}

/** Số lọc đang bật cho huy hiệu nút "Lọc": kênh tính 1, mỗi chip 1, sắp xếp khác mặc định 1. */
export function demLocDangBat(b: BoLocDonHang): number {
  return (b.channels.length > 0 ? 1 : 0) + b.loc.length + (b.sx !== "moi" ? 1 : 0);
}

/** Thay đổi tham số URL truyền cho `hrefDonHang` (null/"" = xoá khoá). */
export type DoiThamSoDonHang = Partial<Record<ThamSoDonHang, string | null>>;

export type ChipDangAp = { khoa: string; nhan: string; doi: DoiThamSoDonHang };

/**
 * Hàng chip đang áp (CHỈ lọc ngoài kỳ): Kênh · Trạng thái (chỉ ca ≥ 2 trạng thái — một trạng thái đã
 * hiện bằng tab) · từng chip nhanh · Tìm. `doi` là thay đổi truyền thẳng cho `hrefDonHang` để bỏ riêng chip đó.
 */
export function dungChipDangAp(b: BoLocDonHang, kenh: readonly { id: string; name: string }[]): ChipDangAp[] {
  const ra: ChipDangAp[] = [];
  if (b.channels.length > 0) {
    const ten = b.channels.map((id) => kenh.find((k) => k.id === id)?.name ?? id);
    ra.push({ khoa: "kenh", nhan: `Kênh: ${ten.join(", ")}`, doi: { kenh: null } });
  }
  if (b.statuses.length >= 2) {
    ra.push({
      khoa: "trang_thai",
      nhan: `Trạng thái: ${b.statuses.map((s) => trangThaiHienThi(s).nhan).join(", ")}`,
      doi: { trang_thai: null },
    });
  }
  for (const c of b.loc) {
    ra.push({ khoa: `loc:${c}`, nhan: NHAN_CHIP_LOC[c], doi: { loc: locSauKhiBatTat(b.loc, c) } });
  }
  if (b.q !== "") ra.push({ khoa: "q", nhan: `Tìm: “${b.q}”`, doi: { q: null } });
  return ra;
}

/** Thay đổi URL của nút "Xóa lọc": bỏ tìm, kênh, chip, trạng thái, trang; GIỮ kỳ và sắp xếp. */
export const DOI_XOA_LOC: DoiThamSoDonHang = {
  q: null,
  kenh: null,
  loc: null,
  trang_thai: null,
  trang: null,
};
