import { formatVnd } from "@/lib/format";

/**
 * Ô nhập TIỀN của form ghi tay: gõ gì cũng chỉ giữ chữ số rồi hiện lại có dấu phân cách.
 *
 * Trần 2 tỷ khớp zod ở mọi action (Prisma `Int` = int32, chết ở 2.147.483.647). Vượt trần KHÔNG bị
 * kẹp im lặng (gõ 2,5 tỷ mà ô tự nhảy về 2 tỷ ⇒ lưu sai 500tr không ai biết): giữ nguyên số gõ, form
 * soi bằng `docAmountInput().vuotTran` / `loiVuotTranAmount` để hiện lỗi và chặn nút lưu. Cổng thật
 * vẫn ở action — đừng bỏ bên đó đi.
 */
export const MAX_AMOUNT_INPUT = 2_000_000_000;

/** Số chữ số tối đa còn là số nguyên an toàn của JS (15 < 16 = độ dài `MAX_SAFE_INTEGER`). */
const MAX_CHU_SO = 15;

export type KetQuaAmountInput = {
  /** Số đã gõ, KHÔNG kẹp trần (chuỗi quá 15 chữ số bị cắt để vẫn là số nguyên an toàn — vẫn vượt trần). */
  value: number;
  /** `value` > `MAX_AMOUNT_INPUT` — form phải báo lỗi, không được lưu. */
  vuotTran: boolean;
};

export function docAmountInput(raw: string): KetQuaAmountInput {
  const digits = raw.replace(/\D/g, "").slice(0, MAX_CHU_SO);
  const value = digits ? Number.parseInt(digits, 10) : 0;
  return { value, vuotTran: value > MAX_AMOUNT_INPUT };
}

export function parseAmountInput(raw: string): number {
  return docAmountInput(raw).value;
}

/** Câu lỗi hiện dưới ô tiền khi vượt trần; `null` = hợp lệ. Dùng chung để mọi form nói cùng một câu. */
export function loiVuotTranAmount(value: number): string | null {
  return value > MAX_AMOUNT_INPUT
    ? `Số tiền tối đa ${formatVnd(MAX_AMOUNT_INPUT)}`
    : null;
}

/** Hiện lại số trong ô: 0 ⇒ để TRỐNG (đừng ép chủ shop xoá số 0 trước khi gõ). */
export function formatAmountInput(amount: number): string {
  return amount ? new Intl.NumberFormat("vi-VN").format(amount) : "";
}

/**
 * Ô số dư NGÂN HÀNG của bản chốt cuối tháng: như `parseAmountInput` nhưng GIỮ dấu trừ đầu chuỗi —
 * tài khoản thanh toán có thể âm thật nên số dư âm là hợp lệ. Nhận cả "-" ASCII lẫn "−" (U+2212) vì `formatVnd` in dấu
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
