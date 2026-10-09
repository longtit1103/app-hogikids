// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { chotSaoKe, docUocTinhSaoKe, toast } = vi.hoisted(() => ({
  chotSaoKe: vi.fn(),
  docUocTinhSaoKe: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {}, replace: () => {}, push: () => {} }) }));
vi.mock("sonner", () => ({ toast }));
vi.mock("@/lib/actions/chot-sao-ke", () => ({ chotSaoKe }));
vi.mock("@/lib/actions/uoc-tinh-sao-ke", () => ({ docUocTinhSaoKe }));

import { cauChenhSaoKe, ChotSaoKeFormModal } from "@/components/no-phai-tra/chot-sao-ke-form-modal";

function mo() {
  render(
    <ChotSaoKeFormModal
      open
      onOpenChange={() => {}}
      the={{ id: "t1", ten: "Visa" }}
      mocM="2020-01-01"
      ngayChotMacDinh="2026-09-25"
      hanTraGoiY="2026-10-12"
    />,
  );
}
const soDu = () => screen.getByLabelText(/Số dư trên sao kê/) as HTMLInputElement;
const nutChot = () => screen.getByRole("button", { name: "Chốt sao kê" }) as HTMLButtonElement;

beforeEach(() => {
  chotSaoKe.mockReset();
  docUocTinhSaoKe.mockReset();
  Object.values(toast).forEach((f) => f.mockReset());
});
afterEach(cleanup);

describe("cauChenhSaoKe", () => {
  it("khớp / cao hơn / thấp hơn — nói rõ chiều lệch", () => {
    expect(cauChenhSaoKe(1_000, 1_000)).toBe("Khớp ước tính của app.");
    expect(cauChenhSaoKe(1_200_000, 1_000_000)).toContain("CAO hơn app tính 200.000 ₫");
    expect(cauChenhSaoKe(800_000, 1_000_000)).toContain("THẤP hơn app tính 200.000 ₫");
  });
});

describe("ChotSaoKeFormModal", () => {
  it("điền sẵn ngày chốt + hạn trả gợi ý và hỏi ước tính của app đúng ngày đó", async () => {
    docUocTinhSaoKe.mockResolvedValue({ ok: true, data: { uocTinh: 1_000_000 } });
    mo();
    expect((screen.getByLabelText("Ngày chốt sao kê") as HTMLInputElement).value).toBe("2026-09-25");
    expect((screen.getByLabelText("Hạn trả") as HTMLInputElement).value).toBe("2026-10-12");
    await waitFor(() => expect(docUocTinhSaoKe).toHaveBeenCalledWith({ cardId: "t1", ngay: "2026-09-25" }));
  });

  it("hiện ước tính của app + chênh trước khi lưu", async () => {
    docUocTinhSaoKe.mockResolvedValue({ ok: true, data: { uocTinh: 1_000_000 } });
    mo();
    await waitFor(() => expect(screen.getByTestId("sao-ke-uoc-tinh").textContent).toContain("1.000.000 ₫"));
    fireEvent.change(soDu(), { target: { value: "1200000" } });
    const khung = screen.getByTestId("sao-ke-uoc-tinh").textContent ?? "";
    expect(khung).toContain("Ước tính của app tại ngày đó");
    expect(khung).toContain("CAO hơn app tính 200.000 ₫");
  });

  it("app chưa có neo ⇒ nói không có số để so, vẫn chốt được", async () => {
    docUocTinhSaoKe.mockResolvedValue({ ok: true, data: { uocTinh: null } });
    mo();
    await waitFor(() => expect(screen.getByTestId("sao-ke-uoc-tinh").textContent).toContain("chưa có điểm neo"));
    fireEvent.change(soDu(), { target: { value: "500000" } });
    expect(nutChot().disabled).toBe(false);
  });

  it("chưa gõ số dư ⇒ khoá nút; hạn trả không sau ngày chốt ⇒ khoá + câu đỏ", async () => {
    docUocTinhSaoKe.mockResolvedValue({ ok: true, data: { uocTinh: null } });
    mo();
    expect(nutChot().disabled).toBe(true);
    fireEvent.change(soDu(), { target: { value: "500000" } });
    expect(nutChot().disabled).toBe(false);
    fireEvent.change(screen.getByLabelText("Hạn trả"), { target: { value: "2026-09-25" } });
    expect(nutChot().disabled).toBe(true);
    expect(screen.getByText("Hạn trả phải sau ngày chốt.")).toBeTruthy();
  });

  it("gửi yeuCauId uuid + số dư; DA_GHI_ROI ⇒ toast 'đã chốt rồi', không lỗi", async () => {
    docUocTinhSaoKe.mockResolvedValue({ ok: true, data: { uocTinh: 1_000_000 } });
    chotSaoKe.mockResolvedValue({
      ok: true,
      code: "DA_GHI_ROI",
      data: { id: "k1", cardId: "t1", ngayChot: "2026-09-25", soDu: 1_200_000, uocTinh: 1_000_000, chenh: 200_000 },
    });
    mo();
    fireEvent.change(soDu(), { target: { value: "1200000" } });
    fireEvent.click(nutChot());
    await waitFor(() => expect(chotSaoKe).toHaveBeenCalledTimes(1));
    const arg = chotSaoKe.mock.calls[0][0];
    expect(arg.yeuCauId).toMatch(/^[0-9a-f-]{36}$/);
    expect(arg.soDu).toBe(1_200_000);
    expect(arg.cardId).toBe("t1");
    await waitFor(() => expect(toast.info).toHaveBeenCalledWith(expect.stringContaining("đã được chốt rồi")));
    expect(toast.error).not.toHaveBeenCalled();
  });
});
