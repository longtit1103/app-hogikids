import { beforeEach, describe, expect, it, vi } from "vitest";

// `@/lib/prisma` is mocked so this test never touches a real database — the
// point is to prove `login()`'s non-existent-email branch runs the full
// `verifyPassword` path (against the module-level dummy hash) and returns
// normally instead of short-circuiting or throwing, not to exercise Prisma.
vi.mock("@/lib/prisma", () => ({
  prisma: {
    user: { findUnique: vi.fn(), update: vi.fn(async () => ({})) },
    // Ghi `lastLoginAt` + nhật ký sau khi đăng nhập thành công chạy trong một transaction.
    $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn({ user: { update: async () => ({}) } })),
  },
}));
// `createSession` ghi cookie (cần request scope, không có trong vitest) — mock để nhánh đăng nhập
// THÀNH CÔNG chạy được, và để soi đúng xem phiên có bị cấp oan hay không.
vi.mock("@/lib/session", () => ({
  createSession: vi.fn(async () => {}),
  destroySession: vi.fn(async () => {}),
}));
// Nhật ký đăng nhập (DB) không phải thứ bài này đo — prisma giả không có bảng `AuditLog`.
vi.mock("@/lib/nhat-ky/ghi-nhat-ky", () => ({
  ghiNhatKy: vi.fn(async () => undefined),
  ghiNhatKyLoi: vi.fn(async () => undefined),
}));

import { prisma } from "@/lib/prisma";
import { login } from "@/lib/actions/auth";
import { resetAttempts } from "@/lib/login-lockout";
import { hashPassword } from "@/lib/password";
import { createSession } from "@/lib/session";

const NON_EXISTENT_EMAIL = "khong-ton-tai-timing-test@hogikids.test";
const GENERIC_ERROR = "Email hoặc mật khẩu không đúng";

function buildLoginFormData(email: string, password: string): FormData {
  const formData = new FormData();
  formData.set("email", email);
  formData.set("password", password);
  return formData;
}

describe("login() — timing side-channel fix", () => {
  beforeEach(() => {
    resetAttempts(NON_EXISTENT_EMAIL);
    vi.mocked(prisma.user.findUnique).mockReset().mockResolvedValue(null);
    vi.mocked(createSession).mockClear();
  });

  it("runs the dummy-hash verify path for a non-existent email and returns the generic error", async () => {
    const result = await login(buildLoginFormData(NON_EXISTENT_EMAIL, "bat-ky-mat-khau-nao"));

    // Functional proof the dummy-hash path executed scrypt+compare and
    // returned false without throwing: had it thrown, this assertion would
    // fail with the rejection instead of matching the generic result.
    expect(result).toEqual({ ok: false, error: GENERIC_ERROR });
  });

  it("returns the exact same generic error shape regardless of password content", async () => {
    const result = await login(buildLoginFormData(NON_EXISTENT_EMAIL, ""));

    // Empty password fails zod's min(1) before reaching verifyPassword —
    // still must produce the identical generic message (no enumeration via
    // validation-vs-verify error shape either).
    expect(result).toEqual({ ok: false, error: GENERIC_ERROR });
  });

  // Chặn nhồi chuỗi khổng lồ vào scrypt (verifyPassword)/DB: email > 254 ký
  // tự (trần RFC 5321) hoặc mật khẩu > 200 ký tự phải rớt ngay ở bước
  // safeParse, KHÔNG chạm tới prisma.findUnique/verifyPassword — và vẫn trả
  // đúng thông báo lỗi CHUNG (không lộ ra là do "quá dài").
  it("từ chối email vượt quá 254 ký tự ngay ở bước parse, không đụng DB", async () => {
    const oversizedEmail = `${"a".repeat(250)}@hogikids.test`; // > 254 ký tự
    const result = await login(buildLoginFormData(oversizedEmail, "bat-ky-mat-khau-nao"));

    expect(result).toEqual({ ok: false, error: GENERIC_ERROR });
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
  });

  it("từ chối mật khẩu vượt quá 200 ký tự ngay ở bước parse, không đụng DB", async () => {
    const oversizedPassword = "a".repeat(201);
    const result = await login(buildLoginFormData(NON_EXISTENT_EMAIL, oversizedPassword));

    expect(result).toEqual({ ok: false, error: GENERIC_ERROR });
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
  });

  it("vẫn chấp nhận email/mật khẩu dài NHƯNG trong hạn (254/200 ký tự)", async () => {
    // Email 254 ký tự vừa khít hạn RFC 5321 vẫn phải qua được bước parse
    // (không tồn tại trong DB nên vẫn đi hết đường verifyPassword như bình
    // thường — chứng minh .max() không siết quá tay các giá trị hợp lệ).
    const localPart = "a".repeat(254 - "@hogikids.test".length);
    const boundaryEmail = `${localPart}@hogikids.test`;
    const boundaryPassword = "a".repeat(200);

    const result = await login(buildLoginFormData(boundaryEmail, boundaryPassword));

    expect(result).toEqual({ ok: false, error: GENERIC_ERROR });
    expect(prisma.user.findUnique).toHaveBeenCalledTimes(1);
  });

  // Hai ca dưới PHẢI dùng mật khẩu ĐÚNG mới phân biệt được: nếu đưa mật khẩu sai thì cả bản có
  // lỗi lẫn bản đã vá đều trả về cùng một lỗi chung ⇒ test xanh giả, không canh được gì (đã tự
  // kiểm bằng cách gỡ bản vá: bản test dùng mật khẩu sai vẫn xanh 7/7).
  const MAT_KHAU_DUNG = "matkhau-dung-1";

  it("tra email CHÍNH XÁC (không `mode: insensitive`/ILIKE) — `_` không là ký tự đại diện", async () => {
    // ILIKE coi `_` là ký tự đại diện: `kho_1@…` khớp cả `khoa1@…`, `findFirst` trả nhầm dòng ⇒ chủ
    // nhân thật bị báo sai rồi tự bị khoá tạm; mỗi biến thể `_` lại là một bộ đếm lockout riêng.
    // Chốt HÌNH DẠNG truy vấn: đúng một phép bằng trên email đã chuẩn hoá. Hành vi trên DB thật:
    // `tests/auth-login-tai-khoan-khoa.integration.test.ts`.
    const result = await login(buildLoginFormData("_____@hogikids.test", MAT_KHAU_DUNG));

    expect(result).toEqual({ ok: false, error: GENERIC_ERROR });
    expect(prisma.user.findUnique).toHaveBeenCalledWith({ where: { email: "_____@hogikids.test" } });
    expect(createSession).not.toHaveBeenCalled();
    resetAttempts("_____@hogikids.test");
  });

  it("email chỉ khác HOA/THƯỜNG vẫn đăng nhập được (không vá quá tay)", async () => {
    // Email lưu dạng chuẩn hoá; email GÕ được chuẩn hoá trước khi tra — chủ shop gõ viết hoa vẫn vào.
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      id: "user-that",
      email: "admin@hogikids.test",
      passwordHash: await hashPassword(MAT_KHAU_DUNG),
      sessionEpoch: "e".repeat(32),
      isActive: true,
    } as never);

    const result = await login(buildLoginFormData("ADMIN@hogikids.test", MAT_KHAU_DUNG));

    expect(result).toEqual({ ok: true, data: undefined });
    expect(prisma.user.findUnique).toHaveBeenCalledWith({ where: { email: "admin@hogikids.test" } });
    // Cookie mang epoch của ĐÚNG dòng vừa so hash — không đọc lại DB.
    expect(createSession).toHaveBeenCalledWith("user-that", false, "e".repeat(32));
    resetAttempts("admin@hogikids.test");
  });
});
