// @vitest-environment jsdom
/**
 * Tab Dòng tiền → khối "Nhập quỹ / rút quỹ (ghi tay)": 4 loại nợ phải trả chỉ hiện trong ô "Loại khoản"
 * khi page truyền `noPhaiTra` (đã bật + người xem có `tai-chinh-so-quy:sua`). Đi trọn đường thật
 * `CashFlowTab` → `CashMovementSection` → nút "+ Nhập quỹ" → form, để bắt chỗ quên nối prop ở giữa.
 *
 * Ô chọn thật (Base UI) chỉ dựng danh sách khi mở popup — thay bằng bản tĩnh để đọc thẳng các mục.
 */
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: () => {}, replace: () => {}, push: () => {} }),
}));
vi.mock("@/lib/actions/cash-movements", () => ({
  createCashMovement: vi.fn(),
  updateCashMovement: vi.fn(),
  deleteCashMovement: vi.fn(),
  suaDieuChinhChuyenDoi: vi.fn(),
}));
vi.mock("@/components/finance/shopee-import-button", () => ({ ShopeeImportButton: () => null }));
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

import { CashFlowTab, type NhomDongTien } from "@/components/finance/cash-flow-tab";
import type { LuaChonDongTienNo } from "@/lib/no-phai-tra/lua-chon-dong-tien-no";
import type { CashFlow } from "@/lib/reports/cash-flow";

const NHAN_NO = ["Trả thẻ tín dụng", "Trả tiền hàng", "NCC hoàn tiền", "Nạp ví quảng cáo"];

const FLOW: CashFlow = {
  expectedIn: 0,
  pendingIn: 0,
  pendingCount: 0,
  cashOut: 0,
  otherIn: 0,
  otherOut: 0,
  otherByKind: [],
  thuNhapTaiChinh: 0,
  balance: 0,
  outBreakdown: [],
  actualIn: { tiktok: null, shopee: null },
};

const LUA_CHON: LuaChonDongTienNo = {
  mocM: new Date("2026-11-01T00:00:00+07:00"),
  the: [{ id: "the-1", ten: "Thẻ VCB", dong: false }],
  phieu: [],
  vi: [],
};

function dongTien(noPhaiTra: LuaChonDongTienNo | null): NhomDongTien {
  return {
    flow: FLOW,
    movements: [],
    viTiktok: null,
    choPhepSua: true,
    choPhepSuaDongSoQuy: true,
    hienLaiTietKiem: true,
    noPhaiTra,
    choPhepSuaDieuChinh: false,
    daBatNoPhaiTra: noPhaiTra !== null,
  };
}

/** Nhãn mọi mục trong ô "Loại khoản" của form vừa mở. */
function moFormLayNhanLoai(noPhaiTra: LuaChonDongTienNo | null): string[] {
  render(<CashFlowTab dongTien={dongTien(noPhaiTra)} quy={null} isCurrentMonth={false} />);
  const khoi = document.getElementById("ghi-tay");
  expect(khoi).not.toBeNull();
  fireEvent.click(within(khoi as HTMLElement).getByRole("button", { name: "+ Nhập quỹ" }));
  return screen.getAllByRole("option").map((o) => o.textContent ?? "");
}

afterEach(cleanup);

describe("tab Dòng tiền — loại nợ phải trả ở form ghi tay theo trạng thái bật", () => {
  it("đã bật (page truyền noPhaiTra) ⇒ có đủ Trả thẻ / Trả tiền hàng / NCC hoàn tiền / Nạp ví quảng cáo", () => {
    const nhan = moFormLayNhanLoai(LUA_CHON);
    for (const n of NHAN_NO) expect(nhan).toContain(n);
    // Điều chỉnh mở sổ chỉ do bước bật tạo — không bao giờ mời chọn.
    expect(nhan.some((n) => n.startsWith("Điều chỉnh mở sổ"))).toBe(false);
  });

  it("chưa bật (noPhaiTra null) ⇒ không loại nợ nào, loại cũ vẫn đủ", () => {
    const nhan = moFormLayNhanLoai(null);
    expect(nhan).toContain("Góp vốn / nhập quỹ");
    for (const n of NHAN_NO) expect(nhan).not.toContain(n);
  });
});
