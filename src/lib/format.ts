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
