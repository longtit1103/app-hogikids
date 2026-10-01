// @vitest-environment jsdom
/**
 * Mật khẩu tạm KHÔNG được sống lâu hơn hộp thoại tạo tài khoản / đặt lại mật khẩu:
 * - đang chờ server thì không đóng được (Esc) và nút Huỷ bị vô hiệu ⇒ kết quả về vẫn hiện đúng một lượt;
 * - mở lại lần sau không thấy mật khẩu của tài khoản trước, form trống;
 * - kết quả về SAU khi component đã unmount bị bỏ (không toast, không state);
 * - server trả lỗi tên hiển thị ⇒ UI hiện lỗi ở ô tên.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const toast = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn() }));
const router = vi.hoisted(() => ({ replace: vi.fn(), refresh: vi.fn(), push: vi.fn() }));
const taoTaiKhoan = vi.hoisted(() => vi.fn());
const datLaiMatKhau = vi.hoisted(() => vi.fn());
vi.mock("sonner", () => ({ toast }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));
vi.mock("@/lib/actions/tai-khoan", () => ({ taoTaiKhoan, datLaiMatKhau }));

import { DialogDatLaiMatKhau } from "@/components/quan-tri/dialog-dat-lai-mat-khau";
import { ModalTaoTaiKhoan } from "@/components/quan-tri/modal-tao-tai-khoan";

/** Promise điều khiển tay: cho phép "server" trả lời đúng lúc test muốn. */
function hoanTraTay<T>() {
  let giaiQuyet!: (v: T) => void;
  const p = new Promise<T>((r) => {
    giaiQuyet = r;
  });
  return { p, giaiQuyet };
}

const MK_A = "MatKhauTamCuaTaiKhoanA";

beforeEach(() => {
  toast.error.mockClear();
  router.refresh.mockClear();
  taoTaiKhoan.mockReset();
  datLaiMatKhau.mockReset();
});
afterEach(cleanup);

async function moVaDienForm(email = "a@hogikids.test", ten = "Nhân viên A") {
  fireEvent.click(screen.getByRole("button", { name: "Tạo tài khoản" }));
  fireEvent.change(await screen.findByLabelText("Email"), { target: { value: email } });
  fireEvent.change(screen.getByLabelText("Tên hiển thị"), { target: { value: ten } });
}
const nutGui = () =>
  screen.getAllByRole("button", { name: /Tạo tài khoản|Đang tạo/ }).find((b) => b.getAttribute("type") === "submit")!;

describe("ModalTaoTaiKhoan", () => {
  it("Esc lúc đang chờ server không đóng; kết quả về hiện mật khẩu; đóng xong mở lại ⇒ không còn mật khẩu, form trống", async () => {
    const cho = hoanTraTay<unknown>();
    taoTaiKhoan.mockReturnValueOnce(cho.p);
    render(<ModalTaoTaiKhoan />);
    await moVaDienForm();
    await act(async () => {
      fireEvent.click(nutGui());
    });
    expect(nutGui().textContent).toContain("Đang tạo");

    // Đang chờ: Esc bị bỏ qua — hộp thoại vẫn mở, form vẫn còn.
    await act(async () => {
      fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape", code: "Escape" });
    });
    expect(screen.getByLabelText("Email")).toBeTruthy();

    await act(async () => {
      cho.giaiQuyet({ ok: true, data: { id: "u1", matKhauTam: MK_A } });
    });
    expect((await screen.findByTestId("mat-khau-tam-gia-tri")).textContent).toBe(MK_A);

    fireEvent.click(screen.getByRole("button", { name: "Đã lưu, đóng" }));
    expect(router.refresh).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.queryByTestId("mat-khau-tam-gia-tri")).toBeNull());

    // Mở lần sau: không thấy mật khẩu của tài khoản trước, form rỗng.
    fireEvent.click(screen.getByRole("button", { name: "Tạo tài khoản" }));
    expect(((await screen.findByLabelText("Email")) as HTMLInputElement).value).toBe("");
    expect(screen.queryByTestId("mat-khau-tam-gia-tri")).toBeNull();
    expect(document.body.textContent).not.toContain(MK_A);
  });

  it("kết quả về sau khi đã unmount ⇒ bỏ (không toast); tài khoản đã tạo thì làm mới bảng", async () => {
    const cho = hoanTraTay<unknown>();
    taoTaiKhoan.mockReturnValueOnce(cho.p);
    const { unmount } = render(<ModalTaoTaiKhoan />);
    await moVaDienForm();
    await act(async () => {
      fireEvent.click(nutGui());
    });
    unmount();
    await act(async () => {
      cho.giaiQuyet({ ok: true, data: { id: "u1", matKhauTam: MK_A } });
    });
    expect(toast.error).not.toHaveBeenCalled();
    expect(router.refresh).toHaveBeenCalledTimes(1);
    expect(document.body.textContent).not.toContain(MK_A);
  });

  it("tên hiển thị chỉ khoảng trắng ⇒ nút gửi bị khoá; server trả lỗi field tenHienThi ⇒ hiện dưới ô tên", async () => {
    taoTaiKhoan.mockResolvedValueOnce({ ok: false, error: "Nhập tên hiển thị", field: "tenHienThi" });
    render(<ModalTaoTaiKhoan />);
    await moVaDienForm("b@hogikids.test", "   ");
    expect((nutGui() as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(screen.getByLabelText("Tên hiển thị"), { target: { value: "B" } });
    await act(async () => {
      fireEvent.click(nutGui());
    });
    expect(await screen.findByText("Nhập tên hiển thị")).toBeTruthy();
    expect(toast.error).toHaveBeenCalledWith("Nhập tên hiển thị");
  });
});

describe("DialogDatLaiMatKhau", () => {
  it("đang chờ: Huỷ bị vô hiệu, Esc không đóng; kết quả về hiện mật khẩu đúng một lần", async () => {
    const cho = hoanTraTay<unknown>();
    datLaiMatKhau.mockReturnValueOnce(cho.p);
    const onDong = vi.fn();
    render(<DialogDatLaiMatKhau id="u1" email="a@hogikids.test" mo onDong={onDong} />);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Đặt lại mật khẩu" }));
    });
    expect((screen.getByRole("button", { name: "Huỷ" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Huỷ" }));
    await act(async () => {
      fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape", code: "Escape" });
    });
    expect(onDong).not.toHaveBeenCalled();

    await act(async () => {
      cho.giaiQuyet({ ok: true, data: { matKhauTam: MK_A } });
    });
    expect((await screen.findByTestId("mat-khau-tam-gia-tri")).textContent).toBe(MK_A);

    fireEvent.click(screen.getByRole("button", { name: "Đã lưu, đóng" }));
    expect(onDong).toHaveBeenCalledTimes(1);
    expect(router.refresh).toHaveBeenCalledTimes(1);
  });

  it("kết quả về sau khi unmount ⇒ bỏ, không toast", async () => {
    const cho = hoanTraTay<unknown>();
    datLaiMatKhau.mockReturnValueOnce(cho.p);
    const { unmount } = render(<DialogDatLaiMatKhau id="u1" email="a@hogikids.test" mo onDong={vi.fn()} />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Đặt lại mật khẩu" }));
    });
    unmount();
    await act(async () => {
      cho.giaiQuyet({ ok: false, error: "lỗi muộn" });
    });
    expect(toast.error).not.toHaveBeenCalled();
  });
});
