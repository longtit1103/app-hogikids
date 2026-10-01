// @vitest-environment jsdom
/**
 * Form đổi mật khẩu lần đầu: lỗi action PHẢI hiện (toast + gắn ô), không nuốt im; thành công chuyển về "/";
 * phiên đã đổi ở nơi khác (TRANG_THAI_DA_DOI) thì bỏ form, chỉ còn đường đăng nhập lại.
 */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const toast = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn() }));
const router = vi.hoisted(() => ({ replace: vi.fn(), refresh: vi.fn(), push: vi.fn() }));
const doiMatKhauLanDau = vi.hoisted(() => vi.fn());
vi.mock("sonner", () => ({ toast }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));
vi.mock("@/lib/actions/doi-mat-khau-lan-dau", () => ({ doiMatKhauLanDau }));
vi.mock("@/lib/actions/auth", () => ({ logout: vi.fn(async () => ({ ok: true, data: undefined })) }));

import { DoiMatKhauLanDauForm } from "@/components/auth/doi-mat-khau-lan-dau-form";

async function nhapVaGui() {
  render(<DoiMatKhauLanDauForm email="nv@hogikids.test" />);
  fireEvent.change(screen.getByLabelText("Mật khẩu mới"), { target: { value: "matkhau12345" } });
  fireEvent.change(screen.getByLabelText("Nhập lại mật khẩu mới"), { target: { value: "matkhau12345" } });
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Đổi mật khẩu" }));
  });
}

beforeEach(() => {
  toast.error.mockClear();
  router.replace.mockClear();
  doiMatKhauLanDau.mockReset();
});
afterEach(cleanup);

describe("DoiMatKhauLanDauForm", () => {
  it("thành công ⇒ router.replace('/')", async () => {
    doiMatKhauLanDau.mockResolvedValue({ ok: true, data: undefined });
    await nhapVaGui();
    expect(router.replace).toHaveBeenCalledWith("/");
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("lỗi theo ô ⇒ toast + câu lỗi dưới đúng ô, ở lại form", async () => {
    doiMatKhauLanDau.mockResolvedValue({ ok: false, error: "Mật khẩu mới phải có cả chữ và số", field: "newPassword" });
    await nhapVaGui();
    expect(toast.error).toHaveBeenCalledWith("Mật khẩu mới phải có cả chữ và số");
    expect(screen.getByText("Mật khẩu mới phải có cả chữ và số")).toBeTruthy();
    expect(router.replace).not.toHaveBeenCalled();
  });

  it("TRANG_THAI_DA_DOI ⇒ toast + link đăng nhập lại, không còn form", async () => {
    doiMatKhauLanDau.mockResolvedValue({ ok: false, error: "Phiên đã đổi", code: "TRANG_THAI_DA_DOI" });
    await nhapVaGui();
    expect(toast.error).toHaveBeenCalledWith("Phiên đã đổi");
    expect(screen.getByRole("link", { name: "Đăng nhập lại" }).getAttribute("href")).toBe("/dang-nhap");
    expect(screen.queryByLabelText("Mật khẩu mới")).toBeNull();
  });

  it("action ném ⇒ toast, không nuốt im", async () => {
    doiMatKhauLanDau.mockRejectedValue(new Error("mạng"));
    await nhapVaGui();
    expect(toast.error).toHaveBeenCalledTimes(1);
  });
});
