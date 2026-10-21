// @vitest-environment jsdom
/**
 * Lối "Sửa số tiền (trước ngày bật)" trên Sổ chi phí:
 *  - nút ở dòng chỉ hiện khi: chủ shop + đã bật (có M) + dòng ngày VN < M + đủ tư cách (không Nhập hàng / ADS_API /
 *    lãi vay / thẻ); nhân sự, chưa bật, dòng từ M trở đi ⇒ không có nút;
 *  - modal gửi đúng payload (số mới, số đang hiện làm `amountCuDaThay`, lý do đã trim), lỗi hiện theo `field`,
 *    toast thành công nêu có/không ghi bù + số bù.
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { suaSoTienTruocMoc, toast } = vi.hoisted(() => ({
  suaSoTienTruocMoc: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn() },
}));
const refresh = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh, replace: () => {}, push: () => {} }),
  usePathname: () => "/tai-chinh",
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("sonner", () => ({ toast }));
vi.mock("@/lib/actions/sua-tien-truoc-moc", () => ({ suaSoTienTruocMoc }));
vi.mock("@/lib/actions/expenses", () => ({
  createExpense: vi.fn(),
  updateExpense: vi.fn(),
  stopRecurring: vi.fn(),
  deleteExpense: vi.fn(),
}));

import { ExpenseTable } from "@/components/expenses/expense-table";
import { cauThanhCongSuaTien, SuaTienTruocMocModal } from "@/components/expenses/sua-tien-truoc-moc-modal";
import type { ExpenseRow } from "@/lib/expenses/expense-queries";

const vn = (ngay: string) => new Date(`${ngay}T00:00:00+07:00`);
const MOC_M = vn("2026-10-01");
const NHAN_NUT = "Sửa số tiền (trước ngày bật)";

function dong(o: Partial<ExpenseRow> = {}): ExpenseRow {
  return {
    id: "e1",
    date: vn("2026-09-15"),
    categoryId: "shipping",
    categoryName: "Ship",
    categoryIsHidden: false,
    adsSource: null,
    description: "Phí ship tháng 9",
    channelId: null,
    channelName: null,
    channelColor: null,
    amount: 8_000_000,
    source: "MANUAL",
    recurringId: null,
    refId: null,
    cardId: null,
    tenThe: null,
    ...o,
  };
}

function bang(rows: ExpenseRow[], o: { mocM?: Date | null; laChuShop?: boolean; choPhepSua?: boolean } = {}) {
  render(
    <ExpenseTable
      rows={rows}
      count={rows.length}
      totalAmount={rows.reduce((t, r) => t + r.amount, 0)}
      categories={[{ id: "shipping", name: "Ship" }]}
      channels={[]}
      choPhepSua={o.choPhepSua ?? true}
      mocM={o.mocM === undefined ? MOC_M : o.mocM}
      laChuShop={o.laChuShop ?? true}
    />,
  );
}

// Bảng render cả bố cục desktop lẫn mobile ⇒ mỗi dòng có hai nút cùng tên.
const nut = () => screen.queryAllByRole("button", { name: NHAN_NUT });

beforeEach(() => {
  suaSoTienTruocMoc.mockReset().mockResolvedValue({ ok: true, data: { coBu: false } });
  refresh.mockReset();
  Object.values(toast).forEach((f) => f.mockReset());
});
afterEach(cleanup);

describe("nút 'Sửa số tiền (trước ngày bật)' trên bảng", () => {
  it("chủ shop + đã bật + dòng ngày < M đủ tư cách ⇒ có nút", () => {
    bang([dong()]);
    expect(nut().length).toBeGreaterThan(0);
  });

  it("ngày 30/09 23:59 giờ VN vẫn < M (01/10) ⇒ có nút; đúng ngày M ⇒ không", () => {
    bang([dong({ id: "a", date: new Date("2026-09-30T23:59:00+07:00") })]);
    expect(nut().length).toBeGreaterThan(0);
    cleanup();
    bang([dong({ id: "b", date: vn("2026-10-01") })]);
    expect(nut()).toHaveLength(0);
  });

  it("dòng từ M trở đi ⇒ không nút, nhưng nút Sửa/Xóa thường vẫn còn", () => {
    bang([dong({ date: vn("2026-10-05") })]);
    expect(nut()).toHaveLength(0);
    expect(screen.getAllByRole("button", { name: "Sửa" }).length).toBeGreaterThan(0);
    expect(screen.getAllByRole("button", { name: "Xóa" }).length).toBeGreaterThan(0);
  });

  it("nhân sự (không phải chủ shop) ⇒ không nút dù dòng < M; Sửa thường không đổi", () => {
    bang([dong()], { laChuShop: false });
    expect(nut()).toHaveLength(0);
    expect(screen.getAllByRole("button", { name: "Sửa" }).length).toBeGreaterThan(0);
  });

  it("chưa bật theo dõi nợ (mocM null) ⇒ không nút", () => {
    bang([dong()], { mocM: null });
    expect(nut()).toHaveLength(0);
  });

  it("không có quyền sửa chi phí ⇒ không nút", () => {
    bang([dong()], { choPhepSua: false });
    expect(nut()).toHaveLength(0);
  });

  it.each([
    ["Nhập hàng (purchase)", { categoryId: "purchase", categoryName: "Nhập hàng" }],
    ["refId phiếu nhập Pancake dù đã đổi danh mục", { refId: "PANCAKE_PURCHASE:123" }],
    ["ads tự động ADS_API", { source: "ADS_API", categoryId: "ads", categoryName: "Quảng cáo" }],
    ["lãi vay sinh cùng kỳ trả nợ", { refId: "LOAN:l1:2026-09-15" }],
    ["khoản chi gắn thẻ", { cardId: "c1", tenThe: "Visa" }],
  ] as [string, Partial<ExpenseRow>][])("không đủ tư cách — %s ⇒ không nút", (_ten, o) => {
    bang([dong(o)]);
    expect(nut()).toHaveLength(0);
  });

  it("dòng định kỳ / import (ngày < M) vẫn được sửa", () => {
    bang([dong({ id: "r", source: "RECURRING", recurringId: "m1" }), dong({ id: "i", source: "IMPORT" })]);
    expect(nut().length).toBe(4); // 2 dòng × (desktop + mobile)
  });

  it("bấm nút ⇒ mở modal đúng dòng (ngày, danh mục, mô tả, số hiện tại)", () => {
    bang([dong()]);
    fireEvent.click(nut()[0]!);
    const khung = screen.getByTestId("sua-tien-thong-tin-dong");
    expect(khung.textContent).toContain("15/09/2026");
    expect(khung.textContent).toContain("Ship");
    expect(khung.textContent).toContain("Phí ship tháng 9");
    expect(screen.getByTestId("sua-tien-so-hien-tai").textContent).toBe("8.000.000 ₫");
  });
});

function moModal(row: ExpenseRow = dong()) {
  render(<SuaTienTruocMocModal open onOpenChange={() => {}} expense={row} mocM={MOC_M} />);
}
const oSoTien = () => screen.getByLabelText("Số tiền mới") as HTMLInputElement;
const oLyDo = () => screen.getByLabelText("Lý do sửa") as HTMLInputElement;
const nutLuu = () => screen.getByRole("button", { name: "Lưu" }) as HTMLButtonElement;

describe("SuaTienTruocMocModal", () => {
  it("nói rõ điều chỉnh mở sổ chỉ khi dòng nằm trong sổ quỹ", () => {
    moModal();
    const cau = screen.getByTestId("sua-tien-giai-thich").textContent ?? "";
    expect(cau).toContain("Nếu dòng này nằm trong sổ quỹ");
    expect(cau).toContain("dòng điều chỉnh mở sổ đúng bằng chênh lệch");
    expect(cau).toContain("chỉ Lãi/Lỗ tháng cũ thay đổi");
  });

  it("chưa đổi số hoặc chưa ghi lý do ⇒ khoá nút Lưu", () => {
    moModal();
    expect(oSoTien().value).toBe("8.000.000"); // điền sẵn số hiện tại
    expect(nutLuu().disabled).toBe(true);
    fireEvent.change(oSoTien(), { target: { value: "9000000" } });
    expect(nutLuu().disabled).toBe(true); // thiếu lý do
    fireEvent.change(oLyDo(), { target: { value: "   " } });
    expect(nutLuu().disabled).toBe(true); // lý do toàn khoảng trắng
    fireEvent.change(oLyDo(), { target: { value: "khai nhầm" } });
    expect(nutLuu().disabled).toBe(false);
    fireEvent.change(oSoTien(), { target: { value: "8000000" } }); // trở lại số cũ
    expect(nutLuu().disabled).toBe(true);
  });

  it("gửi đúng payload: số mới, số đang hiện làm amountCuDaThay, lý do đã trim; đóng + làm mới khi thành công", async () => {
    const dongModal = vi.fn();
    render(<SuaTienTruocMocModal open onOpenChange={dongModal} expense={dong()} mocM={MOC_M} />);
    fireEvent.change(oSoTien(), { target: { value: "9.000.000" } });
    fireEvent.change(oLyDo(), { target: { value: "  khai nhầm số  " } });
    fireEvent.click(nutLuu());
    await waitFor(() => expect(suaSoTienTruocMoc).toHaveBeenCalledTimes(1));
    expect(suaSoTienTruocMoc).toHaveBeenCalledWith("e1", {
      amountMoi: 9_000_000,
      amountCuDaThay: 8_000_000,
      lyDo: "khai nhầm số",
    });
    await waitFor(() => expect(dongModal).toHaveBeenCalledWith(false));
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("thành công CÓ bù (vào) ⇒ toast nêu chiều, số bù, ngày M", async () => {
    suaSoTienTruocMoc.mockResolvedValue({ ok: true, data: { coBu: true, chieu: "IN", soTienBu: 1_000_000 } });
    moModal();
    fireEvent.change(oSoTien(), { target: { value: "9000000" } });
    fireEvent.change(oLyDo(), { target: { value: "x" } });
    fireEvent.click(nutLuu());
    await waitFor(() => expect(toast.success).toHaveBeenCalledTimes(1));
    const cau = toast.success.mock.calls[0]![0] as string;
    expect(cau).toContain("điều chỉnh mở sổ vào 1.000.000 ₫");
    expect(cau).toContain("ngày 01/10");
  });

  it("thành công CÓ bù (ra) và KHÔNG bù — hai câu khác nhau", () => {
    expect(cauThanhCongSuaTien({ coBu: true, chieu: "OUT", soTienBu: 1_500_000 }, MOC_M)).toContain(
      "điều chỉnh mở sổ ra 1.500.000 ₫",
    );
    const khongBu = cauThanhCongSuaTien({ coBu: false }, MOC_M);
    expect(khongBu).toContain("không ghi điều chỉnh");
    expect(khongBu).toContain("chỉ Lãi/Lỗ đổi");
    expect(khongBu).not.toContain("₫");
  });

  it("thành công KHÔNG bù ⇒ toast 'không ghi điều chỉnh', vẫn đóng + làm mới", async () => {
    moModal();
    fireEvent.change(oSoTien(), { target: { value: "7000000" } });
    fireEvent.change(oLyDo(), { target: { value: "x" } });
    fireEvent.click(nutLuu());
    await waitFor(() => expect(toast.success).toHaveBeenCalledTimes(1));
    expect(toast.success.mock.calls[0]![0]).toContain("không ghi điều chỉnh");
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["amountMoi", "Số tiền quá lớn (tối đa 2 tỷ)"],
    ["lyDo", "Lý do tối đa 120 ký tự"],
  ])("lỗi field %s ⇒ hiện ngay dưới ô, không toast, không đóng", async (field, error) => {
    suaSoTienTruocMoc.mockResolvedValue({ ok: false, error, field });
    const dongModal = vi.fn();
    render(<SuaTienTruocMocModal open onOpenChange={dongModal} expense={dong()} mocM={MOC_M} />);
    fireEvent.change(oSoTien(), { target: { value: "9000000" } });
    fireEvent.change(oLyDo(), { target: { value: "x" } });
    fireEvent.click(nutLuu());
    const loi = await screen.findByText(error);
    const oDung = field === "amountMoi" ? oSoTien() : oLyDo();
    expect(oDung.closest("div.flex.flex-col")?.contains(loi)).toBe(true); // lỗi nằm trong khối của đúng ô
    expect(toast.error).not.toHaveBeenCalled();
    expect(dongModal).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
  });

  it("lỗi amountCuDaThay (tab cũ) ⇒ hiện câu lỗi trong modal", async () => {
    suaSoTienTruocMoc.mockResolvedValue({ ok: false, error: "Số tiền cũ không hợp lệ", field: "amountCuDaThay" });
    moModal();
    fireEvent.change(oSoTien(), { target: { value: "9000000" } });
    fireEvent.change(oLyDo(), { target: { value: "x" } });
    fireEvent.click(nutLuu());
    expect(await screen.findByText("Số tiền cũ không hợp lệ")).toBeTruthy();
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("lỗi không gắn field (vd vừa được sửa ở nơi khác) ⇒ toast lỗi, modal giữ nguyên", async () => {
    const cau = "Khoản chi vừa được sửa ở nơi khác — tải lại trang rồi sửa lại.";
    suaSoTienTruocMoc.mockResolvedValue({ ok: false, error: cau, code: "SO_TIEN_DA_DOI" });
    const dongModal = vi.fn();
    render(<SuaTienTruocMocModal open onOpenChange={dongModal} expense={dong()} mocM={MOC_M} />);
    fireEvent.change(oSoTien(), { target: { value: "9000000" } });
    fireEvent.change(oLyDo(), { target: { value: "x" } });
    fireEvent.click(nutLuu());
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(cau));
    expect(dongModal).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
  });

  it("action ném (mất mạng) ⇒ toast lỗi chung, nút Lưu mở lại", async () => {
    suaSoTienTruocMoc.mockRejectedValue(new Error("network"));
    moModal();
    fireEvent.change(oSoTien(), { target: { value: "9000000" } });
    fireEvent.change(oLyDo(), { target: { value: "x" } });
    fireEvent.click(nutLuu());
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Lưu thất bại — kiểm tra kết nối"));
    expect(nutLuu().disabled).toBe(false);
  });
});
