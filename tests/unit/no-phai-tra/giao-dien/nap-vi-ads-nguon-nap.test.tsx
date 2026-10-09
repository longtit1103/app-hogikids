// @vitest-environment jsdom
/**
 * Form "Nạp ví quảng cáo" (`ADS_TOPUP`): ô nguồn nạp có mục đầu "Nạp từ ngân hàng (không qua thẻ)" =
 * `cardId` null. Trước đây ô thẻ là Select thường — đã chọn thẻ thì không bỏ chọn được, tức dòng nạp
 * từ ngân hàng (RA khỏi quỹ) bị kẹt thành nạp bằng thẻ (không chạm quỹ). Ở đây Select được thay bằng bản
 * tĩnh CÓ bấm chọn được (ngữ cảnh value/onValueChange) để đi đúng đường người dùng bấm.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { addDays } from "date-fns";
import { createContext, useContext, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

const hanhDong = vi.hoisted(() => ({ createCashMovement: vi.fn(), updateCashMovement: vi.fn() }));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: () => {}, replace: () => {}, push: () => {} }),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/actions/cash-movements", () => ({ ...hanhDong, suaDieuChinhChuyenDoi: vi.fn() }));
vi.mock("@/components/ui/select", () => {
  type Ctx = { value: string; onValueChange: (v: string) => void };
  const SelectCtx = createContext<Ctx>({ value: "", onValueChange: () => {} });
  const Bo = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  return {
    Select: ({ value, onValueChange, children }: Ctx & { children?: ReactNode }) => (
      <div role="listbox">
        <SelectCtx.Provider value={{ value, onValueChange }}>{children}</SelectCtx.Provider>
      </div>
    ),
    SelectContent: Bo,
    SelectGroup: Bo,
    SelectLabel: Bo,
    SelectTrigger: Bo,
    SelectValue: () => null,
    SelectItem: function Muc({ value, children }: { value: string; children?: ReactNode }) {
      const ctx = useContext(SelectCtx);
      return (
        <div role="option" aria-selected={ctx.value === value} data-value={value} onClick={() => ctx.onValueChange(value)}>
          {children}
        </div>
      );
    },
  };
});

import { CashMovementFormModal } from "@/components/finance/cash-movement-form-modal";
import type { CashMovementRow } from "@/lib/cash-movements/cash-movement-queries";
import type { LuaChonDongTienNo } from "@/lib/no-phai-tra/lua-chon-dong-tien-no";

const BANK = "Nạp từ ngân hàng (không qua thẻ)";
const homNay = new Date();
const NO: LuaChonDongTienNo = {
  mocM: addDays(homNay, -10),
  the: [{ id: "the-1", ten: "Thẻ VCB", dong: false }],
  phieu: [],
  vi: [{ id: "vi-1", nenTang: "SHOPEE_ADS" }],
};

const dongNap = (cardId: string | null): CashMovementRow => ({
  id: "cm-1",
  date: addDays(homNay, -2),
  kind: "ADS_TOPUP",
  amount: 500_000,
  description: "Nạp ví Shopee Ads",
  loanId: null,
  loanName: null,
  savingsId: null,
  savingsName: null,
  cardId,
  phieuNhapId: null,
  viAdsId: "vi-1",
  tenHoSoNo: null,
});

function mo(row?: CashMovementRow) {
  render(
    <CashMovementFormModal open onOpenChange={() => {}} row={row} loans={[]} soTietKiem={[]} d0={null} choPhepLoaiSoQuy noPhaiTra={NO} />,
  );
}

/** Ô "Nguồn nạp" — listbox chứa mục ngân hàng. */
function oNguonNap(): HTMLElement {
  const muc = screen.getByRole("option", { name: BANK });
  return muc.closest('[role="listbox"]') as HTMLElement;
}
const daChon = (o: HTMLElement) =>
  within(o)
    .getAllByRole("option")
    .filter((m) => m.getAttribute("aria-selected") === "true")
    .map((m) => m.textContent);

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("Nạp ví quảng cáo — nguồn nạp ngân hàng / thẻ", () => {
  it("tạo mới, chọn loại Nạp ví ⇒ mặc định 'Nạp từ ngân hàng', có thẻ để chọn", () => {
    mo();
    fireEvent.click(screen.getByRole("option", { name: "Nạp ví quảng cáo" }));
    const o = oNguonNap();
    expect(daChon(o)).toEqual([BANK]);
    expect(within(o).getByRole("option", { name: "Thẻ VCB" })).toBeTruthy();
  });

  it("chọn thẻ rồi bỏ chọn về ngân hàng được", () => {
    mo();
    fireEvent.click(screen.getByRole("option", { name: "Nạp ví quảng cáo" }));
    fireEvent.click(within(oNguonNap()).getByRole("option", { name: "Thẻ VCB" }));
    expect(daChon(oNguonNap())).toEqual(["Thẻ VCB"]);
    fireEvent.click(within(oNguonNap()).getByRole("option", { name: BANK }));
    expect(daChon(oNguonNap())).toEqual([BANK]);
  });

  it("sửa dòng nạp bằng thẻ ⇒ điền sẵn thẻ; đổi sang ngân hàng rồi Lưu ⇒ gửi cardId null", async () => {
    hanhDong.updateCashMovement.mockResolvedValue({ ok: true, data: undefined });
    mo(dongNap("the-1"));
    expect(daChon(oNguonNap())).toEqual(["Thẻ VCB"]);
    fireEvent.click(within(oNguonNap()).getByRole("option", { name: BANK }));
    fireEvent.click(screen.getByRole("button", { name: "Lưu" }));
    await waitFor(() => expect(hanhDong.updateCashMovement).toHaveBeenCalledTimes(1));
    expect(hanhDong.updateCashMovement.mock.calls[0][1]).toMatchObject({ kind: "ADS_TOPUP", cardId: null, viAdsId: "vi-1" });
  });

  it("Trả thẻ tín dụng: thẻ BẮT BUỘC ⇒ không có mục ngân hàng", () => {
    mo();
    fireEvent.click(screen.getByRole("option", { name: "Trả thẻ tín dụng" }));
    expect(screen.queryByRole("option", { name: BANK })).toBeNull();
    expect(screen.getByRole("option", { name: "Thẻ VCB" })).toBeTruthy();
  });
});
