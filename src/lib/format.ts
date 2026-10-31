/**
 * Money formatting helpers. VND is always an integer number of đồng — no
 * floats, no other currencies. These are the ONLY functions in the app that
 * render money to text; every screen must go through them so the format
 * (dot thousands separator, U+2212 minus sign, "₫" symbol) stays consistent.
 */

const VND_SYMBOL = "₫";

// U+2212 MINUS SIGN — the typographic minus used across the design spec
// (e.g. "−3.400.000 ₫"), distinct from the ASCII hyphen-minus "-".
const MINUS_SIGN = "−";

/** Chữ thay cho số không tính được (tỷ lệ/số đếm không hữu hạn). */
const KHONG_CO_SO = "—";

function assertFiniteAmount(n: number, fnName: string): void {
  if (!Number.isFinite(n)) {
    throw new RangeError(`${fnName}: expected a finite number of đồng, got ${n}`);
  }
}

/** Groups a digit-only string with "." every 3 digits from the right. */
function groupThousands(digits: string): string {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ".");
}

/**
 * Formats an integer amount of đồng as `1.250.000 ₫`.
 * Negative amounts render as `−3.400.000 ₫` (U+2212, no space before digits).
 * Stray floats are rounded to the nearest đồng (money must be an integer).
 */
export function formatVnd(n: number): string {
  assertFiniteAmount(n, "formatVnd");

  const rounded = Math.round(n);
  const isNegative = rounded < 0;
  const grouped = groupThousands(Math.abs(rounded).toString());
  const sign = isNegative ? MINUS_SIGN : "";

  return `${sign}${grouped} ${VND_SYMBOL}`;
}

/**
 * Formats an integer amount of đồng as a compact "triệu" (million) figure,
 * e.g. `182,5tr ₫`. Rounds to 1 decimal place and drops the decimal when the
 * amount is a whole number of triệu (`5tr ₫`, not `5,0tr ₫`).
 */
export function formatVndShort(n: number): string {
  assertFiniteAmount(n, "formatVndShort");

  const rounded = Math.round(n);
  const isNegative = rounded < 0;
  const absMillions = Math.abs(rounded) / 1_000_000;

  // toFixed(1) does the decimal rounding; trailing ".0" means "whole triệu".
  const fixed = absMillions.toFixed(1);
  const hasDecimal = !fixed.endsWith(".0");
  const numberPart = hasDecimal ? fixed.replace(".", ",") : fixed.slice(0, -2);

  // Suppress the sign when the displayed magnitude rounds down to 0
  // (avoids showing "−0tr ₫").
  const sign = isNegative && numberPart !== "0" ? MINUS_SIGN : "";

  return `${sign}${numberPart}tr ${VND_SYMBOL}`;
}

/**
 * Tỷ lệ phần trăm kiểu Việt: tối đa 1 chữ số thập phân, bỏ ",0" thừa: `12%`, `12,5%` (không `12,0%`).
 * MỘT kiểu duy nhất cho mọi bảng/thẻ trong app (Lãi/Lỗ, kênh, dashboard, báo cáo SP); thay cho các bản
 * `toFixed(1)` và `toLocaleString` rải ở từng component. Không dùng cho tiền (tiền chỉ `formatVnd`).
 */
export function formatPercent(n: number): string {
  // Không hữu hạn (0/0, chia cho 0) thì in "—" thay vì ném: hàm này gọi ở ~30 nơi hiển thị, một ô tỷ lệ hỏng
  // không được làm sập cả tab. Chỉ hàm TIỀN mới ném — in sai một con số tiền còn tệ hơn là lỗi to.
  if (!Number.isFinite(n)) return KHONG_CO_SO;
  return `${n.toLocaleString("vi-VN", { maximumFractionDigits: 1 })}%`;
}

// Dựng một lần: `Intl.NumberFormat` khá đắt mà bảng gọi hàng trăm lần mỗi lần render.
const boDinhDangSoDem = new Intl.NumberFormat("vi-VN");

/**
 * Số ĐẾM (lượt xem, click, số đơn, số khách…) có dấu chấm ngăn nghìn kiểu Việt: `12.345`. KHÔNG dùng
 * cho tiền — tiền chỉ đi qua `formatVnd` để giữ ký hiệu `₫` và dấu trừ thống nhất.
 */
export function formatSoDem(n: number): string {
  if (!Number.isFinite(n)) return KHONG_CO_SO;
  return boDinhDangSoDem.format(n);
}
