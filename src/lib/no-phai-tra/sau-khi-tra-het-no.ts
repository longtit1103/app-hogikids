/**
 * "Sau khi trả hết nợ" của thẻ Quỹ (spec §5.5): quỹ hôm nay − Σ dư nợ thẻ (> 0) − Σ còn nợ phiếu (> 0).
 * THUẦN: không DB. Chỉ cộng phần DƯƠNG — thẻ dư nợ âm (trả thừa) hay phiếu "trả thừa / cần thu hồi" là
 * tiền ngân hàng/nhà cung cấp đang giữ của shop, chưa chắc đòi lại được ⇒ không cộng ngược vào quỹ.
 * Dư nợ thẻ là số ƯỚC TÍNH (`null` = thẻ chưa có neo, không đoán).
 */
export type SauKhiTraHetNo = {
  quyHomNay: number;
  noThe: number;
  noPhieu: number;
  /** `quyHomNay − noThe − noPhieu` — có thể âm (nợ nhiều hơn quỹ). */
  conLai: number;
};

export function tinhSauKhiTraHetNo(
  quyHomNay: number,
  the: readonly { duNo: number | null }[],
  phieu: readonly { conNo: number }[],
): SauKhiTraHetNo {
  const noThe = the.reduce((s, t) => s + (t.duNo !== null && t.duNo > 0 ? t.duNo : 0), 0);
  const noPhieu = phieu.reduce((s, p) => s + (p.conNo > 0 ? p.conNo : 0), 0);
  return { quyHomNay, noThe, noPhieu, conLai: quyHomNay - noThe - noPhieu };
}
