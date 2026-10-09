// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { addDays, format } from "date-fns";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { taoThe, suaThe, ganNenTang, toast } = vi.hoisted(() => ({
  taoThe: vi.fn(),
  suaThe: vi.fn(),
  ganNenTang: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {}, replace: () => {}, push: () => {} }) }));
vi.mock("sonner", () => ({ toast }));
vi.mock("@/lib/actions/the-tin-dung", () => ({
  taoThe,
  suaThe,
  ganNenTang,
  dongThe: vi.fn(),
  xoaThe: vi.fn(),
  xoaGanNenTang: vi.fn(),
}));
// Ô chọn thật (Base UI) chỉ dựng danh sách khi mở popup — bản tĩnh để đọc thẳng các mục.
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

import { GanNenTangForm } from "@/components/no-phai-tra/gan-nen-tang-form";
import { NEN_TANG_CHON } from "@/components/no-phai-tra/nen-tang-gan-the";
import { TheTinDungFormModal } from "@/components/no-phai-tra/the-tin-dung-form-modal";

/** M cách hôm nay 10 ngày: neo hợp lệ ∈ [M − 1, hôm qua] nên ngày mặc định (hôm qua) lọt khoảng. */
const MOC_M = format(addDays(new Date(), -10), "yyyy-MM-dd");

beforeEach(() => {
  taoThe.mockReset();
  ganNenTang.mockReset();
  Object.values(toast).forEach((f) => f.mockReset());
});
afterEach(cleanup);

function dienHoSo() {
  fireEvent.change(screen.getByLabelText("Tên thẻ"), { target: { value: "Techcombank Visa" } });
  fireEvent.change(screen.getByLabelText("Ngày chốt sao kê (1–31)"), { target: { value: "25" } });
  fireEvent.change(screen.getByLabelText("Ngày hạn trả (1–31)"), { target: { value: "12" } });
}

describe("TheTinDungFormModal — dư nợ ban đầu sau khi bật", () => {
  it("sau bật: ô số dư neo KHOÁ ở 0 + câu giải thích 'thẻ đang có nợ phải khai ở bước bật'", () => {
    render(<TheTinDungFormModal open onOpenChange={() => {}} mocM={MOC_M} />);
    const soDu = screen.getByLabelText("Dư nợ ban đầu") as HTMLInputElement;
    expect(soDu.value).toBe("0");
    expect(soDu.disabled).toBe(true);
    expect(screen.getByTestId("the-neo-ban-dau").textContent).toContain("thẻ đang có nợ phải khai ở bước bật");
    // Cửa sổ neo đầu tiên (spec §5.8): giao dịch gắn thẻ chỉ ghi được từ SAU ngày neo.
    expect(screen.getByTestId("the-neo-goi-y-ngay").textContent).toContain("chỉ ghi được từ SAU ngày neo");
  });

  it("gửi neoBanDau.soDu = 0 (số, không phải chuỗi) cùng ngày chốt", async () => {
    taoThe.mockResolvedValue({ ok: true, data: { id: "t1" } });
    render(<TheTinDungFormModal open onOpenChange={() => {}} mocM={MOC_M} />);
    dienHoSo();
    fireEvent.click(screen.getByRole("button", { name: "Lưu" }));
    await waitFor(() => expect(taoThe).toHaveBeenCalledTimes(1));
    const arg = taoThe.mock.calls[0][0];
    expect(arg.ten).toBe("Techcombank Visa");
    expect(arg.ngayChotSaoKe).toBe(25);
    expect(arg.ngayHanTra).toBe(12);
    expect(arg.neoBanDau.soDu).toBe(0);
    expect(arg.neoBanDau.ngayChot).toBeInstanceOf(Date);
  });

  it("trước bật: KHÔNG có khối neo và không gửi neoBanDau", async () => {
    taoThe.mockResolvedValue({ ok: true, data: { id: "t1" } });
    render(<TheTinDungFormModal open onOpenChange={() => {}} mocM={null} />);
    expect(screen.queryByTestId("the-neo-ban-dau")).toBeNull();
    dienHoSo();
    fireEvent.click(screen.getByRole("button", { name: "Lưu" }));
    await waitFor(() => expect(taoThe).toHaveBeenCalledTimes(1));
    expect(taoThe.mock.calls[0][0]).not.toHaveProperty("neoBanDau");
  });

  it("lỗi NEO_KHAC_0 của server hiện ngay tại khối neo", async () => {
    taoThe.mockResolvedValue({ ok: false, error: "Thẻ thêm sau khi bật phải có dư nợ ban đầu = 0", code: "NEO_KHAC_0", field: "neoBanDau" });
    render(<TheTinDungFormModal open onOpenChange={() => {}} mocM={MOC_M} />);
    dienHoSo();
    fireEvent.click(screen.getByRole("button", { name: "Lưu" }));
    await waitFor(() => expect(screen.getAllByText(/dư nợ ban đầu = 0/).length).toBeGreaterThan(0));
  });
});

describe("GanNenTangForm", () => {
  it("chỉ Meta và TikTok Ads — KHÔNG có SHOPEE_ADS, không text tự do", () => {
    render(<GanNenTangForm open onOpenChange={() => {}} the={{ id: "t1", ten: "Visa" }} daBat />);
    const gia = screen.getAllByRole("option").map((o) => o.getAttribute("data-value"));
    expect(gia).toEqual(["META", "TIKTOK_ADS"]);
    expect(gia).toEqual(NEN_TANG_CHON.map((n) => n.value));
    expect(screen.queryByText(/Shopee/i)).toBeNull();
  });

  it("sau bật: ô ngày chặn lùi (min = hôm nay); lỗi GAN_LUI_NGAY của server hiện tại ô ngày", async () => {
    ganNenTang.mockResolvedValue({ ok: false, error: "mốc gắn thẻ không được lùi về quá khứ", code: "GAN_LUI_NGAY", field: "tuNgay" });
    render(<GanNenTangForm open onOpenChange={() => {}} the={{ id: "t1", ten: "Visa" }} daBat />);
    const ngay = screen.getByLabelText("Gắn từ ngày") as HTMLInputElement;
    expect(ngay.min).toBe(ngay.value); // mặc định = hôm nay = giới hạn dưới
    // Nút Gắn cần nền tảng: mô phỏng chọn bằng cách bấm mục (Select bản tĩnh không có onClick) ⇒ kiểm nút khoá
    expect((screen.getByRole("button", { name: "Gắn" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("trước bật: ngày không bị chặn lùi", () => {
    render(<GanNenTangForm open onOpenChange={() => {}} the={{ id: "t1", ten: "Visa" }} daBat={false} />);
    expect((screen.getByLabelText("Gắn từ ngày") as HTMLInputElement).min).toBe("");
  });
});
