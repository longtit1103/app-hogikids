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

import {
  canhBaoChotSom,
  cauChenhSaoKe,
  cauHoaDonNgayChot,
  ChotSaoKeFormModal,
} from "@/components/no-phai-tra/chot-sao-ke-form-modal";

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
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("cauChenhSaoKe", () => {
  it("khớp / cao hơn / thấp hơn — nói rõ chiều lệch", () => {
    expect(cauChenhSaoKe(1_000, 1_000)).toBe("Khớp ước tính của app.");
    expect(cauChenhSaoKe(1_200_000, 1_000_000)).toContain("CAO hơn app tính 200.000 ₫");
    expect(cauChenhSaoKe(800_000, 1_000_000)).toContain("THẤP hơn app tính 200.000 ₫");
    expect(cauChenhSaoKe(1_200_000, 1_000_000)).toContain("hoá đơn TikTok chưa kéo");
    expect(cauChenhSaoKe(800_000, 1_000_000)).toContain("ghi trùng");
    // Độ trễ HAI chiều: thấp hơn app cũng có thể do ngân hàng ghi sổ trễ lần TikTok trừ.
    expect(cauChenhSaoKe(800_000, 1_000_000)).toContain("ngân hàng ghi sổ trễ");
  });
});

describe("cauHoaDonNgayChot", () => {
  it("nói số lần + tổng và cách gõ cho cả hai trường hợp", () => {
    const cau = cauHoaDonNgayChot({ soLan: 6, tong: 874_435 });
    expect(cau).toContain("CHƯA gồm 6 lần TikTok trừ thẻ trong ngày chốt (tổng 874.435 ₫)");
    expect(cau).toContain("gõ số sao kê + 874.435 ₫");
    expect(cau).toContain("có rồi thì gõ đúng số sao kê");
    expect(cau).not.toContain("ví TikTok Shop");
  });

  it("có phần ví TikTok Shop trả ⇒ chỉ bảo cộng phần thẻ thật, nói rõ phần ví đã bỏ", () => {
    // Server đã trừ: 3 hoá đơn 900.000 trong đó ví trả 300.000 ⇒ 2 lần / 600.000 trừ thẻ thật.
    const cau = cauHoaDonNgayChot({ soLan: 2, tong: 600_000, viTra: 300_000 });
    expect(cau).toContain("2 lần TikTok trừ thẻ trong ngày chốt (tổng 600.000 ₫)");
    expect(cau).toContain("gõ số sao kê + 600.000 ₫");
    expect(cau).not.toContain("900.000");
    expect(cau).toContain("Đã bỏ 300.000 ₫ ví TikTok Shop trả");
  });
});

describe("canhBaoChotSom", () => {
  it("hôm nay < ngày chốt + 2 ⇒ cảnh báo kèm ngày nên chốt; từ ngày chốt + 2 ⇒ không", () => {
    expect(canhBaoChotSom("2026-10-20", "2026-10-20")).toContain("nên chốt từ 22/10");
    expect(canhBaoChotSom("2026-10-20", "2026-10-21")).toContain("sau 2 đêm");
    expect(canhBaoChotSom("2026-10-20", "2026-10-22")).toBeNull();
    expect(canhBaoChotSom("2026-10-20", "2026-11-05")).toBeNull();
    // Qua tháng / qua năm theo lịch.
    expect(canhBaoChotSom("2026-12-31", "2026-12-31")).toContain("nên chốt từ 02/01");
    expect(canhBaoChotSom("", "2026-10-20")).toBeNull();
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

  it("ngày chốt có lần TikTok trừ thẻ ⇒ nhắc sao kê thường chưa gồm, kèm số lần + tổng", async () => {
    docUocTinhSaoKe.mockResolvedValue({
      ok: true,
      data: { uocTinh: 1_000_000, hoaDonNgayChot: { soLan: 2, tong: 286_000 } },
    });
    mo();
    await waitFor(() => expect(screen.getByTestId("sao-ke-hoa-don-ngay-chot").textContent).toContain("2 lần TikTok trừ"));
    expect(screen.getByTestId("sao-ke-hoa-don-ngay-chot").textContent).toContain("286.000 ₫");
    // Câu cũ "KHÔNG cộng thêm" đã bỏ — sai khi ngân hàng chưa ghi sổ lần trừ ngày chốt.
    expect(document.body.textContent).not.toContain("KHÔNG cộng thêm");
  });

  it("phần ví trả bằng cả ngày (0 lần trừ thẻ thật) ⇒ không hiện nhắc", async () => {
    docUocTinhSaoKe.mockResolvedValue({
      ok: true,
      data: { uocTinh: 1_000_000, hoaDonNgayChot: { soLan: 0, tong: 0, viTra: 143_000 } },
    });
    mo();
    await waitFor(() => expect(screen.getByTestId("sao-ke-uoc-tinh").textContent).toContain("1.000.000 ₫"));
    expect(screen.queryByTestId("sao-ke-hoa-don-ngay-chot")).toBeNull();
  });

  it("chốt sớm (hôm nay giờ VN < ngày chốt + 2) ⇒ dòng cảnh báo, vẫn chốt được", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    // 23:30 VN ngày 26/09 (= 16:30 UTC) — ngày chốt mặc định 25/09 ⇒ nên chốt từ 27/09.
    vi.setSystemTime(new Date("2026-09-26T16:30:00Z"));
    docUocTinhSaoKe.mockResolvedValue({ ok: true, data: { uocTinh: null } });
    mo();
    const canhBao = await screen.findByTestId("sao-ke-canh-bao-chot-som");
    expect(canhBao.textContent).toContain("Hoá đơn TikTok chiều/tối ngày chốt thường về app sau 2 đêm");
    expect(canhBao.textContent).toContain("nên chốt từ 27/09");
    fireEvent.change(soDu(), { target: { value: "500000" } });
    expect(nutChot().disabled).toBe(false);
  });

  it("đủ muộn (01:00 VN ngày chốt + 2, dù UTC còn ngày trước) ⇒ không cảnh báo", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-26T18:00:00Z"));
    docUocTinhSaoKe.mockResolvedValue({ ok: true, data: { uocTinh: 1_000_000 } });
    mo();
    await waitFor(() => expect(screen.getByTestId("sao-ke-uoc-tinh").textContent).toContain("1.000.000 ₫"));
    expect(screen.queryByTestId("sao-ke-canh-bao-chot-som")).toBeNull();
  });

  it("ngày chốt không có lần TikTok trừ ⇒ không hiện nhắc", async () => {
    docUocTinhSaoKe.mockResolvedValue({ ok: true, data: { uocTinh: 1_000_000, hoaDonNgayChot: { soLan: 0, tong: 0 } } });
    mo();
    await waitFor(() => expect(screen.getByTestId("sao-ke-uoc-tinh").textContent).toContain("1.000.000 ₫"));
    expect(screen.queryByTestId("sao-ke-hoa-don-ngay-chot")).toBeNull();
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
