// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { addDays, format } from "date-fns";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {}, replace: () => {}, push: () => {} }) }));
vi.mock("@/lib/actions/expenses", () => ({ createExpense: vi.fn(), updateExpense: vi.fn(), stopRecurring: vi.fn() }));
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
import type { ExpenseRow } from "@/lib/expenses/expense-queries";

afterEach(cleanup);

const homNay = new Date();
const MOC_M = format(addDays(homNay, -10), "yyyy-MM-dd");
const THE = { mocM: MOC_M, the: [{ id: "t1", ten: "Visa" }] };

function dong(o: Partial<ExpenseRow> & { categoryId: string }): ExpenseRow {
  return {
    id: "e1",
    date: homNay,
    amount: 100_000,
    channelId: null,
    description: "",
    source: "MANUAL",
    refId: null,
    recurringId: null,
    adsSource: null,
    ...o,
  } as unknown as ExpenseRow;
}

function mo(expense: ExpenseRow, theTinDung?: typeof THE | { mocM: null; the: typeof THE.the }) {
  render(
    <ExpenseFormModal
      open
      onOpenChange={() => {}}
      categories={[
        { id: "shipping", name: "Ship" },
        { id: "ads", name: "Ads" },
      ]}
      channels={[]}
      expense={expense}
      theTinDung={theTinDung}
    />,
  );
}

describe("ExpenseFormModal — ô 'Trừ vào thẻ'", () => {
  it("sau bật + danh mục thường + nhập tay + ngày ≥ M ⇒ có ô, liệt kê thẻ", () => {
    mo(dong({ categoryId: "shipping" }), THE);
    expect(screen.getByText("Trừ vào thẻ")).toBeTruthy();
    expect(screen.getByText("Visa")).toBeTruthy();
  });

  it("chưa bật (mocM null) hoặc không truyền ⇒ form y như cũ", () => {
    mo(dong({ categoryId: "shipping" }), { mocM: null, the: THE.the });
    expect(screen.queryByText("Trừ vào thẻ")).toBeNull();
    cleanup();
    mo(dong({ categoryId: "shipping" }));
    expect(screen.queryByText("Trừ vào thẻ")).toBeNull();
  });

  it("dòng không phải nhập tay (định kỳ) ⇒ không có ô", () => {
    mo(dong({ categoryId: "shipping", source: "RECURRING" } as Partial<ExpenseRow> & { categoryId: string }), THE);
    expect(screen.queryByText("Trừ vào thẻ")).toBeNull();
  });

  it("ngày trước M ⇒ không có ô (tiền trước M không đi qua thẻ)", () => {
    mo(dong({ categoryId: "shipping", date: addDays(homNay, -30) }), THE);
    expect(screen.queryByText("Trừ vào thẻ")).toBeNull();
  });

  it("danh mục ads ⇒ không có ô, thay bằng cảnh báo 'Trả sao kê… KHÔNG ghi ở đây'", () => {
    mo(dong({ categoryId: "ads", adsSource: "META" } as Partial<ExpenseRow> & { categoryId: string }), THE);
    expect(screen.queryByText("Trừ vào thẻ")).toBeNull();
    expect(screen.getByTestId("expense-canh-bao-tra-sao-ke").textContent).toContain(
      "Trả sao kê thẻ ghi ở Sổ quỹ → Trả thẻ; KHÔNG ghi ở đây",
    );
    expect(screen.queryByTestId("expense-canh-bao-the-tin-dung")).toBeNull();
  });

  it("chưa bật + ads ⇒ vẫn là cảnh báo cũ", () => {
    mo(dong({ categoryId: "ads", adsSource: "META" } as Partial<ExpenseRow> & { categoryId: string }), { mocM: null, the: THE.the });
    expect(screen.getByTestId("expense-canh-bao-the-tin-dung")).toBeTruthy();
  });
});
