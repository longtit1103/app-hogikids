import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Chốt bộ đếm khoá của màn Đổi mật khẩu TÁCH KHỎI bộ đếm màn Đăng nhập (namespace riêng, xem
 * `khoaDoiMatKhau` ở `@/lib/actions/security`). Trước bản vá này cả hai action cùng gọi
 * `login-lockout.ts` bằng `user.email` THẬT, nên sai mật khẩu HIỆN TẠI 5 lần ở Cài đặt khoá LUÔN
 * màn Đăng nhập.
 *
 * CỐ Ý KHÔNG mock `@/lib/login-lockout` / `@/lib/login-gate` (khác `tests/change-password.test.ts`)
 * — bài test này cần bộ đếm THẬT để chứng minh hai namespace không đụng nhau, không phải chỉ kiểm
 * tham số truyền vào một hàm giả.
 */
vi.mock("@/lib/session", () => ({
  requireUser: vi.fn(async () => "chu-shop"),
  docGhiNhoCuaPhien: vi.fn(async () => true),
  thuHoiMoiPhien: vi.fn(async () => undefined),
  createSession: vi.fn(async () => undefined),
}));
vi.mock("@/lib/prisma", () => {
  const prisma = {
    user: { findUnique: vi.fn(), findFirst: vi.fn(), update: vi.fn() },
    $transaction: vi.fn(),
  };
  prisma.$transaction.mockImplementation(async (fn: (tx: unknown) => unknown) => fn(prisma));
  return { prisma };
});
vi.mock("@/lib/password", async (importActual) => ({
  ...(await importActual<typeof import("@/lib/password")>()),
  verifyPassword: vi.fn(),
  hashPassword: vi.fn(async () => "hashed-new"),
}));

import { login } from "@/lib/actions/auth";
import { changePassword } from "@/lib/actions/security";
import { getLockoutSecondsRemaining, resetAttempts } from "@/lib/login-lockout";
import { verifyPassword } from "@/lib/password";
import { prisma } from "@/lib/prisma";

const EMAIL = "tach-namespace-khoa@hogikids.test";
const KHOA_DOI_MK = `doimatkhau:${EMAIL}`;
const USER = { id: "chu-shop", email: EMAIL, passwordHash: "hash-current" };

function formDoiMk(current: string, next: string): FormData {
  const fd = new FormData();
  fd.set("currentPassword", current);
  fd.set("newPassword", next);
  fd.set("confirmPassword", next);
  return fd;
}

function formLogin(password: string): FormData {
  const fd = new FormData();
  fd.set("email", EMAIL);
  fd.set("password", password);
  return fd;
}

describe("khoá đổi-mật-khẩu và khoá đăng-nhập KHÔNG chung bộ đếm", () => {
  beforeEach(() => {
    resetAttempts(EMAIL);
    resetAttempts(KHOA_DOI_MK);
    vi.mocked(prisma.user.findUnique).mockReset().mockResolvedValue(USER as never);
    vi.mocked(prisma.user.findFirst).mockReset().mockResolvedValue(USER as never);
    vi.mocked(prisma.user.update).mockReset().mockResolvedValue(USER as never);
    vi.mocked(verifyPassword).mockReset();
  });

  it("sai mật khẩu HIỆN TẠI 5 lần ở Đổi mật khẩu → chỉ khoá namespace đổi mật khẩu, KHÔNG khoá đăng nhập", async () => {
    vi.mocked(verifyPassword).mockResolvedValue(false);

    for (let i = 0; i < 5; i += 1) {
      const r = await changePassword(formDoiMk("sai-hien-tai", "new123456789"));
      expect(r.ok).toBe(false);
    }

    // Namespace đổi-mật-khẩu đã khoá.
    expect(getLockoutSecondsRemaining(KHOA_DOI_MK)).toBeGreaterThan(0);
    // Namespace đăng nhập (khoá theo email thật, KHÔNG tiền tố) vẫn nguyên vẹn.
    expect(getLockoutSecondsRemaining(EMAIL)).toBe(0);

    // Bằng chứng hành vi thật, không chỉ đọc bộ đếm: đăng nhập bằng mật khẩu ĐÚNG vẫn vào được
    // ngay sau khi Đổi mật khẩu vừa bị khoá — nếu còn dùng chung bộ đếm thì lượt này sẽ nhận
    // `code: "LOCKED"` dù mật khẩu đúng.
    vi.mocked(verifyPassword).mockResolvedValue(true);
    const rLogin = await login(formLogin("mat-khau-dung"));
    expect(rLogin).toEqual({ ok: true, data: undefined });
  });

  it("khoá đăng nhập (5 lần sai email/mật khẩu) KHÔNG khoá namespace đổi mật khẩu", async () => {
    vi.mocked(verifyPassword).mockResolvedValue(false);

    for (let i = 0; i < 5; i += 1) {
      const r = await login(formLogin("sai-mat-khau"));
      expect(r.ok).toBe(false);
    }

    expect(getLockoutSecondsRemaining(EMAIL)).toBeGreaterThan(0);
    // Namespace đổi-mật-khẩu vẫn mở — lượt kiểm mật khẩu hiện tại ở Cài đặt KHÔNG bị chặn bởi
    // lockout, dù đăng nhập đang khoá (chỉ verifyPassword trả false mới khiến nó thất bại).
    expect(getLockoutSecondsRemaining(KHOA_DOI_MK)).toBe(0);

    vi.mocked(verifyPassword).mockResolvedValue(true);
    const rDoiMk = await changePassword(formDoiMk("mat-khau-dung", "new123456789"));
    expect(rDoiMk).toEqual({ ok: true, data: undefined });
  });
});
