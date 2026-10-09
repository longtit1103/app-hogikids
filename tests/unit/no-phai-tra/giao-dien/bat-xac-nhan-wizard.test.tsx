// @vitest-environment jsdom
/**
 * Màn xác nhận bật nợ phải trả: khai dư nợ thẻ + số dư ví ⇒ tính chênh lệch ⇒ chọn điều chỉnh ⇒ xác nhận
 * gửi ĐÚNG số đang hiện. Đổi số sau khi đã tính ⇒ kết quả bị bỏ (không gửi điều chỉnh cũ với số mới).
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const hanhDong = vi.hoisted(() => ({ docChenhLechTaiM: vi.fn(), xacNhanBatNoPhaiTra: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {}, push: () => {}, replace: () => {} }) }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));
vi.mock("@/lib/actions/bat-no-phai-tra", () => hanhDong);

import { XacNhanBatWizard } from "@/components/no-phai-tra/bat-xac-nhan-wizard";
import { tinhChenhLechTaiM } from "@/lib/no-phai-tra/tinh-chenh-lech-tai-m";

const tr = (n: number) => n * 1_000_000;
const ketQua = {
  ...tinhChenhLechTaiM({
    quyApp: tr(150),
    soDuBank: tr(155),
    tienMat: tr(7),
    duNoThauChi: 0,
    the: [{ khoa: "the:A", nhan: "nợ thẻ Thẻ A", soTien: tr(9) }],
    phieuY: [],
    viAds: [{ khoa: "vi:V", nhan: "ví Shopee Ads đã nạp, chưa chạy (sổ chưa trừ)", soTien: -tr(3) }],
  }),
  ngayTruocM: "2026-10-31",
  tienDangGui: 0,
};

function mo(loiDieuKien: string[] = [], thieuHoSoVi: string | null = null) {
  render(
    <XacNhanBatWizard
      mocM="2026-11-01"
      nhanM="01/11/2026"
      ngayTruocM="2026-10-31"
      nhanTruocM="31/10/2026"
      the={[{ id: "A", ten: "Thẻ A", saoKeNgayChot: "2026-10-25", saoKeHanTra: "2026-11-10" }]}
      vi={[{ id: "V", nhan: "Ví Shopee Ads" }]}
      loiDieuKien={loiDieuKien}
      thieuHoSoVi={thieuHoSoVi}
    />
  );
}

const go = (nhan: string, giaTri: string) => fireEvent.change(screen.getByLabelText(nhan), { target: { value: giaTri } });

function khaiBuoc1() {
  go("Dư nợ Thẻ A", "9000000");
  go("Số sao kê Thẻ A", "12000000");
  go("Đã trả kỳ sao kê Thẻ A", "5000000");
  go("Số dư Ví Shopee Ads", "3000000");
}

beforeEach(() => {
  hanhDong.docChenhLechTaiM.mockResolvedValue({ ok: true, data: ketQua });
  hanhDong.xacNhanBatNoPhaiTra.mockResolvedValue({ ok: true, data: { mocM: "2026-11-01" } });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("XacNhanBatWizard", () => {
  it("đủ ba bước ⇒ gửi dư nợ, sao kê, số dư ví và đúng các dòng điều chỉnh đang hiện", async () => {
    mo();
    const nutTinh = screen.getByRole("button", { name: "Tính chênh lệch" });
    expect((nutTinh as HTMLButtonElement).disabled).toBe(true);
    khaiBuoc1();
    go("Số dư ngân hàng", "155000000");
    go("Tiền mặt", "7000000");
    fireEvent.click(screen.getByRole("button", { name: "Tính chênh lệch" }));
    await screen.findByTestId("bat-bang-chenh-lech");
    expect(hanhDong.docChenhLechTaiM).toHaveBeenCalledWith({
      mocM: "2026-11-01",
      soDuBank: tr(155),
      tienMat: tr(7),
      the: [{ cardId: "A", duNo: tr(9) }],
      viAds: [{ viAdsId: "V", soDu: tr(3) }],
    });

    const nutBat = screen.getByRole("button", { name: "Xác nhận bật theo dõi nợ phải trả" });
    expect((nutBat as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByLabelText("Tôi đã kiểm số và hiểu đây là bước một lần"));
    fireEvent.click(nutBat);
    await waitFor(() => expect(hanhDong.xacNhanBatNoPhaiTra).toHaveBeenCalledTimes(1));
    const gui = hanhDong.xacNhanBatNoPhaiTra.mock.calls[0][0];
    expect(gui).toMatchObject({
      mocM: "2026-11-01",
      the: [
        {
          cardId: "A",
          duNoCuoiMTru1: tr(9),
          saoKeCuoi: { ngayChot: "2026-10-25", hanTra: "2026-11-10", soDu: tr(12), daTraTruocMoSo: tr(5) },
        },
      ],
      viAds: [{ viAdsId: "V", soDuNeo: tr(3) }],
    });
    expect(gui.dieuChinh.map((d: { chieu: string; soTien: number }) => [d.chieu, d.soTien])).toEqual([
      ["IN", tr(9)],
      ["OUT", tr(3)],
    ]);
    expect(gui.yeuCauId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("đổi số ở bước 1 sau khi đã tính ⇒ bỏ kết quả, phải tính lại mới xác nhận được", async () => {
    mo();
    khaiBuoc1();
    fireEvent.click(screen.getByRole("button", { name: "Tính chênh lệch" }));
    await screen.findByTestId("bat-bang-chenh-lech");
    go("Dư nợ Thẻ A", "8000000");
    expect(screen.queryByTestId("bat-bang-chenh-lech")).toBeNull();
    expect((screen.getByLabelText("Tôi đã kiểm số và hiểu đây là bước một lần") as HTMLInputElement).disabled).toBe(true);
  });

  it("còn điều kiện tiên quyết chưa đạt ⇒ hiện lý do, không cho xác nhận", async () => {
    mo(["Còn mẫu chi định kỳ Nhập hàng đang chạy"]);
    expect(screen.getByTestId("bat-loi-dieu-kien").textContent).toContain("Nhập hàng");
    khaiBuoc1();
    fireEvent.click(screen.getByRole("button", { name: "Tính chênh lệch" }));
    await screen.findByTestId("bat-bang-chenh-lech");
    fireEvent.click(screen.getByLabelText("Tôi đã kiểm số và hiểu đây là bước một lần"));
    expect((screen.getByRole("button", { name: "Xác nhận bật theo dõi nợ phải trả" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("thiếu hồ sơ ví Shopee Ads ⇒ phải đánh dấu 'chưa theo dõi' mới xác nhận được, gửi kèm cờ", async () => {
    mo([], "Shopee Ads có chi phí 90 ngày gần nhất nhưng chưa có hồ sơ ví trả trước");
    expect(screen.getByTestId("bat-vi-chua-theo-doi").textContent).toContain("chưa có hồ sơ ví");
    khaiBuoc1();
    fireEvent.click(screen.getByRole("button", { name: "Tính chênh lệch" }));
    await screen.findByTestId("bat-bang-chenh-lech");
    fireEvent.click(screen.getByLabelText("Tôi đã kiểm số và hiểu đây là bước một lần"));
    const nutBat = screen.getByRole("button", { name: "Xác nhận bật theo dõi nợ phải trả" }) as HTMLButtonElement;
    expect(nutBat.disabled).toBe(true);
    fireEvent.click(screen.getByLabelText(/Shopee Ads nạp từ ví bán hàng hoặc chưa muốn theo dõi ví/));
    expect(nutBat.disabled).toBe(false);
    fireEvent.click(nutBat);
    await waitFor(() => expect(hanhDong.xacNhanBatNoPhaiTra).toHaveBeenCalledTimes(1));
    expect(hanhDong.xacNhanBatNoPhaiTra.mock.calls[0][0]).toMatchObject({ xacNhanViShopeeChuaTheoDoi: true });
  });

  it("đủ hồ sơ ví ⇒ không hiện ô xác nhận, cờ gửi false", async () => {
    mo();
    expect(screen.queryByTestId("bat-vi-chua-theo-doi")).toBeNull();
    khaiBuoc1();
    fireEvent.click(screen.getByRole("button", { name: "Tính chênh lệch" }));
    await screen.findByTestId("bat-bang-chenh-lech");
    fireEvent.click(screen.getByLabelText("Tôi đã kiểm số và hiểu đây là bước một lần"));
    fireEvent.click(screen.getByRole("button", { name: "Xác nhận bật theo dõi nợ phải trả" }));
    await waitFor(() => expect(hanhDong.xacNhanBatNoPhaiTra).toHaveBeenCalledTimes(1));
    expect(hanhDong.xacNhanBatNoPhaiTra.mock.calls[0][0]).toMatchObject({ xacNhanViShopeeChuaTheoDoi: false });
  });

  it("chọn 'Toàn bộ' khi còn phần chưa giải thích ⇒ thêm một dòng cho phần đó", async () => {
    hanhDong.docChenhLechTaiM.mockResolvedValue({
      ok: true,
      data: { ...ketQua, chenh: ketQua.chenh - tr(1), chuaGiaiThich: -tr(1) },
    });
    mo();
    khaiBuoc1();
    fireEvent.click(screen.getByRole("button", { name: "Tính chênh lệch" }));
    await screen.findByTestId("bat-chua-giai-thich");
    fireEvent.click(screen.getByLabelText(/Toàn bộ chênh lệch/));
    expect(screen.getAllByLabelText("Số tiền điều chỉnh")).toHaveLength(3);
  });
});
