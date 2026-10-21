/**
 * Cảnh báo "trừ nhầm dư nợ thấu chi" — THUẦN, dùng chung cho thẻ chốt số dư tháng và bước 2 màn bật nợ phải trả.
 *
 * Thấu chi của shop là khoản vay GIẢI NGÂN vào tài khoản thanh toán: số dư thật trên app ngân hàng đã gồm tiền
 * vay, quỹ app cũng đã gồm `LOAN_IN` của nó ⇒ chủ shop gõ ĐÚNG số dư thật, không trừ dư nợ. Giao diện cũ từng dặn
 * "đang thấu chi thì gõ số âm" nên vẫn có người trừ thói quen. Trừ nhầm làm số gõ thấp hơn thật ĐÚNG bằng dư nợ ⇒
 * khi phần còn lại khớp, chênh lệch rơi đúng −dư nợ. Chỉ nhận ra ca đó (cùng khuôn "chênh = tiền đang gửi");
 * dư thêm nguyên nhân khác thì không đoán.
 */

/** Sai số chấp nhận khi so chênh với −dư nợ (làm tròn ngân hàng / lãi lẻ). */
export const DUNG_SAI_TRU_NHAM_THAU_CHI = 1_000;

export const CAU_TRU_NHAM_THAU_CHI =
  "Chênh đúng bằng dư nợ thấu chi — có thể bạn đã trừ khoản thấu chi khỏi số dư ngân hàng. " +
  "Ô ngân hàng nhập số dư THẬT trên tài khoản (thấu chi theo dõi riêng).";

/** `chenh` = chênh lệch cần xét (chốt số dư: chênh lệch; bước bật: phần CHƯA giải thích). */
export function laTruNhamThauChi(chenh: number, duNoThauChi: number): boolean {
  return duNoThauChi > 0 && Math.abs(chenh + duNoThauChi) <= DUNG_SAI_TRU_NHAM_THAU_CHI;
}
