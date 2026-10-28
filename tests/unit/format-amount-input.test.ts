import { describe, expect, it } from "vitest";

import {
  docAmountInput,
  formatAmountInput,
  loiVuotTranAmount,
  MAX_AMOUNT_INPUT,
  parseAmountInput,
} from "@/lib/format-amount-input";

/**
 * `parseAmountInput` là parser DUY NHẤT cho ô tiền ghi tay (form chi phí, sửa số tiền trước mốc,
 * duyệt chi phí nhập hàng…): chỉ giữ chữ số, không bao giờ âm; KHÔNG kẹp im lặng khi vượt trần (cờ `vuotTran` để form báo lỗi).
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

  it("KHÔNG kẹp im lặng khi vượt trần: giữ nguyên số gõ để form báo lỗi", () => {
    expect(parseAmountInput("2.000.000.000")).toBe(MAX_AMOUNT_INPUT);
    expect(parseAmountInput("2.500.000.000")).toBe(2_500_000_000);
    expect(parseAmountInput("2.000.000.001")).toBe(2_000_000_001);
  });

  it("chuỗi quá dài vẫn ra số nguyên an toàn và vẫn vượt trần", () => {
    const n = parseAmountInput("99999999999999999999999");
    expect(Number.isSafeInteger(n)).toBe(true);
    expect(n).toBeGreaterThan(MAX_AMOUNT_INPUT);
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

describe("docAmountInput", () => {
  it("đúng trần hoặc dưới ⇒ vuotTran false", () => {
    expect(docAmountInput("2.000.000.000")).toEqual({ value: MAX_AMOUNT_INPUT, vuotTran: false });
    expect(docAmountInput("1.500.000")).toEqual({ value: 1_500_000, vuotTran: false });
    expect(docAmountInput("")).toEqual({ value: 0, vuotTran: false });
  });

  it("gõ 2,5 tỷ ⇒ vuotTran true và GIỮ số 2,5 tỷ (không nhảy về trần)", () => {
    expect(docAmountInput("2.500.000.000")).toEqual({ value: 2_500_000_000, vuotTran: true });
    expect(docAmountInput("2.000.000.001").vuotTran).toBe(true);
  });
});

describe("loiVuotTranAmount", () => {
  it("trong trần ⇒ null; vượt ⇒ câu lỗi nêu đúng trần", () => {
    expect(loiVuotTranAmount(MAX_AMOUNT_INPUT)).toBeNull();
    expect(loiVuotTranAmount(0)).toBeNull();
    expect(loiVuotTranAmount(MAX_AMOUNT_INPUT + 1)).toBe("Số tiền tối đa 2.000.000.000 đ");
  });
});
