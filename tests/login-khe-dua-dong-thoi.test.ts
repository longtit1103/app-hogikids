import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Chốt KHE ĐUA của luồng đăng nhập.
 *
 * Chốt 5-lần-sai/60-giây là chuỗi đọc-rồi-ghi vắt qua hai lệnh `await` (tra DB, so mật khẩu
 * ~36ms): đọc trạng thái khoá ở đầu, ghi lượt sai ở cuối. Không nối tiếp thì mọi request bắn
 * song song đều đọc "chưa khoá" trước khi lượt đầu tiên kịp ghi — đo trước khi vá: 1000 request
 * đồng thời cho 1000 lượt đoán mật khẩu, 0 bị chặn, tức vượt 200 lần mức thiết kế.
 *
 * `verifyPassword` được bọc SPY quanh bản THẬT (không thay bằng hàm giả): số lần gọi chính là số
 * lượt đoán mật khẩu mà kẻ tấn công thực sự mua được — thước đo trực tiếp của lỗ hổng.
 */
vi.mock("@/lib/prisma", () => ({
  prisma: { user: { findFirst: vi.fn() } },
}));
vi.mock("@/lib/session", () => ({
  createSession: vi.fn(async () => {}),
  destroySession: vi.fn(async () => {}),
}));
vi.mock("@/lib/password", async (importActual) => {
  const that = await importActual<typeof import("@/lib/password")>();
  return { ...that, verifyPassword: vi.fn(that.verifyPassword) };
});

import { login } from "@/lib/actions/auth";
import { demEmailDangCoLuot } from "@/lib/login-gate";
import { getLockoutSecondsRemaining, resetAttempts } from "@/lib/login-lockout";
import { hashPassword, verifyPassword } from "@/lib/password";
import { prisma } from "@/lib/prisma";
import { createSession } from "@/lib/session";

/** Bản THẬT của `verifyPassword` — mặc định mọi ca đều chạy scrypt thật. */
const { verifyPassword: verifyPasswordThat } =
  await vi.importActual<typeof import("@/lib/password")>("@/lib/password");

const EMAIL = "khe-dua@hogikids.test";
const MAT_KHAU_DUNG = "matkhau-dung-1";
const MAT_KHAU_SAI = "matkhau-sai-9";
const LOI_CHUNG = "Email hoặc mật khẩu không đúng";

function form(password: string, email: string = EMAIL): FormData {
  const fd = new FormData();
  fd.set("email", email);
  fd.set("password", password);
  return fd;
}

let hashThat: string;

describe("login() — khe đua giữa lúc đọc khoá và lúc ghi lượt sai", () => {
  beforeEach(async () => {
    resetAttempts(EMAIL);
    vi.mocked(verifyPassword).mockClear().mockImplementation(verifyPasswordThat);
    vi.mocked(createSession).mockClear();
    hashThat ??= await hashPassword(MAT_KHAU_DUNG);
    vi.mocked(prisma.user.findFirst)
      .mockReset()
      .mockResolvedValue({ id: "chu-shop", email: EMAIL, passwordHash: hashThat } as never);
  });

  it("1000 request ĐỒNG THỜI chỉ mua được tối đa 5 lượt đoán mật khẩu", async () => {
    // CỐ Ý thay scrypt bằng phép so nhanh CHỈ ở ca này. Không phải để né chi phí: nếu để scrypt
    // thật thì bản KHÔNG có cổng sẽ chạy 1000 lượt × ~36ms ⇒ test đỏ vì HẾT GIỜ, một tín hiệu dễ
    // lẫn với "máy chậm". Với phép so nhanh, bản không có cổng đỏ bằng đúng con số nó mua được
    // (1000 > 5) — đó mới là thứ cần chốt. Các ca khác vẫn chạy scrypt thật.
    vi.mocked(verifyPassword).mockImplementation(async (plain) => plain === MAT_KHAU_DUNG);

    const ketQua = await Promise.all(Array.from({ length: 1000 }, () => login(form(MAT_KHAU_SAI))));

    // Thước đo thẳng của lỗ hổng: bao nhiêu lượt thật sự chạm tới phép so mật khẩu.
    // Chốt ĐÚNG BẰNG 5, không phải "≤ 5": trần lỏng cũng xanh khi cổng chặn quá tay (vd chỉ cho
    // 1 lượt qua), mà chặn quá tay chính là biến chốt bảo vệ thành chỗ nghẽn. Con số 5 là tất
    // định: 5 chỗ trong hàng đợi được nhận đồng bộ theo thứ tự, mỗi chỗ chạy đúng một lượt so
    // mật khẩu, và tới lượt thứ 5 tài khoản mới bị khoá.
    expect(vi.mocked(verifyPassword).mock.calls.length).toBe(5);
    expect(ketQua.every((r) => !r.ok)).toBe(true);
    expect(vi.mocked(createSession)).not.toHaveBeenCalled();
    // Hàng đợi trả sạch chỗ, không tích mục rỗng.
    expect(demEmailDangCoLuot()).toBe(0);
  });

  it("lượt thứ 5 VẪN được xác thực, lượt thứ 6 bị chặn (đúng ngữ nghĩa 5 lần thất bại)", async () => {
    for (let i = 0; i < 5; i += 1) {
      const r = await login(form(MAT_KHAU_SAI));
      expect(r).toEqual({ ok: false, error: LOI_CHUNG });
    }
    expect(vi.mocked(verifyPassword).mock.calls.length).toBe(5);

    const thu6 = await login(form(MAT_KHAU_SAI));
    expect(thu6.ok).toBe(false);
    if (thu6.ok) return;
    expect(thu6.code).toBe("LOCKED");
    // Lượt thứ 6 KHÔNG được chạm tới phép so mật khẩu.
    expect(vi.mocked(verifyPassword).mock.calls.length).toBe(5);
  });

  it("4 lần sai rồi lần thứ 5 ĐÚNG vẫn đăng nhập được và xoá sạch bộ đếm", async () => {
    for (let i = 0; i < 4; i += 1) {
      await login(form(MAT_KHAU_SAI));
    }

    const r = await login(form(MAT_KHAU_DUNG));

    expect(r).toEqual({ ok: true, data: undefined });
    expect(vi.mocked(createSession)).toHaveBeenCalledWith("chu-shop", false);
    expect(getLockoutSecondsRemaining(EMAIL)).toBe(0);
    // Bộ đếm đã xoá thật: 5 lượt sai kế tiếp mới lại đủ khoá, không phải 1.
    for (let i = 0; i < 4; i += 1) {
      await login(form(MAT_KHAU_SAI));
    }
    expect(getLockoutSecondsRemaining(EMAIL)).toBe(0);
  });

  it("lỗi DB không làm kẹt hàng đợi và KHÔNG bị tính là sai mật khẩu", async () => {
    vi.mocked(prisma.user.findFirst).mockRejectedValueOnce(new Error("mất kết nối DB"));

    await expect(login(form(MAT_KHAU_SAI))).rejects.toThrow("mất kết nối DB");

    // Hàng đợi trả chỗ trong `finally` — không kẹt vĩnh viễn sau một lượt ném lỗi.
    expect(demEmailDangCoLuot()).toBe(0);

    // Lượt lỗi KHÔNG được tính là một lần sai: vẫn phải đủ 5 lần sai THẬT mới khoá.
    for (let i = 0; i < 4; i += 1) {
      await login(form(MAT_KHAU_SAI));
    }
    expect(getLockoutSecondsRemaining(EMAIL)).toBe(0);

    await login(form(MAT_KHAU_SAI));
    expect(getLockoutSecondsRemaining(EMAIL)).toBeGreaterThan(0);
  });

  it("email KHÁC nhau không chờ nhau (cổng nối tiếp theo từng email, không phải toàn cục)", async () => {
    // Nối tiếp toàn cục sẽ biến chính chốt bảo vệ thành chỗ nghẽn: một kẻ bơm email giả là chủ
    // shop phải xếp hàng sau nó. Cổng phải tách theo email.
    vi.mocked(prisma.user.findFirst).mockResolvedValue(null as never);

    const ketQua = await Promise.all(
      Array.from({ length: 20 }, (_, i) => login(form(MAT_KHAU_SAI, `khac-${i}@hogikids.test`)))
    );

    expect(ketQua.every((r) => !r.ok)).toBe(true);
    // 20 email khác nhau ⇒ cả 20 đều được kiểm, không ai bị trần hàng đợi của người khác chặn.
    expect(vi.mocked(verifyPassword).mock.calls.length).toBe(20);
    expect(demEmailDangCoLuot()).toBe(0);

    for (let i = 0; i < 20; i += 1) resetAttempts(`khac-${i}@hogikids.test`);
  });
});
