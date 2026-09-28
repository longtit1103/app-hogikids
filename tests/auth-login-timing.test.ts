import { beforeEach, describe, expect, it, vi } from "vitest";

// `@/lib/prisma` is mocked so this test never touches a real database — the
// point is to prove `login()`'s non-existent-email branch runs the full
// `verifyPassword` path (against the module-level dummy hash) and returns
// normally instead of short-circuiting or throwing, not to exercise Prisma.
vi.mock("@/lib/prisma", () => ({
  prisma: { user: { findFirst: vi.fn() } },
}));
// `createSession` ghi cookie (cần request scope, không có trong vitest) — mock để nhánh đăng nhập
// THÀNH CÔNG chạy được, và để soi đúng xem phiên có bị cấp oan hay không.
vi.mock("@/lib/session", () => ({
  createSession: vi.fn(async () => {}),
  destroySession: vi.fn(async () => {}),
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
    vi.mocked(prisma.user.findFirst).mockReset().mockResolvedValue(null);
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
  // safeParse, KHÔNG chạm tới prisma.findFirst/verifyPassword — và vẫn trả
  // đúng thông báo lỗi CHUNG (không lộ ra là do "quá dài").
  it("từ chối email vượt quá 254 ký tự ngay ở bước parse, không đụng DB", async () => {
    const oversizedEmail = `${"a".repeat(250)}@hogikids.test`; // > 254 ký tự
    const result = await login(buildLoginFormData(oversizedEmail, "bat-ky-mat-khau-nao"));

    expect(result).toEqual({ ok: false, error: GENERIC_ERROR });
    expect(prisma.user.findFirst).not.toHaveBeenCalled();
  });

  it("từ chối mật khẩu vượt quá 200 ký tự ngay ở bước parse, không đụng DB", async () => {
    const oversizedPassword = "a".repeat(201);
    const result = await login(buildLoginFormData(NON_EXISTENT_EMAIL, oversizedPassword));

    expect(result).toEqual({ ok: false, error: GENERIC_ERROR });
    expect(prisma.user.findFirst).not.toHaveBeenCalled();
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
    expect(prisma.user.findFirst).toHaveBeenCalledTimes(1);
  });

  // Hai ca dưới PHẢI dùng mật khẩu ĐÚNG mới phân biệt được: nếu đưa mật khẩu sai thì cả bản có
  // lỗi lẫn bản đã vá đều trả về cùng một lỗi chung ⇒ test xanh giả, không canh được gì (đã tự
  // kiểm bằng cách gỡ bản vá: bản test dùng mật khẩu sai vẫn xanh 7/7).
  const MAT_KHAU_DUNG = "matkhau-dung-1";

  it("email khớp nhờ KÝ TỰ ĐẠI DIỆN của ILIKE bị TỪ CHỐI, dù mật khẩu ĐÚNG", async () => {
    // `mode: "insensitive"` dịch ra ILIKE nên `_` khớp 1 ký tự bất kỳ — đo thật trên DB:
    // "_____@hogikids.test" trả về đúng tài khoản "admin@hogikids.test". Nhận kết quả đó thì:
    // (a) đăng nhập được bằng email KHÔNG có thật, và (b) nặng hơn — khoá lockout ghi theo CHUỖI
    // NGƯỜI DÙNG GÕ nên mỗi biến thể `_` là một bộ đếm riêng (local part n ký tự ⇒ 2^n bộ đếm,
    // mỗi cái 5 lượt sai) ⇒ chốt chống dò mật khẩu vô nghĩa.
    vi.mocked(prisma.user.findFirst).mockResolvedValue({
      id: "user-that",
      email: "admin@hogikids.test",
      passwordHash: await hashPassword(MAT_KHAU_DUNG),
    } as never);

    const result = await login(buildLoginFormData("_____@hogikids.test", MAT_KHAU_DUNG));

    expect(result).toEqual({ ok: false, error: GENERIC_ERROR });
    expect(createSession).not.toHaveBeenCalled();
    resetAttempts("_____@hogikids.test");
  });

  it("email chỉ khác HOA/THƯỜNG vẫn đăng nhập được (không vá quá tay)", async () => {
    // Đây mới là mục đích thật của `mode: "insensitive"` — vá lỗ ILIKE mà chặn luôn ca này thì
    // chủ shop gõ email viết hoa sẽ không vào được app.
    vi.mocked(prisma.user.findFirst).mockResolvedValue({
      id: "user-that",
      email: "Admin@Hogikids.test",
      passwordHash: await hashPassword(MAT_KHAU_DUNG),
    } as never);

    const result = await login(buildLoginFormData("ADMIN@hogikids.test", MAT_KHAU_DUNG));

    expect(result).toEqual({ ok: true, data: undefined });
    expect(createSession).toHaveBeenCalledWith("user-that", false);
    resetAttempts("admin@hogikids.test");
  });
});
