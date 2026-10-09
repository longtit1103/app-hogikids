// @vitest-environment jsdom
/**
 * Khoản chi "Trừ vào thẻ" (`Expense.cardId`) trên Sổ chi phí:
 *  - form SỬA điền sẵn thẻ đang gắn ⇒ bấm Lưu không đụng ô thẻ thì vẫn gửi đúng `cardId` cũ (không lặng
 *    lẽ gỡ thẻ = chuyển khoản chi sang trừ quỹ);
 *  - bảng hiện nhãn nhỏ "trừ thẻ <tên>" dưới mô tả, dòng không gắn thẻ thì không.
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { addDays, format } from "date-fns";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

const updateExpense = vi.hoisted(() => vi.fn());

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: () => {}, replace: () => {}, push: () => {} }),
  usePathname: () => "/tai-chinh",
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/actions/expenses", () => ({
  createExpense: vi.fn(),
  updateExpense,
  stopRecurring: vi.fn(),
  deleteExpense: vi.fn(),
}));
vi.mock("@/components/ui/select", () => {
  const Bo = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  return {
    Select: Bo,
    SelectContent: Bo,
    SelectGroup: Bo,
    SelectLabel: Bo,
    SelectTrigger: Bo,
    SelectValue: () => null,
    SelectItem: ({ value, children }: { value: string; children?: ReactNode }) => (
      <div role="option" aria-selected={false} data-value={value}>
        {children}
      </div>
    ),
  };
});

import { ExpenseFormModal } from "@/components/expenses/expense-form-modal";
import { ExpenseTable } from "@/components/expenses/expense-table";
import type { ExpenseRow } from "@/lib/expenses/expense-queries";

afterEach(cleanup);

const homNay = new Date();
const MOC_M = format(addDays(homNay, -10), "yyyy-MM-dd");

function dong(o: Partial<ExpenseRow> = {}): ExpenseRow {
  return {
    id: "e1",
    date: homNay,
    categoryId: "shipping",
    categoryName: "Ship",
    categoryIsHidden: false,
    adsSource: null,
    description: "Phí thường niên",
    channelId: null,
    channelName: null,
    channelColor: null,
    amount: 300_000,
    source: "MANUAL",
    recurringId: null,
    refId: null,
    cardId: null,
    tenThe: null,
    ...o,
  };
}

describe("form sửa khoản chi — điền sẵn thẻ đang gắn", () => {
  it("dòng có cardId ⇒ Lưu không đổi gì vẫn gửi đúng cardId cũ; dòng không thẻ ⇒ gửi null", async () => {
    updateExpense.mockResolvedValue({ ok: true, data: undefined });
    for (const [cardId, tenThe] of [
      ["t1", "Visa"],
      [null, null],
    ] as const) {
      updateExpense.mockClear();
      render(
        <ExpenseFormModal
          open
          onOpenChange={() => {}}
          categories={[{ id: "shipping", name: "Ship" }]}
          channels={[]}
          expense={dong({ cardId, tenThe })}
          theTinDung={{ mocM: MOC_M, the: [{ id: "t1", ten: "Visa" }] }}
        />,
      );
      fireEvent.click(screen.getByRole("button", { name: "Lưu" }));
      await waitFor(() => expect(updateExpense).toHaveBeenCalledTimes(1));
      expect(updateExpense.mock.calls[0][0]).toBe("e1");
      expect(updateExpense.mock.calls[0][1]).toMatchObject({ cardId });
      cleanup();
    }
  });
});

describe("bảng Sổ chi phí — nhãn 'trừ thẻ <tên>'", () => {
  const props = { count: 1, totalAmount: 300_000, categories: [], channels: [] };

  it("dòng gắn thẻ ⇒ có nhãn (cả bảng rộng lẫn thẻ mobile); dòng không thẻ ⇒ không", () => {
    const co = renderToStaticMarkup(<ExpenseTable {...props} rows={[dong({ cardId: "t1", tenThe: "Visa" })]} />);
    expect(co.split("trừ thẻ Visa").length - 1).toBe(2);

    const khong = renderToStaticMarkup(<ExpenseTable {...props} rows={[dong()]} />);
    expect(khong).not.toContain("trừ thẻ");
  });
});
