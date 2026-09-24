import { describe, expect, it } from "vitest";

import { MAX_AMOUNT_INPUT, parseSignedAmountInput } from "@/lib/format-amount-input";

/** Ô số dư bank của bản chốt: dấu trừ phải sống sót qua parser — thấu chi làm bank âm. */
describe("parseSignedAmountInput", () => {
  it("giữ dấu trừ ASCII lẫn U+2212, có hoặc không có phân cách", () => {
    expect(parseSignedAmountInput("-20.000.000")).toBe(-20_000_000);
    expect(parseSignedAmountInput("−20000000")).toBe(-20_000_000);
    expect(parseSignedAmountInput("  -1.500 ₫")).toBe(-1_500);
  });

  it("không dấu ⇒ dương như parser thường; rỗng/chỉ dấu ⇒ 0", () => {
    expect(parseSignedAmountInput("85.000.000")).toBe(85_000_000);
    expect(parseSignedAmountInput("")).toBe(0);
    expect(parseSignedAmountInput("-")).toBe(0);
  });

  it("kẹp trần 2 tỷ ở CẢ HAI chiều", () => {
    expect(parseSignedAmountInput("9999999999")).toBe(MAX_AMOUNT_INPUT);
    expect(parseSignedAmountInput("-9999999999")).toBe(-MAX_AMOUNT_INPUT);
  });
});
