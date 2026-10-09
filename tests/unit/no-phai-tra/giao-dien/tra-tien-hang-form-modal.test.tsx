// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { traTienHangGop, toast } = vi.hoisted(() => ({
  traTienHangGop: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));
const refresh = vi.fn();

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh, replace: () => {}, push: () => {} }) }));
vi.mock("sonner", () => ({ toast }));
vi.mock("@/lib/actions/tra-tien-hang", () => ({ traTienHangGop }));

import { TraTienHangFormModal } from "@/components/no-phai-tra/tra-tien-hang-form-modal";
import { dongPhanBoGui, goiYPhanBoCuTruoc, tongPhanBo } from "@/components/no-phai-tra/phan-bo-tra-gop";
import type { PhieuConNo } from "@/lib/no-phai-tra/phieu-nhap-no-queries";

function phieu(id: string, conNo: number, daHuy = false): PhieuConNo {
  return {
    id,
    refId: `PANCAKE_PURCHASE:${id}`,
    shopId: "kho",
    maPhieu: `#${id}`,
    ngayPhieu: new Date(2026, 9, 1),
    tongTien: conNo,
    daTraTruoc: 0,
    daHuy,
    lechDaGiaiThich: false,
    lechDaGiaiThichSo: null,
    note: "",
    daTra: 0,
    daHoan: 0,
    conNo,
    trangThai: "CON_NO",
    soDongTien: 0,
  };
}

const DS = [phieu("a", 100_000), phieu("b", 200_000), phieu("c", 300_000), phieu("huy", 50_000, true)];

function moModal() {
  render(<TraTienHangFormModal open onOpenChange={() => {}} phieu={DS} vanTay="van-tay-1" mocM="2020-01-01" />);
}
const oPhieu = (id: string) => screen.getByLabelText(`Trả phiếu #${id}`) as HTMLInputElement;
const nutGhi = () => screen.getByRole("button", { name: /Ghi trả tiền hàng/ }) as HTMLButtonElement;
const gõTong = (v: string) => fireEvent.change(screen.getByLabelText("Tổng số tiền trả"), { target: { value: v } });

beforeEach(() => {
  traTienHangGop.mockReset();
  Object.values(toast).forEach((f) => f.mockReset());
  refresh.mockReset();
});
afterEach(cleanup);

describe("phân bổ gợi ý cũ trước (thuần)", () => {
  it("trả phiếu cũ trước, mỗi phiếu tối đa còn nợ; phần dư KHÔNG tự dồn", () => {
    const p = [phieu("a", 100), phieu("b", 200)];
    expect(goiYPhanBoCuTruoc(p, 150)).toEqual({ a: 100, b: 50 });
    expect(goiYPhanBoCuTruoc(p, 500)).toEqual({ a: 100, b: 200 });
    expect(tongPhanBo(goiYPhanBoCuTruoc(p, 500))).toBe(300);
    expect(dongPhanBoGui({ a: 0, b: 20 })).toEqual([{ phieuNhapId: "b", soTien: 20 }]);
  });
});

describe("TraTienHangFormModal", () => {
  it("không liệt kê phiếu đã huỷ", () => {
    moModal();
    expect(screen.queryByLabelText("Trả phiếu #huy")).toBeNull();
    expect(oPhieu("a")).toBeTruthy();
  });

  it("gõ tổng ⇒ gợi ý cũ trước; Σ phân bổ = tổng ⇒ mở nút Ghi", () => {
    moModal();
    expect(nutGhi().disabled).toBe(true);
    gõTong("250000");
    expect(oPhieu("a").value).toBe("100.000");
    expect(oPhieu("b").value).toBe("150.000");
    expect(oPhieu("c").value).toBe("");
    expect(nutGhi().disabled).toBe(false);
  });

  it("sửa tay một ô làm Σ ≠ tổng ⇒ khoá nút + câu đỏ nói lệch bao nhiêu", () => {
    moModal();
    gõTong("250000");
    fireEvent.change(oPhieu("b"), { target: { value: "100000" } });
    expect(nutGhi().disabled).toBe(true);
    expect(screen.getByTestId("tra-hang-lech").textContent).toContain("Còn thiếu 50.000 ₫");
    fireEvent.change(oPhieu("b"), { target: { value: "200000" } });
    expect(screen.getByTestId("tra-hang-lech").textContent).toContain("vượt tổng tiền trả 50.000 ₫");
  });

  it("tổng vượt Σ còn nợ ⇒ phần dư chưa phân bổ ⇒ nút khoá tới khi chủ shop chọn phiếu nhận", () => {
    moModal();
    gõTong("700000");
    expect(nutGhi().disabled).toBe(true);
    fireEvent.change(oPhieu("c"), { target: { value: "400000" } });
    expect(nutGhi().disabled).toBe(false);
  });

  it("gửi đúng: yeuCauId uuid, vân tay server đưa, phân bổ chỉ phiếu > 0", async () => {
    traTienHangGop.mockResolvedValue({ ok: true, data: { daGhi: 2, tong: 250_000 } });
    moModal();
    gõTong("250000");
    fireEvent.click(nutGhi());
    await waitFor(() => expect(traTienHangGop).toHaveBeenCalledTimes(1));
    const arg = traTienHangGop.mock.calls[0][0];
    expect(arg.yeuCauId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(arg.vanTay).toBe("van-tay-1");
    expect(arg.tong).toBe(250_000);
    expect(arg.phanBo).toEqual([
      { phieuNhapId: "a", soTien: 100_000 },
      { phieuNhapId: "b", soTien: 150_000 },
    ]);
    await waitFor(() => expect(toast.success).toHaveBeenCalled());
  });

  it("DA_GHI_ROI ⇒ toast 'đã ghi rồi', KHÔNG toast lỗi", async () => {
    traTienHangGop.mockResolvedValue({ ok: true, data: { daGhi: 2, tong: 250_000 }, code: "DA_GHI_ROI" });
    moModal();
    gõTong("250000");
    fireEvent.click(nutGhi());
    await waitFor(() => expect(toast.info).toHaveBeenCalledWith(expect.stringContaining("đã được ghi rồi")));
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("DANH_SACH_DA_DOI ⇒ báo lỗi + tải lại; PHIEU_DA_HUY ⇒ câu đỏ tại form", async () => {
    traTienHangGop.mockResolvedValueOnce({ ok: false, error: "Danh sách đã đổi", code: "DANH_SACH_DA_DOI" });
    moModal();
    gõTong("250000");
    fireEvent.click(nutGhi());
    await waitFor(() => expect(refresh).toHaveBeenCalled());
    expect(toast.error).toHaveBeenCalledWith("Danh sách đã đổi");

    traTienHangGop.mockResolvedValueOnce({ ok: false, error: "Phiếu #a đã huỷ", code: "PHIEU_DA_HUY", field: "phanBo" });
    fireEvent.click(nutGhi());
    await waitFor(() => expect(screen.getByText("Phiếu #a đã huỷ")).toBeTruthy());
  });
});
