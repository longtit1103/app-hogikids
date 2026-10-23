import { describe, expect, it } from "vitest";

import { parseMoneyInput, parseThresholdInput } from "@/lib/parse-inline-product-input";

/**
 * Test vàng: hai bảng sản phẩm từng chép riêng hai hàm này. Bản gốc được giữ nguyên dưới đây để so
 * kết quả từng đầu vào — gom về một chỗ KHÔNG được đổi hành vi.
 */
function parseMoneyInputGoc(raw: string): number | undefined {
  const cleaned = raw.replace(/[^\d]/g, "");
  if (cleaned === "") return undefined;
  const n = Number.parseInt(cleaned, 10);
  return Number.isFinite(n) ? n : undefined;
}

function parseThresholdInputGoc(raw: string): number | null | undefined {
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  const cleaned = trimmed.replace(/[^\d]/g, "");
  if (cleaned === "") return undefined;
  const n = Number.parseInt(cleaned, 10);
  return Number.isFinite(n) ? n : undefined;
}

const DAU_VAO = ["", " ", "0", "45.000", "45000", "1,500,000 ₫", "abc", "-5", "12abc34", " 7 ", "00012", "9".repeat(400)];

describe("parseMoneyInput", () => {
  it("giá trị cụ thể", () => {
    expect(parseMoneyInput("45.000")).toBe(45000);
    expect(parseMoneyInput("45000")).toBe(45000);
    expect(parseMoneyInput("0")).toBe(0);
    expect(parseMoneyInput("")).toBeUndefined();
    expect(parseMoneyInput("abc")).toBeUndefined();
    // Dấu trừ bị bỏ như mọi ký tự không phải chữ số ⇒ không bao giờ âm.
    expect(parseMoneyInput("-5")).toBe(5);
  });

  it.each(DAU_VAO)("khớp bản gốc với %j", (vao) => {
    expect(parseMoneyInput(vao)).toBe(parseMoneyInputGoc(vao));
  });
});

describe("parseThresholdInput", () => {
  it("giá trị cụ thể", () => {
    expect(parseThresholdInput("")).toBeNull();
    expect(parseThresholdInput("   ")).toBeNull();
    expect(parseThresholdInput("abc")).toBeUndefined();
    expect(parseThresholdInput("12")).toBe(12);
    expect(parseThresholdInput(" 7 ")).toBe(7);
  });

  it.each(DAU_VAO)("khớp bản gốc với %j", (vao) => {
    expect(parseThresholdInput(vao)).toBe(parseThresholdInputGoc(vao));
  });
});
