// @vitest-environment jsdom
/**
 * Tab "Sổ chi phí" (server component) nối mốc M sang khối định kỳ và sang ô "Trừ vào thẻ" theo QUYỀN:
 *  - người có `chi-phi:sua` (kế toán) mà không có `tai-chinh-so-quy:sua`: KHÔNG nhận danh sách thẻ (tên thẻ là
 *    dữ liệu Sổ quỹ) nhưng vẫn nhận M để khối định kỳ ẩn nút "Bật lại" của mẫu Nhập hàng (server sẽ từ chối);
 *  - đủ cả hai quyền: có danh sách thẻ + khối định kỳ nhận M;
 *  - chưa bật theo dõi nợ: khối định kỳ giữ nút.
 * Gọi thẳng hàm component (không render cả trang) rồi soi props của phần tử con.
 */
import { cleanup, render, screen } from "@testing-library/react";
import { isValidElement, type ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { RecurringExpenseRow } from "@/lib/expenses/expense-queries";
import { quetGiaTri } from "../../trang-theo-quyen/quet-cay-phan-tu";

const TEN_THE_BI_MAT = "Thẻ Techcombank bí mật";
const MOC_M = new Date("2026-10-01T00:00:00+07:00");

const m = vi.hoisted(() => ({
  docMocM: vi.fn(),
  theFindMany: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: () => {}, replace: () => {}, push: () => {} }),
  usePathname: () => "/tai-chinh",
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/lib/actions/expenses", () => ({ batLaiDinhKy: vi.fn() }));
vi.mock("@/lib/no-phai-tra/cong-bat-no-phai-tra", async (goc) => ({
  ...(await goc<typeof import("@/lib/no-phai-tra/cong-bat-no-phai-tra")>()),
  docMocM: m.docMocM,
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    expenseCategory: { findMany: async () => [{ id: "purchase", name: "Nhập hàng", isHidden: false }] },
    channel: { findMany: async () => [] },
    setting: { findMany: async () => [] },
    theTinDung: { findMany: m.theFindMany },
    order: { count: async () => 0 },
  },
}));
vi.mock("@/lib/expenses/ensure-recurring-expenses", async (goc) => ({
  ...(await goc<typeof import("@/lib/expenses/ensure-recurring-expenses")>()),
  ensureRecurringExpensesForMonthsChiTiet: async () => ({ daTao: 0, boQuaNhapHang: 0 }),
}));

// Mẫu "Nhập hàng" ĐÃ DỪNG: id `purchase`, tên hiển thị "Nhập hàng".
const MAU_NHAP_HANG: RecurringExpenseRow = {
  id: "mau-nhap-hang",
  description: "Nhập hàng NCC A",
  categoryId: "purchase",
  categoryName: "Nhập hàng",
  channelName: null,
  amount: 20_000_000,
  dayOfMonth: 5,
  active: false,
  activeFrom: null,
};
vi.mock("@/lib/expenses/expense-queries", () => ({
  getExpenseSummary: async () => ({ total: 0, breakdown: [] }),
  sumPlatformFeeEst: async () => 0,
  getExpensesPage: async () => ({ rows: [], count: 0, totalAmount: 0 }),
  getRecurringExpenseList: async () => [MAU_NHAP_HANG],
}));

import { ExpenseLedgerTab } from "@/components/finance/expense-ledger-tab";
import { KhoanChiDinhKySection } from "@/components/finance/khoan-chi-dinh-ky-section";

type Props = Record<string, unknown>;

/** Phần tử ĐẦU TIÊN trong cây có `type` là hàm tên `ten`; trả props. */
function timProps(node: unknown, ten: string): Props | null {
  if (!isValidElement(node)) {
    if (Array.isArray(node)) {
      for (const c of node) {
        const r = timProps(c, ten);
        if (r) return r;
      }
    }
    return null;
  }
  const el = node as ReactElement<Props>;
  if (typeof el.type === "function" && el.type.name === ten) return el.props;
  return timProps(el.props.children, ten);
}

async function dungTab(quyen: { choPhepSua: boolean; choPhepTruThe: boolean }, moc: Date | null) {
  m.docMocM.mockResolvedValue(moc);
  const range = { from: new Date(2026, 9, 1), to: new Date(2026, 9, 31) };
  return ExpenseLedgerTab({ sp: {}, range, ...quyen });
}

beforeEach(() => {
  m.docMocM.mockReset();
  m.theFindMany.mockReset().mockResolvedValue([{ id: "the-1", ten: TEN_THE_BI_MAT }]);
});
afterEach(cleanup);

describe("ExpenseLedgerTab — M và danh sách thẻ theo quyền", () => {
  it("(a) chi-phi:sua + so-quy:sua + đã bật: ô Trừ vào thẻ có danh sách thẻ, khối định kỳ nhận M", async () => {
    const cay = await dungTab({ choPhepSua: true, choPhepTruThe: true }, MOC_M);

    const them = timProps(cay, "ExpenseAddButton");
    expect(them?.theTinDung).toEqual({ mocM: "2026-10-01", the: [{ id: "the-1", ten: TEN_THE_BI_MAT }] });
    expect(timProps(cay, "KhoanChiDinhKySection")?.mocNoPhaiTra).toEqual(MOC_M);
  });

  it("(b) chỉ chi-phi:sua + đã bật: KHÔNG thẻ nào (không query, tên thẻ vắng) nhưng khối định kỳ ẩn nút + có chú thích", async () => {
    const cay = await dungTab({ choPhepSua: true, choPhepTruThe: false }, MOC_M);

    expect(timProps(cay, "ExpenseAddButton")?.theTinDung).toBeUndefined();
    expect(m.theFindMany).not.toHaveBeenCalled();
    expect(quetGiaTri(cay).some(({ giaTri }) => giaTri === TEN_THE_BI_MAT)).toBe(false);

    const props = timProps(cay, "KhoanChiDinhKySection");
    expect(props?.mocNoPhaiTra).toEqual(MOC_M);
    render(<KhoanChiDinhKySection {...(props as React.ComponentProps<typeof KhoanChiDinhKySection>)} />);
    expect(screen.queryByRole("button", { name: "Bật lại" })).toBeNull();
    expect(screen.getByTestId("dinh-ky-nhap-hang-di-so-no").textContent).toContain("Từ 01/10/2026");
  });

  it("(c) chưa bật theo dõi nợ: khối định kỳ nhận M = null ⇒ mẫu Nhập hàng vẫn có nút", async () => {
    const cay = await dungTab({ choPhepSua: true, choPhepTruThe: true }, null);

    expect(timProps(cay, "ExpenseAddButton")?.theTinDung).toBeUndefined();
    const props = timProps(cay, "KhoanChiDinhKySection");
    expect(props?.mocNoPhaiTra).toBeNull();
    render(<KhoanChiDinhKySection {...(props as React.ComponentProps<typeof KhoanChiDinhKySection>)} />);
    expect(screen.getAllByRole("button", { name: "Bật lại" })).toHaveLength(1);
    expect(screen.queryByTestId("dinh-ky-nhap-hang-di-so-no")).toBeNull();
  });

  it("(d) không có quyền sửa: không đọc M, không thẻ, khối định kỳ không nút", async () => {
    const cay = await dungTab({ choPhepSua: false, choPhepTruThe: true }, MOC_M);

    expect(m.docMocM).not.toHaveBeenCalled();
    expect(m.theFindMany).not.toHaveBeenCalled();
    const props = timProps(cay, "KhoanChiDinhKySection");
    expect(props?.mocNoPhaiTra ?? null).toBeNull();
    render(<KhoanChiDinhKySection {...(props as React.ComponentProps<typeof KhoanChiDinhKySection>)} />);
    expect(screen.queryByRole("button", { name: "Bật lại" })).toBeNull();
  });
});
