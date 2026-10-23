/**
 * "Sau khi trả hết nợ" của thẻ Quỹ (spec §5.5): quỹ hôm nay − Σ dư nợ thẻ (> 0) − Σ còn nợ phiếu (> 0)
 * − Σ dư nợ THẤU CHI đang mở (> 0).
 *
 * THUẦN: không DB. Chỉ cộng phần DƯƠNG — thẻ dư nợ âm (trả thừa) hay phiếu "trả thừa / cần thu hồi" là
 * tiền ngân hàng/nhà cung cấp đang giữ của shop, chưa chắc đòi lại được ⇒ không cộng ngược vào quỹ.
 * Dư nợ thẻ là số ƯỚC TÍNH (`null` = thẻ chưa có neo, không đoán).
 *
 * Vì sao trừ thấu chi: thấu chi GIẢI NGÂN VÀO tài khoản (`LOAN_IN` vào quỹ) và lãi nhập gốc làm dư nợ tự tăng
 * (`LAI_NHAP_GOC`) — tiền đó đã nằm trong quỹ hôm nay nhưng là tiền của NGÂN HÀNG, rút là phải trả bất cứ lúc
 * nào. Không trừ thì số "còn lại sau khi trả hết nợ" cao hơn tiền thật đúng bằng dư nợ thấu chi.
 * Vay kỳ hạn / trả gốc cuối kỳ thì KHÔNG trừ (chủ shop chốt 23/10): trả dần theo lịch, không phải nghĩa vụ
 * trả ngay — chỉ là dòng tham khảo `vayKyHan`, không đổi `conLai`.
 *
 * Dư nợ khoản vay nhận vào là số `duNo` ĐÃ TÍNH sẵn (`listKhoanVay` → `duNoTai`, cùng công thức
 * `duNoMoSo + Σ LOAN_IN + Σ LAI_NHAP_GOC − Σ LOAN_REPAY` của bảng dấu `DAU_DU_NO_VAY`) — hàm này KHÔNG tự
 * cộng trừ theo kind dòng tiền.
 */
export type SauKhiTraHetNo = {
  quyHomNay: number;
  noThe: number;
  noPhieu: number;
  /** Σ dư nợ (> 0) các khoản THẤU CHI chưa tất toán — trừ vào `conLai`. */
  noThauChi: number;
  /** Σ dư nợ (> 0) các khoản vay KHÁC thấu chi chưa tất toán — CHỈ tham khảo, KHÔNG trừ vào `conLai`. */
  vayKyHan: number;
  /** `quyHomNay − noThe − noPhieu − noThauChi` — có thể âm (nợ nhiều hơn quỹ). */
  conLai: number;
};

/** Phần cần của một khoản vay: loại, đã tất toán chưa, dư nợ gốc tới hôm nay (`KhoanVayRow`). */
export type KhoanVayChoTraHetNo = { kind: string; closedAt: Date | null; duNo: number };

const duong = (n: number) => (n > 0 ? n : 0);

export function tinhSauKhiTraHetNo(
  quyHomNay: number,
  the: readonly { duNo: number | null }[],
  phieu: readonly { conNo: number }[],
  khoanVay: readonly KhoanVayChoTraHetNo[],
): SauKhiTraHetNo {
  const noThe = the.reduce((s, t) => s + (t.duNo !== null ? duong(t.duNo) : 0), 0);
  const noPhieu = phieu.reduce((s, p) => s + duong(p.conNo), 0);
  const dangMo = khoanVay.filter((k) => k.closedAt === null);
  const noThauChi = dangMo.filter((k) => k.kind === "OVERDRAFT").reduce((s, k) => s + duong(k.duNo), 0);
  const vayKyHan = dangMo.filter((k) => k.kind !== "OVERDRAFT").reduce((s, k) => s + duong(k.duNo), 0);
  return { quyHomNay, noThe, noPhieu, noThauChi, vayKyHan, conLai: quyHomNay - noThe - noPhieu - noThauChi };
}
