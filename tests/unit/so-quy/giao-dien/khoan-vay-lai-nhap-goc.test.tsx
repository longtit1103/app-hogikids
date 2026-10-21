// @vitest-environment jsdom
/**
 * Giao diện thấu chi "lãi nhập gốc": ô chọn trong form (chỉ thấu chi, tạo + sửa giữ cờ), thẻ duyệt kỳ
 * (dư nợ sau kỳ = dư nợ + lãi), nhãn ở bảng khoản vay, lịch dự kiến (lãi cộng vào dư nợ) và hộp xoá
 * dòng lãi kỳ. Khoản mẫu: rút 100.000.000 ngày 10/09/2026, 11,75%/năm, thu lãi mùng 1 ⇒ kỳ 01/10 = 676.027.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { taoKhoanVay, suaKhoanVay, ghiKyTraNo, deleteExpense, toast } = vi.hoisted(() => ({
  taoKhoanVay: vi.fn(),
  suaKhoanVay: vi.fn(),
  ghiKyTraNo: vi.fn(),
  deleteExpense: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));
const refresh = vi.fn();

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh, replace: () => {}, push: () => {} }) }));
vi.mock("sonner", () => ({ toast }));
vi.mock("@/lib/actions/khoan-vay", () => ({
  taoKhoanVay,
  suaKhoanVay,
  ghiKyTraNo,
  tatToanKhoanVay: vi.fn(),
  xoaKhoanVay: vi.fn(),
}));
vi.mock("@/lib/actions/expenses", () => ({ deleteExpense }));

import { ExpenseDeleteDialog } from "@/components/expenses/expense-delete-dialog";
import { KhoanVayFormModal } from "@/components/finance/khoan-vay-form-modal";
import { KhoanVayTable } from "@/components/finance/khoan-vay-table";
import { KyTraNoCard } from "@/components/finance/ky-tra-no-card";
import { LichTraNoDuKienCard } from "@/components/finance/lich-tra-no-du-kien-card";
import type { ExpenseRow } from "@/lib/expenses/expense-queries";
import type { KhoanVayRow } from "@/lib/so-quy/khoan-vay-queries";
import { kyChoDuyet } from "@/lib/so-quy/lich-tra-no";

const vn = (ngay: string) => new Date(`${ngay}T00:00:00+07:00`);
const NHAN_O = /Ngân hàng cộng lãi vào dư nợ \(lãi nhập gốc\)/;

beforeEach(() => {
  for (const f of [taoKhoanVay, suaKhoanVay, ghiKyTraNo, deleteExpense, refresh, ...Object.values(toast)]) f.mockReset();
});
afterEach(cleanup);

/** Khoản thấu chi mẫu: chưa duyệt kỳ nào; `nhapGoc` điền khi cần dựng khoản đã có kỳ nhập gốc. */
function khoanThauChi(over: Partial<KhoanVayRow> = {}): KhoanVayRow {
  return {
    id: "tc1",
    kind: "OVERDRAFT",
    name: "Thấu chi TCB",
    lender: "Techcombank",
    duNoMoSo: 0,
    startDate: vn("2026-09-10"),
    annualRateBp: 1175,
    termMonths: null,
    firstDueDate: vn("2026-10-01"),
    lastDueHandled: null,
    closedAt: null,
    note: "",
    laiCoDinhMoiKy: null,
    tienGuiBatBuocMoiKy: 0,
    laiNhapGoc: true,
    giaiNgan: 100_000_000,
    giaiNganNgay: vn("2026-09-10"),
    traGoc: [],
    nhapGoc: [],
    duNo: 100_000_000,
    laiTamTinh: null,
    kyCho: null,
    coTraGoc: false,
    tienGuiDangGiu: 0,
    coDongTienGui: false,
    ngayTatToanSomNhat: vn("2026-09-10"),
    ...over,
  };
}

describe("form khoản vay — ô lãi nhập gốc", () => {
  it("chỉ hiện khi chọn loại thấu chi", () => {
    render(<KhoanVayFormModal open onOpenChange={() => {}} d0={null} />);
    expect(screen.queryByLabelText(NHAN_O)).toBeNull();

    fireEvent.click(screen.getByLabelText(/Thấu chi \(lãi tính theo ngày\)/));
    expect(screen.getByLabelText(NHAN_O)).toBeTruthy();

    fireEvent.click(screen.getByLabelText(/Khoản vay mới/));
    expect(screen.queryByLabelText(NHAN_O)).toBeNull();
  });

  it("tạo thấu chi: tích ô ⇒ payload laiNhapGoc true; không tích ⇒ false", async () => {
    taoKhoanVay.mockResolvedValue({ ok: true, data: {} });
    for (const tich of [true, false]) {
      taoKhoanVay.mockClear();
      render(<KhoanVayFormModal open onOpenChange={() => {}} d0={null} />);
      fireEvent.click(screen.getByLabelText(/Thấu chi \(lãi tính theo ngày\)/));
      fireEvent.change(screen.getByLabelText(/Tên khoản vay/), { target: { value: "Thấu chi TCB" } });
      fireEvent.change(screen.getByLabelText(/Số tiền rút thấu chi/), { target: { value: "100000000" } });
      if (tich) fireEvent.click(screen.getByLabelText(NHAN_O));
      fireEvent.click(screen.getByRole("button", { name: "Lưu" }));
      await waitFor(() => expect(taoKhoanVay).toHaveBeenCalledTimes(1));
      expect(taoKhoanVay.mock.calls[0][0]).toMatchObject({ kind: "OVERDRAFT", laiNhapGoc: tich });
      cleanup();
    }
  });

  it("đã tích rồi đổi sang loại khác ⇒ cờ không bị gửi kèm (server từ chối cờ ở loại khác)", async () => {
    taoKhoanVay.mockResolvedValue({ ok: true, data: {} });
    render(<KhoanVayFormModal open onOpenChange={() => {}} d0={null} />);
    fireEvent.click(screen.getByLabelText(/Thấu chi \(lãi tính theo ngày\)/));
    fireEvent.click(screen.getByLabelText(NHAN_O));
    fireEvent.click(screen.getByLabelText(/Khoản vay mới/));
    fireEvent.change(screen.getByLabelText(/Tên khoản vay/), { target: { value: "Vay người thân" } });
    fireEvent.change(screen.getByLabelText(/Số tiền giải ngân/), { target: { value: "5000000" } });
    fireEvent.change(screen.getByLabelText(/Kỳ hạn/), { target: { value: "6" } });
    fireEvent.click(screen.getByRole("button", { name: "Lưu" }));
    await waitFor(() => expect(taoKhoanVay).toHaveBeenCalledTimes(1));
    expect(taoKhoanVay.mock.calls[0][0]).toMatchObject({ kind: "TERM", laiNhapGoc: false });
  });

  it("sửa khoản đang nhập gốc: ô được tích sẵn và payload GIỮ cờ true", async () => {
    suaKhoanVay.mockResolvedValue({ ok: true, data: {} });
    render(<KhoanVayFormModal open onOpenChange={() => {}} loan={khoanThauChi()} d0={null} />);
    expect((screen.getByLabelText(NHAN_O) as HTMLInputElement).checked).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Lưu" }));
    await waitFor(() => expect(suaKhoanVay).toHaveBeenCalledTimes(1));
    expect(suaKhoanVay.mock.calls[0][0]).toBe("tc1");
    expect(suaKhoanVay.mock.calls[0][1]).toMatchObject({ kind: "OVERDRAFT", laiNhapGoc: true });
  });

  it("sửa khoản thấu chi thường: ô bỏ tích sẵn, đổi tên vẫn gửi false; tích thêm ⇒ true", async () => {
    suaKhoanVay.mockResolvedValue({ ok: true, data: {} });
    render(<KhoanVayFormModal open onOpenChange={() => {}} loan={khoanThauChi({ laiNhapGoc: false })} d0={null} />);
    const o = screen.getByLabelText(NHAN_O) as HTMLInputElement;
    expect(o.checked).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Lưu" }));
    await waitFor(() => expect(suaKhoanVay).toHaveBeenCalledTimes(1));
    expect(suaKhoanVay.mock.calls[0][1]).toMatchObject({ laiNhapGoc: false });

    suaKhoanVay.mockClear();
    fireEvent.click(o);
    fireEvent.click(screen.getByRole("button", { name: "Lưu" }));
    await waitFor(() => expect(suaKhoanVay).toHaveBeenCalledTimes(1));
    expect(suaKhoanVay.mock.calls[0][1]).toMatchObject({ laiNhapGoc: true });
  });

  it("lỗi field laiNhapGoc từ server hiện ngay dưới ô, không toast", async () => {
    taoKhoanVay.mockResolvedValue({ ok: false, field: "laiNhapGoc", error: "Chỉ khoản thấu chi mới chọn được lãi nhập gốc" });
    render(<KhoanVayFormModal open onOpenChange={() => {}} d0={null} />);
    fireEvent.click(screen.getByLabelText(/Thấu chi \(lãi tính theo ngày\)/));
    fireEvent.change(screen.getByLabelText(/Tên khoản vay/), { target: { value: "X" } });
    fireEvent.change(screen.getByLabelText(/Số tiền rút thấu chi/), { target: { value: "1000000" } });
    fireEvent.click(screen.getByRole("button", { name: "Lưu" }));
    expect(await screen.findByText("Chỉ khoản thấu chi mới chọn được lãi nhập gốc")).toBeTruthy();
    expect(toast.error).not.toHaveBeenCalled();
  });
});

describe("thẻ duyệt kỳ lãi", () => {
  const homNay = vn("2026-10-05");

  function theKy(over: Partial<KhoanVayRow>) {
    const row = khoanThauChi(over);
    const ky = kyChoDuyet(row, row.traGoc, row.lastDueHandled, homNay);
    if (ky === null) throw new Error("fixture phải có kỳ chờ duyệt");
    return <KyTraNoCard loan={{ ...row, kyCho: ky }} />;
  }

  it("lãi nhập gốc: câu giải thích, tổng chuyển 0, xác nhận hiện dư nợ sau kỳ = dư nợ + lãi", () => {
    render(theKy({}));
    expect(screen.getByTestId("ky-lai-nhap-goc-cau").textContent).toContain(
      "Lãi cộng vào dư nợ thấu chi — tài khoản không bị trừ"
    );
    expect(screen.getByTestId("ky-lai-nhap-goc-cau").textContent).toMatch(/Tổng chuyển ngân hàng kỳ này: 0 ₫/);

    fireEvent.click(screen.getByRole("button", { name: "Ngân hàng đã cộng lãi — ghi vào sổ" }));
    const xacNhan = screen.getByTestId("ky-xac-nhan-lai-nhap-goc").textContent ?? "";
    expect(xacNhan).toMatch(/Ghi lãi 676\.027 ₫ vào Sổ chi phí/);
    expect(xacNhan).toMatch(/Dư nợ sau kỳ 100\.676\.027 ₫/);
  });

  it("lãi nhập gốc + trả bớt gốc: dư nợ sau = dư nợ − gốc + lãi; tổng chuyển = gốc", () => {
    render(theKy({}));
    fireEvent.change(screen.getByLabelText("Gốc"), { target: { value: "10000000" } });
    expect(screen.getByTestId("ky-lai-nhap-goc-cau").textContent).toMatch(/Tổng chuyển ngân hàng kỳ này: 10\.000\.000 ₫/);
    fireEvent.click(screen.getByRole("button", { name: "Ngân hàng đã cộng lãi — ghi vào sổ" }));
    // 100.000.000 − 10.000.000 + 676.027
    expect(screen.getByTestId("ky-xac-nhan-lai-nhap-goc").textContent).toMatch(/Dư nợ sau kỳ 90\.676\.027 ₫/);
  });

  it("bấm ghi gửi đúng lãi/gốc của kỳ", async () => {
    ghiKyTraNo.mockResolvedValue({ ok: true, data: { duNoConLai: 100_676_027 } });
    render(theKy({}));
    fireEvent.click(screen.getByRole("button", { name: "Ngân hàng đã cộng lãi — ghi vào sổ" }));
    fireEvent.click(screen.getByRole("button", { name: "Ghi vào sổ" }));
    await waitFor(() => expect(ghiKyTraNo).toHaveBeenCalledTimes(1));
    expect(ghiKyTraNo.mock.calls[0][0]).toMatchObject({ loanId: "tc1", lai: 676_027, goc: 0, boQua: false });
  });

  it("khoản thấu chi thường: giữ nguyên câu cũ (dư nợ không cộng lãi, không có câu nhập gốc)", () => {
    render(theKy({ laiNhapGoc: false }));
    expect(screen.queryByTestId("ky-lai-nhap-goc-cau")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Đã chuyển tiền — ghi vào sổ" }));
    expect(screen.queryByTestId("ky-xac-nhan-lai-nhap-goc")).toBeNull();
    expect(document.body.textContent).toMatch(/dư nợ còn 100\.000\.000 ₫/);
  });
});

describe("bảng khoản vay", () => {
  const rows = [
    khoanThauChi({ nhapGoc: [{ ngay: vn("2026-10-01"), soTien: 676_027 }], duNo: 100_676_027 }),
    khoanThauChi({ id: "tc2", name: "Thấu chi khác", laiNhapGoc: false }),
    khoanThauChi({ id: "t3", kind: "TERM", name: "Vay kỳ hạn", laiNhapGoc: false, termMonths: 6 }),
  ];

  it("nhãn 'Lãi nhập gốc' chỉ ở khoản có cờ; dư nợ ghi rõ đã gồm lãi nhập gốc", () => {
    render(<KhoanVayTable rows={rows} d0={null} />);
    // desktop + mobile: mỗi khoản có cờ hiện nhãn đúng 2 lần, khoản khác 0 lần
    expect(screen.getAllByTestId("nhan-lai-nhap-goc")).toHaveLength(2);
    const dong = screen.getAllByTestId("du-no-gom-lai-nhap-goc");
    expect(dong).toHaveLength(2);
    expect(dong[0].textContent).toBe("đã gồm lãi nhập gốc 676.027 ₫");
    expect(document.body.textContent).toContain("100.676.027 ₫");
  });

  it("bật cờ nhưng chưa có kỳ nào nhập gốc ⇒ có nhãn, chưa có dòng 'đã gồm'", () => {
    render(<KhoanVayTable rows={[khoanThauChi()]} d0={null} />);
    expect(screen.getAllByTestId("nhan-lai-nhap-goc").length).toBeGreaterThan(0);
    expect(screen.queryByTestId("du-no-gom-lai-nhap-goc")).toBeNull();
  });
});

describe("lịch trả nợ dự kiến", () => {
  it("khoản nhập gốc: mỗi kỳ ghi lãi cộng vào dư nợ, tiền thật chuyển 0, có câu giải thích", () => {
    render(<LichTraNoDuKienCard loans={[khoanThauChi()]} homNay={vn("2026-10-05")} />);
    expect(screen.getByTestId("lich-du-kien-lai-vao-goc-1").textContent).toBe("cộng vào dư nợ 676.027 ₫");
    expect(screen.getByTestId("lich-du-kien-tong-tc1").textContent).toBe("0 ₫");
    expect(screen.getByTestId("lich-du-kien-giai-thich-nhap-goc-tc1").textContent).toMatch(/không trừ tài khoản/);
    // Dư nợ sau kỳ 1 đã cộng lãi.
    const dongKy1 = within(screen.getByTestId("lich-du-kien-khoan-tc1")).getAllByRole("row")[1];
    expect(dongKy1.textContent).toContain("100.676.027 ₫");
  });

  it("thấu chi thường: không có chú thích lãi vào gốc", () => {
    render(<LichTraNoDuKienCard loans={[khoanThauChi({ laiNhapGoc: false })]} homNay={vn("2026-10-05")} />);
    expect(screen.queryByTestId("lich-du-kien-lai-vao-goc-1")).toBeNull();
    expect(screen.queryByTestId("lich-du-kien-giai-thich-nhap-goc-tc1")).toBeNull();
    // Lãi trả bằng tiền: Σ 6 kỳ khác 0 và dư nợ sau kỳ 1 vẫn 100.000.000.
    expect(screen.getByTestId("lich-du-kien-tong-tc1").textContent).not.toBe("0 ₫");
    const dongKy1 = within(screen.getByTestId("lich-du-kien-khoan-tc1")).getAllByRole("row")[1];
    expect(dongKy1.textContent).toContain("676.027 ₫");
    expect(dongKy1.textContent).toContain("100.000.000 ₫");
  });
});

describe("hộp xoá dòng lãi kỳ", () => {
  function chiPhi(refId: string | null): ExpenseRow {
    return {
      id: "e1",
      date: vn("2026-10-01"),
      categoryId: "c",
      categoryName: "Lãi vay",
      categoryIsHidden: false,
      adsSource: null,
      description: "Lãi thấu chi",
      channelId: null,
      channelName: null,
      channelColor: null,
      amount: 676_027,
      source: "MANUAL",
      recurringId: null,
      refId,
      cardId: null,
      tenThe: null,
    };
  }

  it("dòng lãi do duyệt kỳ sinh: nói sẽ xoá luôn dòng lãi nhập gốc đi kèm", () => {
    render(<ExpenseDeleteDialog open onOpenChange={() => {}} expense={chiPhi("LOAN:tc1:2026-10-01")} />);
    expect(screen.getByTestId("expense-xoa-lai-nhap-goc").textContent).toContain(
      "xoá luôn dòng lãi nhập gốc đi kèm"
    );
  });

  it("khoản chi thường: không có câu đó", () => {
    render(<ExpenseDeleteDialog open onOpenChange={() => {}} expense={chiPhi(null)} />);
    expect(screen.queryByTestId("expense-xoa-lai-nhap-goc")).toBeNull();
  });

  it.each([
    ["KHOAN_VAY_DA_TAT_TOAN", "Khoản thấu chi này đã tất toán — không xoá được dòng lãi đi cặp"],
    ["KHONG_CO_QUYEN", "Bạn không có quyền sửa dư nợ khoản vay (lãi nhập gốc thấu chi)"],
    ["CAP_DA_DOI", "Dòng lãi nhập gốc vừa đổi ở nơi khác — tải lại trang"],
  ])("mã lỗi %s ⇒ toast đúng câu tiếng Việt của server, hộp không đóng", async (code, error) => {
    deleteExpense.mockResolvedValue({ ok: false, code, error });
    const onOpenChange = vi.fn();
    render(<ExpenseDeleteDialog open onOpenChange={onOpenChange} expense={chiPhi("LOAN:tc1:2026-10-01")} />);
    fireEvent.click(screen.getByRole("button", { name: "Xóa" }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(error));
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
    expect(refresh).not.toHaveBeenCalled();
  });
});
