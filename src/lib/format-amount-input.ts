/**
 * Ô nhập TIỀN của form ghi tay: gõ gì cũng chỉ giữ chữ số, kẹp trần rồi hiện lại có dấu phân cách.
 *
 * Trần 2 tỷ khớp zod ở mọi action (Prisma `Int` = int32, chết ở 2.147.483.647). Kẹp ở client CHỈ là
 * UX — cổng thật vẫn ở action, đừng bỏ bên đó đi.
 */
export const MAX_AMOUNT_INPUT = 2_000_000_000;

export function parseAmountInput(raw: string): number {
  const digits = raw.replace(/\D/g, "");
  return digits ? Math.min(Number.parseInt(digits, 10), MAX_AMOUNT_INPUT) : 0;
}

/** Hiện lại số trong ô: 0 ⇒ để TRỐNG (đừng ép chủ shop xoá số 0 trước khi gõ). */
export function formatAmountInput(amount: number): string {
  return amount ? new Intl.NumberFormat("vi-VN").format(amount) : "";
}

/**
 * Ô số dư NGÂN HÀNG của bản chốt cuối tháng: như `parseAmountInput` nhưng GIỮ dấu trừ đầu chuỗi —
 * thấu chi làm số dư bank âm là hợp lệ. Nhận cả "-" ASCII lẫn "−" (U+2212) vì `formatVnd` in dấu
 * trừ dài và chủ shop có thể dán lại từ màn hình. Chỉ ô này dùng; các ô tiền khác vẫn không âm.
 */
export function parseSignedAmountInput(raw: string): number {
  const am = /^\s*[-−]/.test(raw);
  const n = parseAmountInput(raw);
  // "-" gõ dở hoặc "-0" ⇒ trả 0 thật, KHÔNG phải -0: `Object.is(-0, 0)` là false và `formatVnd(-0)` in
  // "-0 ₫" — cả test lẫn màn hình đều lộ dấu trừ của một số không.
  if (n === 0) return 0;
  return am ? -n : n;
}
