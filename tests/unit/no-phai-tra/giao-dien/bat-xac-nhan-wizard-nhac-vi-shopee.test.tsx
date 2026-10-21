// @vitest-environment jsdom
/**
 * Màn xác nhận bật: nhắc ví Shopee chưa phủ tới ngày bật là cảnh báo vàng KHÔNG chặn — không nằm trong khối đỏ
 * "Chưa bật được" và không làm tắt nút bật.
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const hanhDong = vi.hoisted(() => ({ docChenhLechTaiM: vi.fn(), xacNhanBatNoPhaiTra: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {}, push: () => {}, replace: () => {} }) }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));
vi.mock("@/lib/actions/bat-no-phai-tra", () => hanhDong);

import { XacNhanBatWizard } from "@/components/no-phai-tra/bat-xac-nhan-wizard";

afterEach(() => cleanup());

const CAU_NHAC = "Dữ liệu ví Shopee mới tới 28/10 — không chặn bật.";

function mo(nhac: string[], loiDieuKien: string[] = []) {
  render(
    <XacNhanBatWizard
      mocM="2026-11-01"
      nhanM="01/11/2026"
      ngayTruocM="2026-10-31"
      nhanTruocM="31/10/2026"
      the={[]}
      vi={[]}
      loiDieuKien={loiDieuKien}
      nhac={nhac}
    />
  );
}

describe("XacNhanBatWizard — nhắc ví Shopee", () => {
  it("có nhắc ⇒ khối vàng, không có khối đỏ 'Chưa bật được'", () => {
    mo([CAU_NHAC]);
    const khoi = screen.getByTestId("bat-nhac-truoc-bat");
    expect(khoi.textContent).toContain(CAU_NHAC);
    expect(khoi.className).toContain("border-warning");
    expect(screen.queryByTestId("bat-loi-dieu-kien")).toBeNull();
  });

  it("không nhắc ⇒ không hiện khối", () => {
    mo([]);
    expect(screen.queryByTestId("bat-nhac-truoc-bat")).toBeNull();
  });

  it("nhắc nằm riêng khỏi lỗi chặn: còn lỗi chặn thật ⇒ khối đỏ chỉ chứa lỗi, nhắc vẫn ở khối vàng", () => {
    mo([CAU_NHAC], ["Còn mẫu chi định kỳ Nhập hàng đang chạy"]);
    expect(screen.getByTestId("bat-loi-dieu-kien").textContent).not.toContain("ví Shopee");
    expect(screen.getByTestId("bat-nhac-truoc-bat").textContent).toContain("ví Shopee");
  });
});
