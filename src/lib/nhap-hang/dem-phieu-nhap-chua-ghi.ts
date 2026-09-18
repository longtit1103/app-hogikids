import { docDeXuatPhieuNhap } from "./doc-phieu-nhap-bronze";

/** Hai loại việc của dải nhắc việc phiếu nhập — xem `trang-thai-phieu-nhap.ts` về lý do tách. */
export type SoViecPhieuNhap = {
  /** Phiếu Pancake chưa vào Sổ chi phí (chờ duyệt). */
  choDuyet: number;
  /** Phiếu đã ghi nay bị huỷ / đổi số tiền / trạng thái lạ + phiếu trạng thái lạ chưa ghi. */
  hauKiem: number;
};

/**
 * ĐẾM việc phiếu nhập Pancake còn treo — cho lượt đêm ghi mốc `Setting` và banner nhắc việc.
 *
 * Đếm CẢ hậu kiểm chứ không chỉ `deXuat.length`: duyệt hết phiếu chờ là số về 0 và banner tắt, trong
 * khi cảnh báo "phiếu đã ghi nay bị huỷ bên Pancake" vẫn nằm im trong màn `/tai-chinh/chi-phi-nhap-hang`
 * — chỉ ai TỰ NHỚ mở màn đó mới thấy. Hai lần trên prod (#173, #179) đúng là ca này.
 *
 * Vẫn phải đọc trọn Bronze như `docDeXuatPhieuNhap` (không có đường tắt: luật lọc là hàm của payload
 * — `created_type`, `status`, ngày VN đều nằm trong JSON), nên TUYỆT ĐỐI không gọi hàm này trong
 * layout mỗi request; layout chỉ đọc con số đã chốt trong `Setting`. Cùng khuôn `demLechGiaVon`.
 */
export async function demPhieuNhapChuaGhi(): Promise<SoViecPhieuNhap> {
  const { deXuat, soViecHauKiem } = await docDeXuatPhieuNhap();
  return { choDuyet: deXuat.length, hauKiem: soViecHauKiem };
}
