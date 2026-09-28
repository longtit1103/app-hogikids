import { describe, expect, it } from "vitest";

import { formatVnd, formatVndShort } from "@/lib/format";

describe("formatVnd", () => {
  it("formats zero as 0 ₫", () => {
    expect(formatVnd(0)).toBe("0 ₫");
  });

  it("formats a positive amount with dot thousands separators", () => {
    expect(formatVnd(1_250_000)).toBe("1.250.000 ₫");
  });

  it("formats a small amount without separators", () => {
    expect(formatVnd(500)).toBe("500 ₫");
  });

  it("formats a negative amount with the U+2212 minus sign directly before the digits", () => {
    expect(formatVnd(-3_400_000)).toBe("−3.400.000 ₫");
  });

  it("rounds stray float input to the nearest integer đồng", () => {
    expect(formatVnd(1_250_000.6)).toBe("1.250.001 ₫");
  });

  it("throws for non-finite input", () => {
    expect(() => formatVnd(Number.NaN)).toThrow();
    expect(() => formatVnd(Number.POSITIVE_INFINITY)).toThrow();
  });
});

describe("formatVndShort", () => {
  it("formats zero as 0tr ₫", () => {
    expect(formatVndShort(0)).toBe("0tr ₫");
  });

  it("formats a triệu amount with comma decimal separator", () => {
    expect(formatVndShort(182_500_000)).toBe("182,5tr ₫");
  });

  it("drops the decimal when the amount is a whole number of triệu", () => {
    expect(formatVndShort(5_000_000)).toBe("5tr ₫");
  });

  it("rounds to 1 decimal place", () => {
    expect(formatVndShort(2_340_000)).toBe("2,3tr ₫");
  });

  it("formats a negative amount with the U+2212 minus sign", () => {
    expect(formatVndShort(-2_500_000)).toBe("−2,5tr ₫");
  });

  it("throws for non-finite input", () => {
    expect(() => formatVndShort(Number.NaN)).toThrow();
  });
});
