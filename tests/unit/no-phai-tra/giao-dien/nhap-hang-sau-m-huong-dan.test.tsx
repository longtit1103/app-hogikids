// @vitest-environment jsdom
/**
 * Còn chi phí Nhập hàng ghi từ ngày bật trở đi (`CON_NHAP_HANG_SAU_M`): tab Xác nhận (wizard) và tab Chuẩn bị
 * (checklist) liệt kê TỪNG dòng (ngày · số tiền · mô tả) kèm link Sổ chi phí đúng ngày của dòng, ba trường hợp
 * xử lý theo thực tế và câu cảnh báo không đổi ngày để vượt cổng. Wizard không cho xác nhận khi còn dòng.
 */
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const hanhDong = vi.hoisted(() => ({ docChenhLechTaiM: vi.fn(), xacNhanBatNoPhaiTra: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {}, push: () => {}, replace: () => {} }) }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));
vi.mock("@/lib/actions/bat-no-phai-tra", () => hanhDong);

import { BatChecklist } from "@/components/no-phai-tra/bat-checklist";
import { XacNhanBatWizard } from "@/components/no-phai-tra/bat-xac-nhan-wizard";
import type { LoiDieuKienBat } from "@/lib/no-phai-tra/dieu-kien-bat-no-phai-tra";
import { tinhChenhLechTaiM } from "@/lib/no-phai-tra/tinh-chenh-lech-tai-m";

const duLieu = {
  khoaM: "2026-11-01",
  khoaHomNay: "2026-11-20",
  dong: [
    { id: "e1", khoaNgay: "2026-11-02", amount: 30_000_000, description: "Nhập hàng phiếu #9" },
    { id: "e2", khoaNgay: "2026-11-05", amount: 1_500_000, description: "Nhập lô áo" },
  ],
  soDongKhac: 3,
};

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function kiemKhoi(khoi: HTMLElement) {
  const links = within(khoi).getAllByRole("link");
  expect(links.map((a) => [a.textContent, a.getAttribute("href")])).toEqual([
    [expect.stringMatching(/^02\/11\/2026 · 30\.000\.000.* · Nhập hàng phiếu #9$/), "/tai-chinh?tab=so-chi-phi&tu=2026-11-02&den=2026-11-02"],
    [expect.stringMatching(/^05\/11\/2026 · 1\.500\.000.* · Nhập lô áo$/), "/tai-chinh?tab=so-chi-phi&tu=2026-11-05&den=2026-11-05"],
    ["và 3 dòng khác", "/tai-chinh?tab=so-chi-phi&tu=2026-11-01&den=2026-11-20"],
  ]);
  const chu = khoi.textContent ?? "";
  expect(chu).toContain("Ngày ghi nhầm (khoản thật diễn ra trước 01/11/2026) ⇒ sửa ngày về đúng ngày thật");
  expect(chu).toContain('Đã trả thật trong khoảng từ 01/11/2026 tới nay ⇒ xoá dòng chi phí; sau khi bật, ghi nhận phiếu vào sổ nợ và nhập "Đã trả ngay" đúng ngày trả');
  expect(chu).toContain("Chưa trả ⇒ xoá dòng chi phí; sau khi bật, ghi nhận phiếu vào sổ nợ không kèm trả");
  expect(chu).toContain("Không đổi ngày chỉ để vượt cổng — đổi ngày về trước mốc làm quỹ tháng trước và chênh lệch bước bật đổi theo");
}

describe("hướng dẫn chi phí Nhập hàng sau ngày bật", () => {
  it("tab Xác nhận: liệt kê từng dòng kèm link Sổ chi phí + 3 trường hợp; đủ bước vẫn không cho xác nhận", async () => {
    hanhDong.docChenhLechTaiM.mockResolvedValue({
      ok: true,
      data: {
        ...tinhChenhLechTaiM({ quyApp: 100, soDuBank: 100, tienMat: 0, duNoThauChi: 0, the: [], phieuY: [], viAds: [] }),
        ngayTruocM: "2026-10-31",
        tienDangGui: 0,
      },
    });
    render(
      <XacNhanBatWizard
        mocM="2026-11-01"
        nhanM="01/11/2026"
        ngayTruocM="2026-10-31"
        nhanTruocM="31/10/2026"
        the={[]}
        vi={[]}
        loiDieuKien={[]}
        nhapHangSauM={duLieu}
      />
    );
    const khoi = within(screen.getByTestId("bat-loi-dieu-kien")).getByTestId("nhap-hang-sau-m-huong-dan");
    kiemKhoi(khoi);
    fireEvent.change(screen.getByLabelText("Số dư ngân hàng"), { target: { value: "100" } });
    fireEvent.change(screen.getByLabelText("Tiền mặt"), { target: { value: "0" } });
    fireEvent.click(screen.getByRole("button", { name: "Tính chênh lệch" }));
    await screen.findByTestId("bat-bang-chenh-lech");
    fireEvent.click(screen.getByLabelText("Tôi đã kiểm số và hiểu đây là bước một lần"));
    expect((screen.getByRole("button", { name: "Xác nhận bật theo dõi nợ phải trả" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("tab Chuẩn bị: mục checklist hiện cùng khối hướng dẫn thay cho câu dài", () => {
    const loi: LoiDieuKienBat[] = [{ code: "CON_NHAP_HANG_SAU_M", message: "câu dài server", nhapHangSauM: duLieu }];
    render(<BatChecklist loi={loi} />);
    const khoi = screen.getByTestId("nhap-hang-sau-m-huong-dan");
    kiemKhoi(khoi);
    expect(screen.getByTestId("bat-checklist").textContent).not.toContain("câu dài server");
  });
});
