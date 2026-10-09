/**
 * Còn nợ của MỘT phiếu nhập hàng — công thức thuần, không đụng DB.
 *
 * `còn nợ = (huỷ ? 0 : tổng tiền) − đã trả trước − đã trả + đã hoàn`.
 * Phiếu huỷ coi như không còn nghĩa vụ, nên tiền đã trả cho nó thành khoản ÂM (cần thu hồi).
 */
export type PhieuNo = {
  tongTien: number;
  /** Phần đã trả ngay lúc nhập phiếu (đã nằm trong sổ chi phí). */
  daTraTruoc: number;
  daHuy: boolean;
  /** Σ các lần trả nợ nhà cung cấp gắn phiếu. */
  daTra: number;
  /** Σ nhà cung cấp hoàn lại tiền gắn phiếu. */
  daHoan: number;
};

export type TrangThaiPhieu = "CON_NO" | "DA_TRA_DU" | "TRA_THUA" | "CAN_THU_HOI";

/** Âm = trả thừa (phiếu thường) hoặc cần thu hồi (phiếu huỷ). */
export function conNoPhieu(p: PhieuNo): number {
  return (p.daHuy ? 0 : p.tongTien) - p.daTraTruoc - p.daTra + p.daHoan;
}

export function nhanTrangThaiPhieu(conNo: number, daHuy: boolean): TrangThaiPhieu {
  if (conNo < 0) return daHuy ? "CAN_THU_HOI" : "TRA_THUA";
  if (conNo === 0) return "DA_TRA_DU";
  return "CON_NO";
}
