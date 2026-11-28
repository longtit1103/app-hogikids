import type { OrderStatus } from "@/generated/prisma/client";
import type { KetQuaChe } from "@/lib/queries/che-gia-von-types";

/**
 * Hợp đồng dữ liệu dùng chung của trang Đơn hàng (`/don-hang`): bộ đọc URL, truy vấn, giao diện danh
 * sách, drawer và Excel đều nói chuyện qua các kiểu ở đây.
 *
 * CHỈ kiểu + hằng thuần, mọi import đều là `import type` ⇒ component client import được mà không kéo
 * Prisma client hay code server vào bundle trình duyệt.
 *
 * Che giá vốn: kiểu nhánh "Che" (người thiếu `gia-von-loi-nhuan:xem`) KHÔNG có trường lãi/giá vốn/thiếu
 * giá vốn — đọc được những trường đó chỉ sau khi narrow `KetQuaChe` bằng `coQuyenGiaVon`.
 */

/** Chip lọc nhanh (`?loc=`, nối AND). */
export const CHIP_LOC_DON_HANG = ["lo", "thieu_gv", "phi_tam"] as const;
export type ChipLocDonHang = (typeof CHIP_LOC_DON_HANG)[number];
/** Chip suy ra từ giá vốn — tập đơn sau lọc tự nó lộ lãi/giá vốn, nên người không quyền không được dùng. */
export const CHIP_CAN_GIA_VON: readonly ChipLocDonHang[] = ["lo", "thieu_gv"];

/** Kiểu sắp xếp (`?sx=`); `moi` là mặc định và không ghi lên URL. */
export const KIEU_SAP_XEP_DON_HANG = ["moi", "cu", "tien_cao", "tien_thap", "lai_thap", "lai_cao"] as const;
export type KieuSapXepDonHang = (typeof KIEU_SAP_XEP_DON_HANG)[number];
/** Sắp theo lãi — THỨ TỰ dòng tự nó lộ lãi, nên người không quyền không được dùng. */
export const SAP_XEP_CAN_GIA_VON: readonly KieuSapXepDonHang[] = ["lai_thap", "lai_cao"];

/**
 * Kỳ lọc theo `orderedAt` (giờ VN). `khoang` = [from, to] đóng; `nguon: "mac_dinh"` khi URL không có
 * ngày hợp lệ (Tháng này). `tat_ca` = mọi thời gian (`?ky=tat_ca`).
 */
export type KyLocDonHang =
  | { loai: "khoang"; from: Date; to: Date; nguon: "url" | "mac_dinh" }
  | { loai: "tat_ca" };

/** Bộ lọc đã chuẩn hoá + đã kẹp theo quyền — đầu ra DUY NHẤT của bộ đọc URL. */
export type BoLocDonHang = {
  ky: KyLocDonHang;
  statuses: OrderStatus[]; // rỗng = mọi trạng thái
  channels: string[]; // rỗng = mọi kênh
  q: string; // "" = không tìm
  loc: ChipLocDonHang[]; // ĐÃ bỏ chip cần giá vốn khi không quyền
  sx: KieuSapXepDonHang; // ĐÃ ép "moi" khi lai_* mà không quyền
  trang: number; // ≥ 1
  don: string | null;
};

/** Các khoá query trang Đơn hàng hiểu. Khoá khác được giữ nguyên khi dựng link. */
export type ThamSoDonHang = "ngay_tu" | "ngay_den" | "ky" | "trang_thai" | "kenh" | "q" | "loc" | "sx" | "trang" | "don";

/** Một dòng danh sách — KHÔNG trường nhạy cảm. */
export type DongDonHangChe = {
  id: string;
  code: string;
  maSan: string | null;
  orderedAt: Date;
  statusChangedAt: Date | null;
  channelId: string;
  channelName: string;
  channelColor: string;
  tenKhach: string | null; // CHỈ kênh "direct", kênh khác luôn null
  sanPhamDau: { ten: string; soLuong: number } | null;
  soDongHang: number;
  tongSoLuong: number;
  itemsTotal: number;
  discount: number;
  platformFeeEst: number;
  returnedFee: number;
  status: OrderStatus;
  phiTamTinh: boolean; // spec §4.1
};
export type DongDonHang = DongDonHangChe & { laiDon: number; thieuGiaVon: boolean };

/**
 * Tổng trên tập đơn khớp bộ lọc; các số tiền chỉ cộng đơn hợp lệ (PENDING/SHIPPING/COMPLETED), riêng
 * `phiSanGiuHoanHuy` = Σ`returnedFee` của đơn hoàn/hủy (= dòng "Phí sàn đơn hoàn/hủy" của Lãi/Lỗ). Khoản
 * này là phí sàn, không phải giá vốn ⇒ người thiếu quyền giá vốn vẫn nhận.
 */
export type TongDonHangChe = {
  soDon: number;
  soHopLe: number;
  soHoanHuy: number;
  tienHang: number;
  voucher: number;
  phiSan: number;
  thucNhan: number; // chỉ đơn hợp lệ
  phiSanGiuHoanHuy: number;
};
/**
 * `lai = laiHopLe − phiSanGiuHoanHuy` (phí sàn giữ của đơn hoàn/hủy trừ đúng một lần).
 * `soDonThieuGiaVon` = số đơn hợp lệ trong tập có dòng hàng thiếu giá vốn (lãi đang cao hơn thực tế) —
 * tự nó lộ thông tin giá vốn nên CHỈ nhánh có quyền.
 */
export type TongDonHang = TongDonHangChe & { laiHopLe: number; lai: number; soDonThieuGiaVon: number };

export type DemTrangThaiDonHang = Record<OrderStatus, number>;

export type TrangDonHangDay = {
  rows: DongDonHang[];
  tong: TongDonHang;
  demTheoTrangThai: DemTrangThaiDonHang;
  kyTruoc: { nhan: string; tong: TongDonHang } | null;
};
export type TrangDonHangChe = {
  rows: DongDonHangChe[];
  tong: TongDonHangChe;
  demTheoTrangThai: DemTrangThaiDonHang;
  kyTruoc: { nhan: string; tong: TongDonHangChe } | null;
};
export type TrangDonHang = KetQuaChe<TrangDonHangDay, TrangDonHangChe>;

/** Vị trí đơn đang mở trong tập lọc + sắp xếp, cho cụm ‹ i / N › của drawer. */
export type DonKeBen = {
  viTri: number | null; // 1-based trong tập lọc+sắp; null = đơn ngoài lọc
  tong: number;
  truoc: { id: string; trang: number } | null;
  sau: { id: string; trang: number } | null;
};

export type MocTrangThaiDon = { status: OrderStatus; luc: Date; hienTai: boolean };
/** Không có ghi chú đơn: `note` là PII (từ điển dữ liệu Bronze) — chủ shop chốt bỏ 27/11. */
export type ThongTinPhuDon = { dongThoiGian: MocTrangThaiDon[] };

/** Trần số dòng một lần xuất Excel; vượt ⇒ từ chối, bắt thu hẹp kỳ/bộ lọc. */
export const TRAN_DONG_XUAT_DON_HANG = 50_000;
export type DongXuatDonHang = DongDonHang & { giaVon: number };
export type KetQuaXuatDonHang = KetQuaChe<
  { rows: DongXuatDonHang[]; vuotTran: boolean },
  { rows: DongDonHangChe[]; vuotTran: boolean }
>;
