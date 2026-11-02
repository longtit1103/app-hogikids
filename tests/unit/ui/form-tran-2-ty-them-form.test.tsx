// @vitest-environment jsdom
/**
 * Phủ thêm các form có ô tiền vượt trần 2 tỷ (ngoài nhóm ở `form-tran-2-ty-bao-tai-o.test.tsx`):
 * khoản vay, sổ tiết kiệm, kỳ trả nợ, chốt sao kê. Mỗi form: báo đỏ NGAY tại ô + khoá nút ghi, ô nhập
 * gắn `aria-invalid`/`aria-describedby` với câu lỗi. Hai ca hồi quy nhỏ đi kèm: ô "Lãi cố định" đã ẩn
 * (bật tính theo %/năm) không được khoá nút Lưu; nút "Bỏ qua kỳ" gửi toàn số 0 nên không bị trần chặn.
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: () => {}, replace: () => {}, push: () => {} }),
}));
vi.mock("sonner", () => ({ toast: { success: () => {}, error: () => {}, info: () => {} } }));
vi.mock("@/lib/actions/khoan-vay", () => ({ suaKhoanVay: vi.fn(), taoKhoanVay: vi.fn(), ghiKyTraNo: vi.fn() }));
vi.mock("@/lib/actions/so-tiet-kiem", () => ({ suaSoTietKiem: vi.fn(), taoSoTietKiem: vi.fn() }));
vi.mock("@/lib/actions/chot-sao-ke", () => ({ chotSaoKe: vi.fn() }));
vi.mock("@/components/ui/select", () => {
  const Bo = ({ children }: { children?: React.ReactNode }) => <div>{children}</div>;
  return {
    Select: Bo,
    SelectContent: Bo,
    SelectGroup: Bo,
    SelectLabel: Bo,
    SelectTrigger: Bo,
    SelectValue: () => null,
    SelectItem: ({ value, children }: { value: string; children?: React.ReactNode }) => (
      <div role="option" aria-selected={false} data-value={value}>
        {children}
      </div>
    ),
  };
});
vi.mock("@/lib/actions/uoc-tinh-sao-ke", () => ({
  docUocTinhSaoKe: vi.fn().mockResolvedValue({ ok: true, data: { uocTinh: 0 } }),
}));

import { KhoanVayFormModal } from "@/components/finance/khoan-vay-form-modal";
import { KyTraNoCard } from "@/components/finance/ky-tra-no-card";
import { SoTietKiemFormModal } from "@/components/finance/so-tiet-kiem-form-modal";
import { ChotSaoKeFormModal } from "@/components/no-phai-tra/chot-sao-ke-form-modal";
import { MAX_AMOUNT_INPUT } from "@/lib/format-amount-input";
import type { KhoanVayRow } from "@/lib/so-quy/khoan-vay-queries";

afterEach(cleanup);

const BA_TY = "3000000000";

function nutLuu(ten: RegExp): HTMLButtonElement {
  return screen.getByRole("button", { name: ten }) as HTMLButtonElement;
}

describe("khoản vay", () => {
  it("gõ 3 tỷ vào số tiền giải ngân ⇒ dòng đỏ tại ô và nút Lưu khoá", () => {
    render(<KhoanVayFormModal open onOpenChange={() => {}} d0={null} />);
    fireEvent.change(screen.getByLabelText(/^Tên/), { target: { value: "Vay A" } });
    const oTien = screen.getAllByPlaceholderText("0")[0];
    fireEvent.change(oTien, { target: { value: String(MAX_AMOUNT_INPUT) } });
    expect(screen.queryAllByText(/Số tiền tối đa/)).toHaveLength(0);
    fireEvent.change(oTien, { target: { value: BA_TY } });
    expect(screen.getAllByText(/Số tiền tối đa/).length).toBeGreaterThan(0);
    expect(nutLuu(/^Lưu$/).disabled).toBe(true);
  });

  it("gốc-cuối-kỳ: bật tính theo %/năm thì số lãi cố định cũ (ô đã ẩn) không khoá nút Lưu", () => {
    const loan = {
      id: "l1",
      name: "Vay BULLET",
      lender: "NH",
      kind: "BULLET",
      duNoMoSo: 0,
      giaiNgan: 50_000_000,
      giaiNganNgay: new Date("2026-10-01T00:00:00+07:00"),
      startDate: new Date("2026-10-01T00:00:00+07:00"),
      firstDueDate: new Date("2026-11-10T00:00:00+07:00"),
      termMonths: 12,
      annualRateBp: 1000,
      note: "",
      // Số lãi cố định lỡ vượt trần nằm sẵn trong hồ sơ; công tắc %/năm đang BẬT nên ô không hiện.
      laiCoDinhMoiKy: null,
      tienGuiBatBuocMoiKy: 0,
      laiNhapGoc: false,
      lastDueHandled: null,
      coTraGoc: false,
      closedAt: null,
      traGoc: [],
      nhapGoc: [],
      duNo: 50_000_000,
      laiTamTinh: null,
      kyCho: null,
      tienGuiDangGiu: 0,
      coDongTienGui: false,
      ngayTatToanSomNhat: new Date("2026-10-01T00:00:00+07:00"),
    } as unknown as KhoanVayRow;
    render(<KhoanVayFormModal open onOpenChange={() => {}} loan={loan} d0={null} />);
    // Tắt "%/năm" → ô "Lãi cố định mỗi kỳ" hiện; gõ 3 tỷ ⇒ khoá. Bật lại "%/năm" ⇒ ô ẩn ⇒ phải mở khoá.
    const congTac = screen.getByRole("switch");
    fireEvent.click(congTac);
    fireEvent.change(screen.getByLabelText(/Lãi cố định mỗi kỳ/), { target: { value: BA_TY } });
    expect(nutLuu(/^Lưu$/).disabled).toBe(true);
    fireEvent.click(congTac);
    expect(screen.queryByLabelText(/Lãi cố định mỗi kỳ/)).toBeNull();
    expect(nutLuu(/^Lưu$/).disabled).toBe(false);
  });
});

describe("sổ tiết kiệm", () => {
  it("gõ 3 tỷ vào số tiền gửi ⇒ dòng đỏ tại ô và nút Lưu khoá", () => {
    render(<SoTietKiemFormModal open onOpenChange={() => {}} loans={[]} d0={null} />);
    const oTien = screen.getAllByPlaceholderText("0")[0];
    fireEvent.change(oTien, { target: { value: String(MAX_AMOUNT_INPUT) } });
    expect(screen.queryAllByText(/Số tiền tối đa/)).toHaveLength(0);
    fireEvent.change(oTien, { target: { value: BA_TY } });
    expect(screen.getAllByText(/Số tiền tối đa/).length).toBeGreaterThan(0);
    expect(nutLuu(/^Lưu$/).disabled).toBe(true);
  });
});

describe("kỳ trả nợ chờ duyệt", () => {
  const loan = {
    id: "l1",
    name: "Vay A",
    kind: "TERM",
    termMonths: 12,
    laiNhapGoc: false,
    duNo: 10_000_000,
    tienGuiDangGiu: 0,
    kyCho: {
      ky: 1,
      tuNgay: new Date("2026-10-01T00:00:00+07:00"),
      denNgay: new Date("2026-11-01T00:00:00+07:00"),
      soNgay: 31,
      duNoDauKy: 10_000_000,
      lai: 100_000,
      goc: 500_000,
      tienGui: 0,
    },
  } as unknown as Parameters<typeof KyTraNoCard>[0]["loan"];

  it("gõ lãi 3 tỷ ⇒ ô Lãi gắn aria-invalid + aria-describedby tới câu lỗi", () => {
    render(<KyTraNoCard loan={loan} />);
    const o = screen.getByLabelText("Lãi") as HTMLInputElement;
    expect(o.getAttribute("aria-invalid")).toBeNull();
    fireEvent.change(o, { target: { value: BA_TY } });
    const loi = screen.getByTestId("loi-vuot-tran-tien");
    expect(o.getAttribute("aria-invalid")).toBe("true");
    expect(loi.id).not.toBe("");
    expect(o.getAttribute("aria-describedby")).toBe(loi.id);
  });

  it("vượt trần khoá 'Ghi vào sổ' nhưng KHÔNG khoá 'Bỏ qua kỳ' (bỏ qua gửi toàn số 0)", () => {
    render(<KyTraNoCard loan={loan} />);
    fireEvent.change(screen.getByLabelText("Lãi"), { target: { value: BA_TY } });

    fireEvent.click(screen.getByRole("button", { name: /Ngân hàng không thu kỳ này/ }));
    expect(nutLuu(/^Bỏ qua kỳ$/).disabled).toBe(false);
  });

  it("vượt trần vẫn khoá 'Ghi vào sổ'", () => {
    render(<KyTraNoCard loan={loan} />);
    fireEvent.change(screen.getByLabelText("Lãi"), { target: { value: BA_TY } });
    fireEvent.click(screen.getByRole("button", { name: /Đã chuyển tiền — ghi vào sổ/ }));
    expect(nutLuu(/^Ghi vào sổ$/).disabled).toBe(true);
  });
});

describe("chốt sao kê", () => {
  it("gõ số dư 3 tỷ ⇒ dòng đỏ và nút Chốt sao kê khoá; đúng trần thì mở", () => {
    render(
      <ChotSaoKeFormModal
        open
        onOpenChange={() => {}}
        the={{ id: "t1", ten: "Visa" }}
        mocM="2026-10-01"
        ngayChotMacDinh="2026-10-20"
        hanTraGoiY="2026-11-10"
      />,
    );
    const o = screen.getByLabelText(/Số dư trên sao kê/) as HTMLInputElement;
    fireEvent.change(o, { target: { value: String(MAX_AMOUNT_INPUT) } });
    expect(nutLuu(/^Chốt sao kê$/).disabled).toBe(false);

    fireEvent.change(o, { target: { value: BA_TY } });
    expect(screen.getByText(/Số tiền tối đa/)).toBeTruthy();
    expect(nutLuu(/^Chốt sao kê$/).disabled).toBe(true);
  });
});
