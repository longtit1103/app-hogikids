/**
 * Hướng dẫn xử lý chi phí "Nhập hàng" ghi từ ngày bật M trở đi (điều kiện `CON_NHAP_HANG_SAU_M` của bước bật
 * nợ phải trả). Module THUẦN (không DB) — dùng chung cho câu lỗi server (`dieu-kien-bat-no-phai-tra.ts`) và
 * màn hình (`components/no-phai-tra/nhap-hang-sau-m-huong-dan.tsx`, chạy cả ở client).
 */

/** Một dòng chi phí Nhập hàng ngày ≥ M — đủ để màn hình liệt kê và mở Sổ chi phí đúng ngày của dòng. */
export type DongNhapHangSauM = { id: string; khoaNgay: string; amount: number; description: string };

/**
 * Ba trường hợp của một dòng Nhập hàng ngày ≥ M + câu cảnh báo — MỘT nguồn chữ cho câu lỗi server và màn hình
 * (`nhap-hang-sau-m-huong-dan.tsx`). Đổi ngày chỉ đúng ở trường hợp (1).
 */
export function huongDanNhapHangSauM(nhanM: string): { truongHop: [string, string, string]; canhBao: string } {
  return {
    truongHop: [
      `Ngày ghi nhầm (khoản thật diễn ra trước ${nhanM}) ⇒ sửa ngày về đúng ngày thật`,
      `Đã trả thật trong khoảng từ ${nhanM} tới nay ⇒ xoá dòng chi phí; sau khi bật, ghi nhận phiếu vào sổ nợ và ` +
        `nhập "Đã trả ngay" đúng ngày trả (quỹ vẫn trừ đúng một lần, tại ngày trả)`,
      "Chưa trả ⇒ xoá dòng chi phí; sau khi bật, ghi nhận phiếu vào sổ nợ không kèm trả",
    ],
    canhBao:
      "Không đổi ngày chỉ để vượt cổng — đổi ngày về trước mốc làm quỹ tháng trước và chênh lệch bước bật đổi theo",
  };
}

/** Sổ chi phí mở đúng khoảng ngày `tu`..`den` (khoá `yyyy-MM-dd` giờ VN) — khuôn `?tu=&den=` của bộ chọn ngày. */
export function hrefSoChiPhiTheoNgay(tu: string, den: string = tu): string {
  return `/tai-chinh?tab=so-chi-phi&tu=${tu}&den=${den}`;
}
