import { describe, expect, it } from "vitest";

import { hasPurchaseSpend } from "@/components/finance/cash-flow-tab";
import type { CategoryBreakdownItem } from "@/lib/expenses/expense-queries";

/**
 * Guardrail card "Số dư dòng tiền" — kỳ CHƯA ghi khoản "Nhập hàng" thì số dư
 * lạc quan hơn thực tế (Nhập hàng không vào P&L nhưng CÓ vào tiền ra), UI phải
 * chú thích thẳng. `outBreakdown` do `getExpenseSummary` lọc `amount > 0` nên
 * chỉ chứa danh mục CÓ phát sinh.
 */

function item(categoryId: string, amount: number): CategoryBreakdownItem {
  return { categoryId, name: categoryId, amount, pct: 0 };
}

describe("hasPurchaseSpend", () => {
  it("kỳ trống (chưa ghi chi phí nào) → false", () => {
    expect(hasPurchaseSpend([])).toBe(false);
  });

  it("có chi phí nhưng không có Nhập hàng → false", () => {
    expect(hasPurchaseSpend([item("ads", 5_000_000), item("shipping", 300_000)])).toBe(false);
  });

  it("có danh mục Nhập hàng → true", () => {
    expect(hasPurchaseSpend([item("ads", 5_000_000), item("purchase", 20_000_000)])).toBe(true);
  });

  it("Nhập hàng đứng đầu breakdown vẫn nhận diện được", () => {
    expect(hasPurchaseSpend([item("purchase", 20_000_000), item("other", 100_000)])).toBe(true);
  });
});
