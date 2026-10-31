// @vitest-environment jsdom
/**
 * Form ghi tay phải đọc/điền NGÀY theo giờ Việt Nam, không theo múi giờ trình duyệt.
 *
 * Ngày trong DB là một thời điểm tuyệt đối (0h VN của ngày đó). Máy đặt múi giờ Tây (laptop mở khi đi
 * nước ngoài) mà form đổi nó sang `yyyy-MM-dd` bằng giờ MÁY thì lùi một ngày: chỉ sửa mô tả rồi bấm
 * Lưu cũng dời khoản tiền sang hôm trước. Test chạy từng form ở hai múi giờ và so ngày GỬI ĐI với
 * ngày gốc; thêm mới thì ô ngày phải mặc định là "hôm nay" theo giờ VN.
 *
 * Node đọc lại `process.env.TZ` mỗi lần gán, nên đổi giữa test là đổi múi giờ thật của `Date`/date-fns.
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const hanhDong = vi.hoisted(() => ({
  updateExpense: vi.fn(),
  createExpense: vi.fn(),
  updateCashMovement: vi.fn(),
  createCashMovement: vi.fn(),
  suaSoTietKiem: vi.fn(),
  taoSoTietKiem: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: () => {}, replace: () => {}, push: () => {} }),
}));
vi.mock("sonner", () => ({ toast: { success: () => {}, error: () => {}, info: () => {} } }));
vi.mock("@/lib/actions/expenses", () => ({
  createExpense: hanhDong.createExpense,
  updateExpense: hanhDong.updateExpense,
  stopRecurring: vi.fn(),
}));
vi.mock("@/lib/actions/cash-movements", () => ({
  createCashMovement: hanhDong.createCashMovement,
  updateCashMovement: hanhDong.updateCashMovement,
  suaDieuChinhChuyenDoi: vi.fn(),
}));
vi.mock("@/lib/actions/so-tiet-kiem", () => ({
  suaSoTietKiem: hanhDong.suaSoTietKiem,
  taoSoTietKiem: hanhDong.taoSoTietKiem,
}));
vi.mock("@/lib/actions/tra-tien-hang", () => ({ traTienHangGop: vi.fn() }));
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
import { CashMovementFormModal } from "@/components/finance/cash-movement-form-modal";
import { SoTietKiemFormModal } from "@/components/finance/so-tiet-kiem-form-modal";
import { TraTienHangFormModal } from "@/components/no-phai-tra/tra-tien-hang-form-modal";
import type { ExpenseRow } from "@/lib/expenses/expense-queries";
import type { CashMovementRow } from "@/lib/cash-movements/cash-movement-queries";
import type { SoTietKiemRow } from "@/lib/tiet-kiem/so-tiet-kiem-queries";

const TZ_GOC = process.env.TZ;
const MUI_GIO = ["America/New_York", "Asia/Ho_Chi_Minh", "Pacific/Honolulu"] as const;

/** Ngày gốc 15/10/2026 (0h giờ VN) — bị lùi về 14/10 nếu đọc bằng giờ New York/Honolulu. */
const NGAY_GOC = new Date("2026-10-15T00:00:00+07:00");

/** Thời điểm mà ngày VN (16/10) KHÁC ngày New York (15/10): 20:00Z = 03:00 VN = 16:00 NY. */
const THOI_DIEM_LECH_NGAY = new Date("2026-10-15T20:00:00Z");

beforeEach(() => {
  for (const f of Object.values(hanhDong)) f.mockReset().mockResolvedValue({ ok: true });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  process.env.TZ = TZ_GOC;
});

function oNgay(): HTMLInputElement {
  const o = document.querySelector('input[type="date"]');
  if (!o) throw new Error("không thấy ô ngày");
  return o as HTMLInputElement;
}

function bamLuu() {
  fireEvent.click(screen.getByRole("button", { name: /^Lưu$/ }));
}

const dongChiPhi = {
  id: "e1",
  date: NGAY_GOC,
  categoryId: "shipping",
  categoryName: "Ship",
  categoryIsHidden: false,
  adsSource: null,
  description: "mô tả cũ",
  channelId: null,
  channelName: null,
  channelColor: null,
  amount: 100_000,
  source: "MANUAL",
  recurringId: null,
  refId: null,
  cardId: null,
  tenThe: null,
} as ExpenseRow;

const dongTien = {
  id: "c1",
  date: NGAY_GOC,
  kind: "OTHER_IN",
  amount: 500_000,
  description: "mô tả cũ",
  loanId: null,
  loanName: null,
  savingsId: null,
  savingsName: null,
  cardId: null,
  phieuNhapId: null,
  viAdsId: null,
  tenHoSoNo: null,
} as unknown as CashMovementRow;

const soTietKiem = {
  id: "s1",
  name: "Sổ A",
  bank: "TCB",
  principal: 10_000_000,
  startDate: NGAY_GOC,
  termMonths: 6,
  maturityDate: new Date("2027-04-15T00:00:00+07:00"),
  annualRateBp: 520,
  closedAt: null,
  note: "",
  loan: null,
} as unknown as SoTietKiemRow;

describe.each(MUI_GIO)("sửa dòng cũ, chỉ đổi mô tả — múi giờ trình duyệt %s", (tz) => {
  beforeEach(() => {
    process.env.TZ = tz;
  });

  it("chi phí: ngày gửi đi vẫn là 0h VN của ngày gốc", async () => {
    render(
      <ExpenseFormModal
        open
        onOpenChange={() => {}}
        categories={[{ id: "shipping", name: "Ship" }]}
        channels={[]}
        expense={dongChiPhi}
      />,
    );
    expect(oNgay().value).toBe("2026-10-15");
    fireEvent.change(screen.getByDisplayValue("mô tả cũ"), { target: { value: "mô tả mới" } });
    bamLuu();
    await waitFor(() => expect(hanhDong.updateExpense).toHaveBeenCalledTimes(1));
    const [, input] = hanhDong.updateExpense.mock.calls[0] as [string, { date: Date; description: string }];
    expect(input.description).toBe("mô tả mới");
    expect(input.date.getTime()).toBe(NGAY_GOC.getTime());
  });

  it("dòng tiền: ngày gửi đi vẫn là 0h VN của ngày gốc", async () => {
    render(
      <CashMovementFormModal
        open
        onOpenChange={() => {}}
        loans={[]}
        soTietKiem={[]}
        d0={null}
        choPhepLoaiSoQuy
        row={dongTien}
      />,
    );
    expect(oNgay().value).toBe("2026-10-15");
    fireEvent.change(screen.getByDisplayValue("mô tả cũ"), { target: { value: "mô tả mới" } });
    bamLuu();
    await waitFor(() => expect(hanhDong.updateCashMovement).toHaveBeenCalledTimes(1));
    const [, input] = hanhDong.updateCashMovement.mock.calls[0] as [string, { date: Date }];
    expect(input.date.getTime()).toBe(NGAY_GOC.getTime());
  });

  it("sổ tiết kiệm: ngày gửi và ngày đáo hạn gửi đi không đổi", async () => {
    render(<SoTietKiemFormModal open onOpenChange={() => {}} so={soTietKiem} loans={[]} d0={null} />);
    expect(oNgay().value).toBe("2026-10-15");
    fireEvent.change(screen.getByDisplayValue("Sổ A"), { target: { value: "Sổ A (đổi tên)" } });
    bamLuu();
    await waitFor(() => expect(hanhDong.suaSoTietKiem).toHaveBeenCalledTimes(1));
    const [input] = hanhDong.suaSoTietKiem.mock.calls[0] as [{ startDate: Date; maturityDate: Date }];
    expect(input.startDate.getTime()).toBe(NGAY_GOC.getTime());
    expect(input.maturityDate.getTime()).toBe(soTietKiem.maturityDate.getTime());
  });
});

describe.each(MUI_GIO)("thêm mới — ô ngày mặc định là hôm nay theo giờ VN, trình duyệt ở %s", (tz) => {
  beforeEach(() => {
    process.env.TZ = tz;
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(THOI_DIEM_LECH_NGAY);
  });

  it("chi phí", () => {
    render(<ExpenseFormModal open onOpenChange={() => {}} categories={[]} channels={[]} />);
    expect(oNgay().value).toBe("2026-10-16");
  });

  it("dòng tiền", () => {
    render(<CashMovementFormModal open onOpenChange={() => {}} loans={[]} soTietKiem={[]} d0={null} choPhepLoaiSoQuy />);
    expect(oNgay().value).toBe("2026-10-16");
  });

  it("sổ tiết kiệm", () => {
    render(<SoTietKiemFormModal open onOpenChange={() => {}} loans={[]} d0={null} />);
    expect(oNgay().value).toBe("2026-10-16");
  });

  it("trả tiền hàng nhà cung cấp", () => {
    render(<TraTienHangFormModal open onOpenChange={() => {}} phieu={[]} vanTay="x" mocM="2026-10-01" />);
    expect(oNgay().value).toBe("2026-10-16");
  });
});
