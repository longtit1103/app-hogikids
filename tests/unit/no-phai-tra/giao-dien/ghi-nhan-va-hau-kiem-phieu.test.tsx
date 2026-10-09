// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { ghiNhanPhieuVaoSoNo, capNhatTongPhieu, danhDauHuyPhieu, capNhatDaTraTruoc, boQuaLechDaGiaiThich, toast } =
  vi.hoisted(() => ({
    ghiNhanPhieuVaoSoNo: vi.fn(),
    capNhatTongPhieu: vi.fn(),
    danhDauHuyPhieu: vi.fn(),
    capNhatDaTraTruoc: vi.fn(),
    boQuaLechDaGiaiThich: vi.fn(),
    toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
  }));
const refresh = vi.fn();

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh, replace: () => {}, push: () => {} }) }));
vi.mock("sonner", () => ({ toast }));
vi.mock("@/lib/actions/phieu-nhap-no", () => ({
  ghiNhanPhieuVaoSoNo,
  capNhatTongPhieu,
  danhDauHuyPhieu,
  capNhatDaTraTruoc,
  boQuaLechDaGiaiThich,
}));

import { hasPurchaseSpend } from "@/components/finance/cash-flow-tab";
import { GhiNhanPhieuVaoSoNo } from "@/components/no-phai-tra/ghi-nhan-phieu-vao-so-no";
import { HauKiemPhieuKhoi } from "@/components/no-phai-tra/hau-kiem-phieu-khoi";
import type { PhieuChoGhiNo } from "@/lib/no-phai-tra/doc-phieu-cho-ghi-no";
import type { CanhBaoHauKiem } from "@/lib/no-phai-tra/phieu-nhap-no-queries";

beforeEach(() => {
  [ghiNhanPhieuVaoSoNo, capNhatTongPhieu, danhDauHuyPhieu, capNhatDaTraTruoc, boQuaLechDaGiaiThich, refresh].forEach((f) =>
    f.mockReset(),
  );
  Object.values(toast).forEach((f) => f.mockReset());
});
afterEach(cleanup);

const P = (o: Partial<PhieuChoGhiNo> & { uuid: string }): PhieuChoGhiNo => ({
  displayId: 1,
  ngay: new Date(2026, 9, 2),
  soTien: 10_000_000,
  nhaCungCap: "NCC A",
  ghiChu: null,
  soDongHang: 3,
  lechLuoiKiem: false,
  truocD0: false,
  soNguon: null,
  ...o,
});

describe("hasPurchaseSpend sau bật", () => {
  it("luật cũ khi không truyền sauBat", () => {
    expect(hasPurchaseSpend([])).toBe(false);
  });
  it("sau bật: có SUPPLIER_PAY trong kỳ HOẶC có phiếu mở ⇒ coi là đã ghi tiền hàng", () => {
    expect(hasPurchaseSpend([], { coSupplierPayTrongKy: false, coPhieuMo: false })).toBe(false);
    expect(hasPurchaseSpend([], { coSupplierPayTrongKy: true, coPhieuMo: false })).toBe(true);
    expect(hasPurchaseSpend([], { coSupplierPayTrongKy: false, coPhieuMo: true })).toBe(true);
  });
});

describe("GhiNhanPhieuVaoSoNo (sau bật)", () => {
  const props = { mocM: "2026-10-01", laChuShop: false, choPhepSua: true };

  it("KHÔNG có ô sửa số tiền ghi sổ; khối ảnh hưởng nói KHÔNG đổi quỹ", () => {
    render(<GhiNhanPhieuVaoSoNo phieu={[P({ uuid: "u1" })]} {...props} />);
    expect(screen.queryByLabelText(/Số tiền ghi sổ/)).toBeNull();
    expect(screen.getByTestId("anh-huong-khong-doi-quy").textContent).toContain("KHÔNG đổi quỹ — chỉ ghi nghĩa vụ");
    expect(screen.getByRole("button", { name: /Ghi nhận 1 phiếu vào sổ nợ/ })).toBeTruthy();
  });

  it("ô 'Đã trả trước' chỉ hiện cho phiếu trước D0; phiếu cũ ẩn tới khi bấm nút hiện", () => {
    render(
      <GhiNhanPhieuVaoSoNo
        phieu={[P({ uuid: "moi", displayId: 7 }), P({ uuid: "cu", displayId: 3, truocD0: true })]}
        {...props}
      />,
    );
    expect(screen.queryByLabelText("Đã trả trước phiếu #3")).toBeNull();
    expect(screen.queryByLabelText("Đã trả trước phiếu #7")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Hiện 1 phiếu cũ hơn ngày mở sổ/ }));
    expect(screen.getByLabelText("Đã trả trước phiếu #3")).toBeTruthy();
    expect(screen.queryByLabelText("Đã trả trước phiếu #7")).toBeNull();
  });

  it("gõ khác số Sổ chi phí: chủ shop thấy ô lý do, người khác bị chặn bằng câu đỏ", () => {
    const cu = P({ uuid: "cu", displayId: 3, truocD0: true, soNguon: 5_000_000 });
    const { unmount } = render(<GhiNhanPhieuVaoSoNo phieu={[cu]} {...props} laChuShop />);
    fireEvent.click(screen.getByRole("button", { name: /Hiện 1 phiếu cũ/ }));
    // chọn phiếu cũ (mặc định không chọn) rồi gõ số khác
    fireEvent.click(screen.getByLabelText("Chọn phiếu #3"));
    fireEvent.change(screen.getByLabelText("Đã trả trước phiếu #3"), { target: { value: "3000000" } });
    expect(screen.getByLabelText("Lý do lệch phiếu #3")).toBeTruthy();
    expect((screen.getByRole("button", { name: /Ghi nhận 1 phiếu/ }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Lý do lệch phiếu #3"), { target: { value: "thực trả 3tr" } });
    expect((screen.getByRole("button", { name: /Ghi nhận 1 phiếu/ }) as HTMLButtonElement).disabled).toBe(false);
    unmount();

    render(<GhiNhanPhieuVaoSoNo phieu={[cu]} {...props} laChuShop={false} />);
    fireEvent.click(screen.getByRole("button", { name: /Hiện 1 phiếu cũ/ }));
    fireEvent.click(screen.getByLabelText("Chọn phiếu #3"));
    fireEvent.change(screen.getByLabelText("Đã trả trước phiếu #3"), { target: { value: "3000000" } });
    expect(screen.queryByLabelText("Lý do lệch phiếu #3")).toBeNull();
    expect(screen.getByText(/chỉ chủ shop ghi được/)).toBeTruthy();
    expect((screen.getByRole("button", { name: /Ghi nhận 1 phiếu/ }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("ghi nhận gọi action từng phiếu; 'trả ngay' gửi daTraNgay với số + ngày", async () => {
    ghiNhanPhieuVaoSoNo.mockResolvedValue({ ok: true, data: { phieuNhapId: "x", tongTien: 1, daTraTruoc: 0, conNo: 1 } });
    render(<GhiNhanPhieuVaoSoNo phieu={[P({ uuid: "u1", displayId: 9 })]} {...props} />);
    fireEvent.click(screen.getByLabelText("Đã trả ngay phiếu #9"));
    fireEvent.change(screen.getByLabelText("Số tiền trả ngay phiếu #9"), { target: { value: "4000000" } });
    fireEvent.click(screen.getByRole("button", { name: /Ghi nhận 1 phiếu vào sổ nợ/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Ghi vào sổ nợ" }));
    await waitFor(() => expect(ghiNhanPhieuVaoSoNo).toHaveBeenCalledTimes(1));
    const arg = ghiNhanPhieuVaoSoNo.mock.calls[0][0];
    expect(arg.uuid).toBe("u1");
    expect(arg.daTraNgay.soTien).toBe(4_000_000);
    expect(arg.daTraNgay.ngay).toBeInstanceOf(Date);
    expect(arg).not.toHaveProperty("daTraTruoc");
  });
});

describe("HauKiemPhieuKhoi", () => {
  const cb = (loai: CanhBaoHauKiem["loai"]): CanhBaoHauKiem => {
    const chung = { phieuNhapId: "p1", maPhieu: "#12", chiTiet: `chi tiết ${loai}` };
    if (loai === "DA_HUY_PANCAKE") return { ...chung, loai };
    return { ...chung, loai, soCu: 100, soMoi: 200 };
  };
  const tatCa = [cb("DOI_TONG"), cb("DA_HUY_PANCAKE"), cb("LECH_DA_TRA_TRUOC")];

  it("chủ shop thấy đủ 4 nút; nút 'Cập nhật tổng' gửi đúng số Pancake vừa hiện", async () => {
    capNhatTongPhieu.mockResolvedValue({ ok: true, data: {} });
    render(<HauKiemPhieuKhoi canhBao={tatCa} choPhepSua laChuShop />);
    for (const t of ["Cập nhật tổng", "Đánh dấu huỷ", "Cập nhật đã trả trước", "Đã giải thích"]) {
      expect(screen.getByRole("button", { name: t })).toBeTruthy();
    }
    fireEvent.click(screen.getByRole("button", { name: "Cập nhật tổng" }));
    await waitFor(() => expect(capNhatTongPhieu).toHaveBeenCalledWith({ phieuNhapId: "p1", tongTienMoi: 200 }));
  });

  it("người ghi không phải chủ shop: không có Đánh dấu huỷ / Đã giải thích", () => {
    render(<HauKiemPhieuKhoi canhBao={tatCa} choPhepSua laChuShop={false} />);
    expect(screen.queryByRole("button", { name: "Đánh dấu huỷ" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Đã giải thích" })).toBeNull();
    expect(screen.getByRole("button", { name: "Cập nhật tổng" })).toBeTruthy();
  });

  it("'Đã giải thích' bắt buộc ghi lý do rồi mới gửi", async () => {
    boQuaLechDaGiaiThich.mockResolvedValue({ ok: true, data: {} });
    render(<HauKiemPhieuKhoi canhBao={[cb("LECH_DA_TRA_TRUOC")]} choPhepSua laChuShop />);
    fireEvent.click(screen.getByRole("button", { name: "Đã giải thích" }));
    const luu = screen.getByRole("button", { name: "Lưu lý do" }) as HTMLButtonElement;
    expect(luu.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Lý do lệch phiếu #12"), { target: { value: "trả thiếu 1 đợt" } });
    expect(luu.disabled).toBe(false);
    fireEvent.click(luu);
    await waitFor(() =>
      expect(boQuaLechDaGiaiThich).toHaveBeenCalledWith({ phieuNhapId: "p1", note: "trả thiếu 1 đợt" }),
    );
  });

  it("không cảnh báo ⇒ không render gì", () => {
    const { container } = render(<HauKiemPhieuKhoi canhBao={[]} choPhepSua laChuShop />);
    expect(container.innerHTML).toBe("");
  });
});
