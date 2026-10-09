/**
 * Phân bổ gợi ý cho đợt trả tiền hàng gộp: trả phiếu CŨ TRƯỚC (danh sách đã sắp cũ → mới), mỗi phiếu
 * tối đa bằng còn nợ của nó. Phần tiền dư sau khi hết nợ KHÔNG tự dồn vào đâu — để chủ shop tự chọn
 * phiếu nhận (trả thừa là sự thật cần ghi, nhưng phải do người quyết) nên tổng phân bổ < tổng ⇒ nút
 * Ghi khoá. Thuần: không React, không DB.
 */
export type PhieuChoPhanBo = { id: string; conNo: number };

export function goiYPhanBoCuTruoc(phieu: readonly PhieuChoPhanBo[], tong: number): Record<string, number> {
  const ra: Record<string, number> = {};
  let conLai = tong;
  for (const p of phieu) {
    if (conLai <= 0) break;
    if (p.conNo <= 0) continue;
    const phan = Math.min(p.conNo, conLai);
    ra[p.id] = phan;
    conLai -= phan;
  }
  return ra;
}

/** Σ các phần phân bổ > 0 (ô trống / 0 không tính là một dòng phân bổ). */
export function tongPhanBo(phanBo: Readonly<Record<string, number>>): number {
  return Object.values(phanBo).reduce((s, v) => s + (v > 0 ? v : 0), 0);
}

/** Dòng phân bổ gửi lên server: chỉ phiếu có phần > 0. */
export function dongPhanBoGui(phanBo: Readonly<Record<string, number>>): { phieuNhapId: string; soTien: number }[] {
  return Object.entries(phanBo)
    .filter(([, v]) => v > 0)
    .map(([phieuNhapId, soTien]) => ({ phieuNhapId, soTien }));
}
