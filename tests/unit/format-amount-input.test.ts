import { describe, expect, it } from "vitest";

import { formatAmountInput, MAX_AMOUNT_INPUT, parseAmountInput } from "@/lib/format-amount-input";

/**
 * `parseAmountInput` là parser DUY NHẤT cho ô tiền ghi tay (form chi phí, sửa số tiền trước mốc,
 * duyệt chi phí nhập hàng…): chỉ giữ chữ số, không bao giờ âm, kẹp trần 2 tỷ.
 */
describe("parseAmountInput", () => {
  it("bỏ mọi ký tự không phải chữ số (phân cách, ký hiệu tiền, khoảng trắng)", () => {
    expect(parseAmountInput("1.500.000")).toBe(1_500_000);
    expect(parseAmountInput("1,500,000 ₫")).toBe(1_500_000);
    expect(parseAmountInput(" 85 000 ")).toBe(85_000);
  });

  it("rỗng hoặc không có chữ số ⇒ 0", () => {
    expect(parseAmountInput("")).toBe(0);
    expect(parseAmountInput("abc")).toBe(0);
    expect(parseAmountInput("-")).toBe(0);
  });

  it("KHÔNG giữ dấu trừ — số âm chỉ có ở parseSignedAmountInput", () => {
    expect(parseAmountInput("-20.000")).toBe(20_000);
    expect(parseAmountInput("−20.000")).toBe(20_000);
  });

  it("kẹp trần 2 tỷ, đúng trần thì giữ nguyên", () => {
    expect(parseAmountInput("2.000.000.000")).toBe(MAX_AMOUNT_INPUT);
    expect(parseAmountInput("2.000.000.001")).toBe(MAX_AMOUNT_INPUT);
    expect(parseAmountInput("99999999999999")).toBe(MAX_AMOUNT_INPUT);
  });

  it("số 0 đầu chuỗi được bỏ", () => {
    expect(parseAmountInput("000123")).toBe(123);
    expect(parseAmountInput("0")).toBe(0);
  });
});

describe("formatAmountInput", () => {
  it("0 ⇒ để trống; có số ⇒ phân cách kiểu vi-VN", () => {
    expect(formatAmountInput(0)).toBe("");
    expect(formatAmountInput(1_500_000)).toBe("1.500.000");
  });
});
