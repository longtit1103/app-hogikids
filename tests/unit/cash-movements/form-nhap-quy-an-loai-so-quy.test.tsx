// @vitest-environment jsdom
/**
 * Form "+ Nhập quỹ / Sửa khoản tiền": người thiếu `tai-chinh-so-quy:sua` KHÔNG thấy các loại gắn khoản
 * vay / sổ tiết kiệm trong ô "Loại khoản" — server vẫn chặn (`kiemQuyenDongGanSoQuy`), đây là để form
 * không mời chọn một loại chắc chắn bị từ chối. Danh sách loại lấy từ CÙNG `kindGanSoQuy` mà action dùng.
 *
 * Ô chọn thật (Base UI) chỉ dựng danh sách khi mở popup — thay bằng bản tĩnh để đọc thẳng các mục.
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: () => {}, replace: () => {}, push: () => {} }),
}));
vi.mock("@/lib/actions/cash-movements", () => ({
  createCashMovement: vi.fn(),
  updateCashMovement: vi.fn(),
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

import { CashMovementAddButton } from "@/components/finance/cash-movement-add-button";
import { CashMovementFormModal } from "@/components/finance/cash-movement-form-modal";
import { CashMovementSection } from "@/components/finance/cash-movement-section";
import { CashMovementTable } from "@/components/finance/cash-movement-table";
import { CASH_MOVEMENT_KINDS, kindGanSoQuy } from "@/lib/cash-movements/cash-movement-kinds";

const LOAI_TRON = CASH_MOVEMENT_KINDS.filter((k) => !kindGanSoQuy(k));
const LOAI_SO_QUY = CASH_MOVEMENT_KINDS.filter((k) => kindGanSoQuy(k));

function loaiHien(): string[] {
  return screen.getAllByRole("option").map((o) => o.getAttribute("data-value") ?? "");
}

function moForm(choPhepLoaiSoQuy: boolean) {
  render(
    <CashMovementFormModal
      open
      onOpenChange={() => {}}
      loans={[]}
      soTietKiem={[]}
      d0={null}
      choPhepLoaiSoQuy={choPhepLoaiSoQuy}
    />,
  );
}

afterEach(cleanup);

describe("CashMovementFormModal — loại khoản theo quyền Sổ quỹ", () => {
  it("đối chứng: có cả loại trơn lẫn loại gắn khoản vay/sổ tiết kiệm", () => {
    expect(LOAI_TRON.length).toBeGreaterThan(0);
    expect(LOAI_SO_QUY).toEqual(expect.arrayContaining(["LOAN_IN", "LOAN_REPAY", "DEPOSIT_IN", "DEPOSIT_OUT", "SAVINGS_IN", "SAVINGS_OUT"]));
  });

  it("thiếu so-quy:sua ⇒ chỉ loại trơn", () => {
    moForm(false);
    expect(loaiHien().sort()).toEqual([...LOAI_TRON].sort());
  });

  it("có so-quy:sua ⇒ đủ mọi loại", () => {
    moForm(true);
    expect(loaiHien().sort()).toEqual([...CASH_MOVEMENT_KINDS].sort());
  });
});

describe("cờ đi từ server tới form", () => {
  const goc = { inTotal: 0, outTotal: 0, rows: [], loans: [], soTietKiem: [], d0: null, choPhepSua: true };

  it("khối ghi tay: nút + Nhập quỹ nhận đúng cờ quyền sửa dòng Sổ quỹ", () => {
    for (const co of [false, true]) {
      render(<CashMovementSection {...goc} choPhepSuaDongSoQuy={co} />);
      fireEvent.click(screen.getByRole("button", { name: "+ Nhập quỹ" }));
      expect(loaiHien().some((k) => kindGanSoQuy(k as (typeof CASH_MOVEMENT_KINDS)[number]))).toBe(co);
      cleanup();
    }
  });

  it("bảng: form SỬA dòng trơn của người thiếu so-quy:sua không cho đổi sang loại gắn khoản vay", () => {
    const dong = { id: "cm-1", date: new Date(2026, 8, 1), kind: "CAPITAL_IN" as const, amount: 1_000_000, description: "góp" };
    render(<CashMovementTable rows={[dong]} loans={[]} soTietKiem={[]} d0={null} choPhepSua />);
    fireEvent.click(screen.getAllByRole("button", { name: "Sửa" })[0]);
    expect(loaiHien().sort()).toEqual([...LOAI_TRON].sort());
  });

  it("nút thêm không có cờ ⇒ lỗi kiểu (bắt buộc truyền)", () => {
    // @ts-expect-error — `choPhepLoaiSoQuy` bắt buộc: quên truyền không được rơi về "hiện hết".
    expect(() => <CashMovementAddButton loans={[]} soTietKiem={[]} d0={null} />).not.toThrow();
  });
});
