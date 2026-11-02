// @vitest-environment jsdom
/**
 * Ô tiền của các form phụ báo đỏ NGAY tại ô khi gõ vượt trần 2.147.483.647 (Prisma `Int`) và khoá nút
 * ghi — trước đây các form này im lặng cho gõ rồi chỉ action từ chối. Cổng thật vẫn ở action.
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: () => {}, replace: () => {}, push: () => {} }),
}));
vi.mock("sonner", () => ({ toast: { success: () => {}, error: () => {}, info: () => {} } }));
vi.mock("@/lib/actions/so-quy-quy-toi-thieu", () => ({ datQuyToiThieu: vi.fn() }));
vi.mock("@/lib/actions/tra-tien-hang", () => ({ traTienHangGop: vi.fn() }));

import { LoiVuotTranTien } from "@/components/ui/loi-vuot-tran-tien";
import { SoQuyQuyToiThieuForm } from "@/components/finance/so-quy-quy-toi-thieu-form";
import { buoc1HopLe, khaiTheMacDinh } from "@/components/no-phai-tra/bat-buoc-khai-the-vi";
import { TraTienHangFormModal } from "@/components/no-phai-tra/tra-tien-hang-form-modal";
import { MAX_AMOUNT_INPUT } from "@/lib/format-amount-input";

afterEach(cleanup);

const BA_TY = "3000000000";

describe("LoiVuotTranTien", () => {
  it("vượt trần ⇒ dòng đỏ; bằng trần hoặc trống ⇒ không hiện gì", () => {
    const { rerender } = render(<LoiVuotTranTien value={MAX_AMOUNT_INPUT + 1} />);
    expect(screen.getByTestId("loi-vuot-tran-tien").textContent).toContain("Số tiền tối đa");
    rerender(<LoiVuotTranTien value={MAX_AMOUNT_INPUT} />);
    expect(screen.queryByTestId("loi-vuot-tran-tien")).toBeNull();
    rerender(<LoiVuotTranTien value={null} />);
    expect(screen.queryByTestId("loi-vuot-tran-tien")).toBeNull();
  });
});

describe("Quỹ tối thiểu", () => {
  it("gõ 3 tỷ ⇒ báo đỏ tại ô và nút Lưu bị khoá", () => {
    render(<SoQuyQuyToiThieuForm nguong={0} nguongDaDat={false} choPhepSua />);
    fireEvent.click(screen.getByTestId("so-quy-quy-toi-thieu-sua"));
    fireEvent.change(screen.getByTestId("so-quy-quy-toi-thieu-input"), { target: { value: BA_TY } });
    expect(screen.getByTestId("so-quy-quy-toi-thieu-error").textContent).toContain("Số tiền tối đa");
    expect((screen.getByRole("button", { name: /^Lưu$/ }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("Bước 1 bật theo dõi nợ", () => {
  const the = [{ id: "t1", ten: "Visa", saoKeNgayChot: "2026-09-25", saoKeHanTra: "2026-10-15" }];

  it("dư nợ trong trần ⇒ hợp lệ; vượt trần ⇒ chưa xong bước", () => {
    const khai = { t1: { ...khaiTheMacDinh(the[0]), coSaoKe: false, duNo: 1_000_000 } };
    expect(buoc1HopLe(the, khai, [], {})).toBe(true);
    const vuot = { t1: { ...khai.t1, duNo: MAX_AMOUNT_INPUT + 1 } };
    expect(buoc1HopLe(the, vuot, [], {})).toBe(false);
  });

  it("số dư ví vượt trần ⇒ chưa xong bước", () => {
    const khai = { t1: { ...khaiTheMacDinh(the[0]), coSaoKe: false, duNo: 0 } };
    expect(buoc1HopLe(the, khai, [{ id: "v1", nhan: "Ví" }], { v1: MAX_AMOUNT_INPUT })).toBe(true);
    expect(buoc1HopLe(the, khai, [{ id: "v1", nhan: "Ví" }], { v1: MAX_AMOUNT_INPUT + 1 })).toBe(false);
  });
});

describe("Trả tiền hàng nhà cung cấp", () => {
  const phieu = [
    { id: "p1", maPhieu: "PN1", ngayPhieu: new Date("2026-10-01T00:00:00+07:00"), conNo: 5_000_000, daHuy: false },
  ];

  it("gõ tổng 3 tỷ ⇒ báo đỏ tại ô tổng và nút Ghi khoá", () => {
    render(
      <TraTienHangFormModal
        open
        onOpenChange={() => {}}
        phieu={phieu as unknown as Parameters<typeof TraTienHangFormModal>[0]["phieu"]}
        vanTay="x"
        mocM="2026-10-01"
      />,
    );
    fireEvent.change(document.getElementById("tra-hang-tong") as HTMLInputElement, { target: { value: BA_TY } });
    expect(screen.getAllByTestId("loi-vuot-tran-tien").length).toBeGreaterThan(0);
    const nutGhi = screen.getAllByRole("button").find((b) => /ghi/i.test(b.textContent ?? "")) as HTMLButtonElement;
    expect(nutGhi.disabled).toBe(true);
  });
});
