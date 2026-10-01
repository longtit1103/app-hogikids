import { HANH_DONG, type HanhDong } from "@/lib/nhat-ky/hanh-dong";

/** Nhãn tiếng Việt cho mã hành động của nhật ký. Mã chưa có nhãn hiện mã thô (xem `nhanHanhDong`). */
export const NHAN_HANH_DONG: Readonly<Record<HanhDong, string>> = {
  [HANH_DONG.DANG_NHAP_OK]: "Đăng nhập",
  [HANH_DONG.DANG_NHAP_SAI]: "Đăng nhập sai",
  [HANH_DONG.DANG_NHAP_BI_KHOA]: "Đăng nhập bị khoá tạm",
  [HANH_DONG.DANG_XUAT]: "Đăng xuất",
  [HANH_DONG.DOI_MAT_KHAU]: "Đổi mật khẩu",
  [HANH_DONG.DOI_MAT_KHAU_LAN_DAU]: "Đổi mật khẩu lần đầu",
  [HANH_DONG.TU_CHOI_QUYEN]: "Bị từ chối quyền",
  [HANH_DONG.TAI_KHOAN_TAO]: "Tạo tài khoản",
  [HANH_DONG.TAI_KHOAN_SUA_QUYEN]: "Sửa quyền tài khoản",
  [HANH_DONG.TAI_KHOAN_KHOA]: "Khoá tài khoản",
  [HANH_DONG.TAI_KHOAN_MO_KHOA]: "Mở khoá tài khoản",
  [HANH_DONG.TAI_KHOAN_DAT_LAI_MK]: "Đặt lại mật khẩu",
  [HANH_DONG.TAI_KHOAN_XOA]: "Xoá tài khoản",
  [HANH_DONG.DU_LIEU_XOA_TOAN_BO]: "Xoá toàn bộ dữ liệu giao dịch",
  [HANH_DONG.DU_LIEU_DUNG_LAI_TU_KHO]: "Dựng lại dữ liệu từ kho thô",
  [HANH_DONG.CAI_DAT_KENH]: "Sửa kênh bán",
  [HANH_DONG.CAI_DAT_TINH_LAI_PHI]: "Tính lại phí sàn",
  [HANH_DONG.DANH_MUC_CHI_PHI_TAO]: "Tạo danh mục chi phí",
  [HANH_DONG.DANH_MUC_CHI_PHI_SUA]: "Đổi tên danh mục chi phí",
  [HANH_DONG.DANH_MUC_CHI_PHI_AN_HIEN]: "Ẩn/hiện danh mục chi phí",
  [HANH_DONG.DANH_MUC_CHI_PHI_XOA]: "Xoá danh mục chi phí",
  [HANH_DONG.CAI_DAT_NGUONG_TON]: "Sửa ngưỡng tồn mặc định",
  [HANH_DONG.CAI_DAT_THONG_TIN_SHOP]: "Sửa thông tin shop",
  [HANH_DONG.KHOA_KET_NOI_LUU]: "Lưu khoá kết nối",
  [HANH_DONG.KHOA_KET_NOI_THAY_META]: "Đổi khoá Meta dài hạn",
  [HANH_DONG.N8N_LUU_KET_NOI]: "Lưu kết nối n8n",
  [HANH_DONG.N8N_CAI_WORKFLOWS]: "Cài workflow n8n",
  [HANH_DONG.DONG_BO_KICH_HOAT]: "Đồng bộ ngay",
  [HANH_DONG.NGUONG_TON_SUA]: "Sửa ngưỡng tồn",
  [HANH_DONG.GIA_VON_SUA]: "Sửa giá vốn",
  [HANH_DONG.GIA_VON_IMPORT]: "Nhập giá vốn từ file",
  [HANH_DONG.GIA_VON_AP_THEO_PANCAKE]: "Áp giá vốn theo Pancake",
  [HANH_DONG.ADS_IMPORT]: "Nhập chi phí quảng cáo",
  [HANH_DONG.DONG_TIEN_TAO]: "Ghi dòng tiền",
  [HANH_DONG.DONG_TIEN_SUA]: "Sửa dòng tiền",
  [HANH_DONG.DONG_TIEN_XOA]: "Xoá dòng tiền",
  [HANH_DONG.CHOT_SO_DU_LUU]: "Chốt số dư cuối tháng",
  [HANH_DONG.CHOT_SO_DU_XOA]: "Bỏ chốt số dư",
  [HANH_DONG.VI_SHOPEE_IMPORT]: "Nhập ví Shopee",
  [HANH_DONG.QUY_TOI_THIEU_DAT]: "Đặt quỹ tối thiểu",
  [HANH_DONG.VAY_TAO]: "Tạo khoản vay",
  [HANH_DONG.VAY_SUA]: "Sửa khoản vay",
  [HANH_DONG.VAY_XOA]: "Xoá khoản vay",
  [HANH_DONG.VAY_TAT_TOAN]: "Tất toán khoản vay",
  [HANH_DONG.VAY_GHI_KY]: "Ghi kỳ trả nợ",
  [HANH_DONG.THAU_CHI_TAT_TOAN]: "Tất toán thấu chi",
  [HANH_DONG.TIET_KIEM_TAO]: "Tạo sổ tiết kiệm",
  [HANH_DONG.TIET_KIEM_SUA]: "Sửa sổ tiết kiệm",
  [HANH_DONG.TIET_KIEM_XOA]: "Xoá sổ tiết kiệm",
  [HANH_DONG.TIET_KIEM_TAT_TOAN]: "Tất toán sổ tiết kiệm",
  [HANH_DONG.TIET_KIEM_MO_LAI]: "Mở lại sổ tiết kiệm",
  [HANH_DONG.CHI_PHI_TAO]: "Ghi chi phí",
  [HANH_DONG.CHI_PHI_SUA]: "Sửa chi phí",
  [HANH_DONG.CHI_PHI_XOA]: "Xoá chi phí",
  [HANH_DONG.CHI_PHI_BAT_DINH_KY]: "Bật lại khoản chi định kỳ",
  [HANH_DONG.CHI_PHI_DUNG_DINH_KY]: "Dừng khoản chi định kỳ",
  [HANH_DONG.NHAP_HANG_GHI_CHI_PHI]: "Ghi chi phí nhập hàng",
  [HANH_DONG.THUNG_RAC_KHOI_PHUC]: "Khôi phục từ thùng rác",
  [HANH_DONG.THUNG_RAC_XOA_VINH_VIEN]: "Xoá vĩnh viễn khỏi thùng rác",
  [HANH_DONG.XUAT_FILE]: "Xuất file",
  [HANH_DONG.SAO_LUU_TAI]: "Tải bản sao lưu",
  [HANH_DONG.PHUC_HOI]: "Phục hồi dữ liệu từ bản sao lưu",
};

export function nhanHanhDong(ma: string): string {
  return Object.hasOwn(NHAN_HANH_DONG, ma) ? NHAN_HANH_DONG[ma as HanhDong] : ma;
}

/** Nhãn cho khoá `ghiChu` (allowlist của `ghiNhatKy`). Khoá lạ hiện khoá thô. */
const NHAN_KHOA_GHI_CHU: Readonly<Record<string, string>> = {
  soDong: "Số dòng",
  ky: "Kỳ",
  thang: "Tháng",
  loaiBanGhi: "Loại bản ghi",
  quyenThieu: "Quyền thiếu",
  lyDo: "Lý do",
  email: "Email",
};

export function nhanKhoaGhiChu(khoa: string): string {
  return Object.hasOwn(NHAN_KHOA_GHI_CHU, khoa) ? NHAN_KHOA_GHI_CHU[khoa]! : khoa;
}

/**
 * Nhãn cho các giá trị `ghiChu.lyDo` CỐ ĐỊNH (mã do code đặt). Mã động (mã lỗi Prisma, tên lớp lỗi)
 * không có trong bảng ⇒ hiện nguyên văn, để chủ shop vẫn tra được.
 */
const NHAN_LY_DO: Readonly<Record<string, string>> = {
  CHUA_THU_HOI_PHIEN_LOI: "Đã nạp dữ liệu nhưng KHÔNG thu hồi được phiên (lỗi khi thu hồi)",
  CHUA_THU_HOI_PHIEN_MAT_KHOA: "Đã nạp dữ liệu nhưng KHÔNG thu hồi được phiên (mất khoá phục hồi)",
  BO_QUA_KY: "Bỏ qua kỳ trả nợ",
};

export function nhanLyDo(ma: string): string {
  return Object.hasOwn(NHAN_LY_DO, ma) ? NHAN_LY_DO[ma]! : ma;
}
