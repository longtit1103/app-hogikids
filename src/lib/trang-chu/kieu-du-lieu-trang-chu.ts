/**
 * HỢP ĐỒNG dữ liệu server → client của trang chủ (`/`). CHỈ kiểu — Client Component import được; mọi
 * import ở đây là `import type` (module nguồn kéo Prisma, không được vào browser bundle).
 *
 * Nhánh thiếu `gia-von-loi-nhuan:xem` (`coQuyenGiaVon: false`) KHÔNG mang số giá vốn / chi phí / lãi ở
 * cả kiểu lẫn runtime — loader dựng nhánh đó từ DTO che (`pnl-che.ts`).
 */
import type { OrderStatus } from "@/generated/prisma/client";
import type { KetQuaChe } from "@/lib/queries/che-gia-von-types";
import type { LowStockPreviewRow } from "@/lib/queries/variants";
import type { ChiaChiPhi } from "@/lib/trang-chu/chia-chi-phi";
import type { DongLaiSanPham } from "@/lib/trang-chu/xep-hang-lai-san-pham";

export type ChiSoBieuDo = "doanhSo" | "chiPhi" | "loiNhuan" | "donHang";

/** Số kỳ này + kỳ so sánh; `phanTram` null ⇒ kỳ trước 0 (huy hiệu "Mới"). */
export type SoSanh = { hienTai: number; kyTruoc: number; phanTram: number | null };

export type GiaTriNgayDayDu = { doanhSo: number; chiPhi: number; loiNhuan: number; donHang: number };
export type GiaTriNgayChe = { doanhSo: number; donHang: number };

/** Một điểm biểu đồ ngày; `kyTruoc` null khi kỳ 1 ngày hoặc kỳ trước ngắn hơn (đường đứt dừng sớm). */
export type DiemBieuDo<G> = { ngay: string /* yyyy-MM-dd */; laNgayDangXem: boolean; hienTai: G; kyTruoc: G | null };

export type DuLieuTheVaBieuDo = { nhanKySoSanh: string; motNgay: boolean } & KetQuaChe<
  {
    the: {
      doanhSo: SoSanh;
      chiPhi: SoSanh;
      loiNhuan: SoSanh;
      donHang: SoSanh;
      tbMoiDon: number | null;
      quangCao: number;
      bienLai: number | null;
      tyLeHoanHuy: number | null;
    };
    bieuDo: DiemBieuDo<GiaTriNgayDayDu>[];
  },
  {
    the: { doanhSo: SoSanh; donHang: SoSanh; tbMoiDon: number | null; tyLeHoanHuy: number | null };
    bieuDo: DiemBieuDo<GiaTriNgayChe>[];
  }
>;

/** Đơn ĐẶT trong kỳ theo trạng thái; `tong` = Σ = orderCount + returnBomOrderCount của calcPnl. */
export type TinhTrangDon = { tong: number; theoTrangThai: Record<OrderStatus, number> };

export type DongKenhDayDu = { channelId: string; ten: string; doanhSo: number; donHang: number; loiNhuan: number };
export type DongKenhChe = { channelId: string; ten: string; doanhSo: number; donHang: number };
export type TheoKenh = KetQuaChe<{ rows: DongKenhDayDu[] }, { rows: DongKenhChe[] }>;

export type DongBanChay = { productId: string; ten: string; soLuong: number; doanhSo: number };

export type DuLieuTrangChu = {
  /** `khoangServerThuocTinh(range PICKER gốc, KHÔNG kẹp)` — e2e bộ chọn ngày đọc. */
  khoangServer: string;
  /** `serializeDateRange(range đã kẹp)` — cho link `/don-hang?ngay_tu=&ngay_den=`. */
  kyDangXem: { tu: string; den: string };
  theVaBieuDo: DuLieuTheVaBieuDo;
  tinhTrangDon: TinhTrangDon;
  /** null khi thiếu quyền giá vốn. */
  tienDiDau: ChiaChiPhi | null;
  theoKenh: TheoKenh;
  /** null khi thiếu `bao-cao:xem`. */
  banChay: DongBanChay[] | null;
  /** null khi thiếu `bao-cao:xem` HOẶC quyền giá vốn. */
  laiNenDay: { top: DongLaiSanPham[]; soThieuGiaVon: number } | null;
  /** null khi thiếu `ton-kho:xem`. */
  sapHet: { rows: LowStockPreviewRow[]; total: number } | null;
};

/**
 * Số dòng tối đa 3 khối dưới trang chủ (Bán chạy, Lãi nhiều – nên đẩy, Sắp hết hàng). Khối cao CỐ ĐỊNH, danh
 * sách cuộn bên trong (chủ shop chốt 02/11) ⇒ lấy 10 dòng để cuộn có thêm dòng mà xem.
 */
export const SO_DONG_KHOI_DUOI = 10;
