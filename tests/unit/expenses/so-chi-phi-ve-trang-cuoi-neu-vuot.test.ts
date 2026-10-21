/**
 * Tab "Sổ chi phí": `?trang=` vượt trang cuối (đang ở trang 5, lọc lại còn 2 trang) ⇒ chuyển hướng về trang
 * cuối, GIỮ bộ lọc và gắn lại `tab=so-chi-phi` (mất `tab` là rơi về Lãi/Lỗ). Trang hợp lệ thì không chuyển.
 * Gọi thẳng hàm component (server component), `redirect` giả ném lỗi để bắt URL.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { EXPENSE_PAGE_SIZE } from "@/lib/expenses/expense-page-size";

const m = vi.hoisted(() => ({ count: 0 }));

vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`REDIRECT:${url}`);
  },
}));
vi.mock("@/lib/no-phai-tra/cong-bat-no-phai-tra", async (goc) => ({
  ...(await goc<typeof import("@/lib/no-phai-tra/cong-bat-no-phai-tra")>()),
  docMocM: async () => null,
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    expenseCategory: { findMany: async () => [] },
    channel: { findMany: async () => [] },
    setting: { findMany: async () => [] },
    theTinDung: { findMany: async () => [] },
    order: { count: async () => 0 },
  },
}));
vi.mock("@/lib/expenses/ensure-recurring-expenses", async (goc) => ({
  ...(await goc<typeof import("@/lib/expenses/ensure-recurring-expenses")>()),
  ensureRecurringExpensesForMonthsChiTiet: async () => ({ daTao: 0, boQuaNhapHang: 0, boQuaTruocM: 0 }),
}));
vi.mock("@/lib/expenses/expense-queries", () => ({
  getExpenseSummary: async () => ({ total: 0, breakdown: [] }),
  sumPlatformFeeEst: async () => 0,
  getExpensesPage: async () => ({ rows: [], count: m.count, totalAmount: 0 }),
  getRecurringExpenseList: async () => [],
}));

import { ExpenseLedgerTab } from "@/components/finance/expense-ledger-tab";

const range = { from: new Date(2026, 9, 1), to: new Date(2026, 9, 31) };

beforeEach(() => {
  // 2 trang đầy + 5 dòng ⇒ trang cuối = 3.
  m.count = 2 * EXPENSE_PAGE_SIZE + 5;
});

describe("ExpenseLedgerTab — ?trang= vượt trang cuối", () => {
  it("chuyển về trang cuối, giữ bộ lọc và gắn lại tab", async () => {
    await expect(ExpenseLedgerTab({ sp: { trang: "9", q: "ads", nguon: "import" }, range })).rejects.toThrow(
      "REDIRECT:/tai-chinh?q=ads&nguon=import&tab=so-chi-phi&trang=3",
    );
  });

  it("tham số lặp (?trang=9&trang=2) lấy giá trị đầu và vẫn chuyển hướng, không ném TypeError", async () => {
    await expect(
      ExpenseLedgerTab({ sp: { trang: ["9", "2"] as unknown as string, q: ["a", "b"] as unknown as string }, range }),
    ).rejects.toThrow("REDIRECT:/tai-chinh?q=a&tab=so-chi-phi&trang=3");
  });

  it("kết quả rỗng ⇒ trang cuối là 1: URL không còn ?trang=", async () => {
    m.count = 0;
    await expect(ExpenseLedgerTab({ sp: { trang: "4" }, range })).rejects.toThrow("REDIRECT:/tai-chinh?tab=so-chi-phi");
  });

  it("trang hợp lệ (đúng trang cuối) ⇒ không chuyển hướng", async () => {
    await expect(ExpenseLedgerTab({ sp: { trang: "3" }, range })).resolves.toBeDefined();
  });
});
