import type { KieuSapXepDonHang } from "@/lib/orders/don-hang-kieu-du-lieu";

/**
 * Sắp xếp bằng cách bấm tiêu đề cột (Ngày · Tiền hàng · Lãi đơn). Cột chưa sắp ⇒ chiều mặc định
 * (Ngày→Mới nhất, Tiền hàng→cao nhất, Lãi→thấp nhất); cột đang sắp ⇒ đảo chiều.
 */
export type CotSapXepDonHang = "ngay" | "tien" | "lai";

const CAP_KIEU: Record<CotSapXepDonHang, { macDinh: KieuSapXepDonHang; dao: KieuSapXepDonHang }> = {
  ngay: { macDinh: "moi", dao: "cu" },
  tien: { macDinh: "tien_cao", dao: "tien_thap" },
  lai: { macDinh: "lai_thap", dao: "lai_cao" },
};

/** Kiểu sắp xếp mới khi bấm tiêu đề `cot` lúc đang sắp theo `hienTai`. */
export function sapXepKhiBamCot(cot: CotSapXepDonHang, hienTai: KieuSapXepDonHang): KieuSapXepDonHang {
  const { macDinh, dao } = CAP_KIEU[cot];
  return hienTai === macDinh ? dao : macDinh;
}

/** `aria-sort` của tiêu đề cột; undefined khi cột không phải cột đang sắp. */
export function ariaSortCot(
  cot: CotSapXepDonHang,
  hienTai: KieuSapXepDonHang,
): "ascending" | "descending" | undefined {
  const { macDinh, dao } = CAP_KIEU[cot];
  if (hienTai !== macDinh && hienTai !== dao) return undefined;
  // Mới nhất / tiền cao nhất / lãi cao nhất là giảm dần; Cũ nhất / tiền thấp nhất / lãi thấp nhất là tăng dần.
  const giamDan: KieuSapXepDonHang[] = ["moi", "tien_cao", "lai_cao"];
  return giamDan.includes(hienTai) ? "descending" : "ascending";
}
