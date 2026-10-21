// @vitest-environment jsdom
/**
 * Dialog "Xóa dữ liệu giao dịch" phải liệt kê ĐỦ những gì `deleteAllData` xoá (nợ phải trả, mốc bật,
 * thùng rác, bản chốt số dư…) và — khi Nợ phải trả đang bật — cảnh báo đỏ rằng lượt xoá TẮT nó.
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
vi.mock("@/components/settings/backup-button", () => ({ BackupButton: () => null }));
// Server action kéo theo prisma — không thuộc thứ cần đo ở đây.
vi.mock("@/lib/actions/data-admin", () => ({ deleteAllData: vi.fn() }));

import { DeleteAllDialog } from "@/components/settings/delete-all-dialog";

afterEach(cleanup);

const CHI_PHI = {
  soChiPhi: 0,
  tongChiPhi: 0,
  soDinhKy: 0,
  soKhoanTienKhac: 0,
  tongKhoanTienKhac: 0,
  soKhoanVay: 0,
  soSoTietKiem: 0,
  tongThuNhap: 0,
};

function moDialog(noPhaiTraDangBat: boolean) {
  render(
    <DeleteAllDialog
      hasData
      shopName="HogiKids"
      donMoCoi={{ soDon: 0, tongTien: 0 }}
      chiPhi={CHI_PHI}
      adsMoCoi={{ soDong: 0, tongTien: 0 }}
      noPhaiTraDangBat={noPhaiTraDangBat}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Xóa dữ liệu giao dịch" }));
}

describe("DeleteAllDialog — danh sách xoá + cảnh báo Nợ phải trả", () => {
  it("liệt kê khối Nợ phải trả, mốc bật, thùng rác, bản chốt số dư", () => {
    moDialog(false);
    const muc = screen.getAllByRole("listitem").map((li) => li.textContent ?? "");
    expect(muc.some((t) => t.includes("Nợ phải trả") && t.includes("thẻ tín dụng") && t.includes("phiếu nhập"))).toBe(true);
    expect(muc.some((t) => t.includes("Mốc bật Nợ phải trả"))).toBe(true);
    expect(muc.some((t) => t.includes("thùng rác"))).toBe(true);
    expect(muc.some((t) => t.includes("bản chốt số dư"))).toBe(true);
  });

  it("Nợ phải trả đang bật → cảnh báo đỏ nói rõ sẽ TẮT và mất thiết lập mở sổ", () => {
    moDialog(true);
    const canhBao = screen.getByRole("alert");
    expect(canhBao.textContent).toContain("đang BẬT");
    expect(canhBao.textContent).toContain("TẮT");
    expect(canhBao.className).toContain("text-error");
  });

  it("Nợ phải trả chưa bật → không có cảnh báo đó", () => {
    moDialog(false);
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
