import { beforeEach, describe, expect, it, vi } from "vitest";

// Finding M7: changePassword (lockout + chặn trùng mật khẩu cũ + regex phức tạp) trước
// đây 0 test. Mock prisma/session/password/lockout để test THUẦN logic action, KHÔNG DB.
vi.mock("@/lib/session", () => ({
  requireUser: vi.fn(async () => "test-user"),
  // Đổi mật khẩu THU HỒI mọi phiên cũ rồi cấp lại cookie cho đúng thiết bị đang thao tác.
  docGhiNhoCuaPhien: vi.fn(async () => true),
  thuHoiMoiPhien: vi.fn(async () => undefined),
  createSession: vi.fn(async () => undefined),
}));
vi.mock("@/lib/prisma", () => {
  const prisma = {
    user: { findUnique: vi.fn(), update: vi.fn() },
    $transaction: vi.fn(),
  };
  // Action ghi hash + đẩy mốc phiên trong CÙNG transaction ⇒ mock chạy callback với chính client
  // này, nhờ vậy các assertion `prisma.user.update` bên dưới vẫn soi được lượt ghi.
  prisma.$transaction.mockImplementation(async (fn: (tx: unknown) => unknown) => fn(prisma));
  return { prisma };
});
// Chỉ mock 2 HÀM băm; `MAX_PASSWORD_LENGTH` giữ giá trị THẬT (schema đọc hằng số này lúc dựng —
// mock thiếu nó thì `.max(undefined)` làm zod nổ ngay khi import). Giữ bản thật cũng để test luôn
// bám đúng trần đang chạy, không phải một con số chép tay rồi trôi lệch.
vi.mock("@/lib/password", async (importActual) => ({
  ...(await importActual<typeof import("@/lib/password")>()),
  verifyPassword: vi.fn(),
  hashPassword: vi.fn(async () => "hashed-new"),
}));
vi.mock("@/lib/login-lockout", () => ({
  getLockoutSecondsRemaining: vi.fn(() => 0),
  recordFailedAttempt: vi.fn(),
  resetAttempts: vi.fn(),
}));

import { changePassword } from "@/lib/actions/security";
import {
  getLockoutSecondsRemaining,
  recordFailedAttempt,
  resetAttempts,
} from "@/lib/login-lockout";
import { hashPassword, MAX_PASSWORD_LENGTH, verifyPassword } from "@/lib/password";
import { prisma } from "@/lib/prisma";
import { createSession, thuHoiMoiPhien } from "@/lib/session";

const USER = { id: "test-user", email: "owner@hogikids.test", passwordHash: "hash-current" };
/** Khớp `khoaDoiMatKhau()` ở `@/lib/actions/security` — tách namespace khỏi bộ đếm màn đăng nhập. */
const KHOA_LOCKOUT_USER = `doimatkhau:${USER.email}`;

/** FormData 3 field như form đổi mật khẩu. `confirm` mặc định = `next` (khớp). */
function form(current: string, next: string, confirm: string = next): FormData {
  const fd = new FormData();
  fd.set("currentPassword", current);
  fd.set("newPassword", next);
  fd.set("confirmPassword", confirm);
  return fd;
}

describe("changePassword", () => {
  beforeEach(() => {
    vi.mocked(prisma.user.findUnique).mockReset().mockResolvedValue(USER as never);
    vi.mocked(prisma.user.update).mockReset().mockResolvedValue(USER as never);
    vi.mocked(verifyPassword).mockReset().mockResolvedValue(true);
    vi.mocked(hashPassword).mockReset().mockResolvedValue("hashed-new");
    vi.mocked(getLockoutSecondsRemaining).mockReset().mockReturnValue(0);
    vi.mocked(recordFailedAttempt).mockReset();
    vi.mocked(resetAttempts).mockReset();
    // Bộ đếm `$transaction` phải về 0 giữa các case — case "thành công" phía dưới cũng gọi nó.
    // `mockClear` chứ KHÔNG `mockReset`: ở đây chỉ cần xoá bộ đếm, còn implementation
    // `async (fn) => fn(prisma)` khai trong factory là điều kiện sống của MỌI case chạm DB.
    vi.mocked(prisma.$transaction).mockClear();
    vi.mocked(thuHoiMoiPhien).mockReset().mockResolvedValue(undefined);
    vi.mocked(createSession).mockReset().mockResolvedValue(undefined);
  });

  it("đang bị khoá (lockout) → chặn TRƯỚC verify, KHÔNG ghi DB", async () => {
    vi.mocked(getLockoutSecondsRemaining).mockReturnValue(42);
    const r = await changePassword(form("cur1234a", "new123456789"));
    expect(r).toMatchObject({ ok: false, field: "currentPassword" });
    expect(r.ok === false && r.error).toContain("42");
    expect(verifyPassword).not.toHaveBeenCalled();
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it("mật khẩu hiện tại sai → ghi nhận thất bại (lockout, namespace RIÊNG khỏi đăng nhập) + KHÔNG update", async () => {
    vi.mocked(verifyPassword).mockResolvedValue(false);
    const r = await changePassword(form("wrongpw1", "new123456789"));
    expect(r).toEqual({ ok: false, error: "Mật khẩu hiện tại không đúng", field: "currentPassword" });
    // KHÔNG được gọi bằng email thật — namespace riêng chặn việc sai mật khẩu ở đây khoá luôn
    // màn đăng nhập (xem `khoaDoiMatKhau` ở `@/lib/actions/security`).
    expect(recordFailedAttempt).toHaveBeenCalledWith(KHOA_LOCKOUT_USER);
    expect(recordFailedAttempt).not.toHaveBeenCalledWith(USER.email);
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it("mật khẩu mới TRÙNG mật khẩu hiện tại → từ chối, KHÔNG update", async () => {
    const r = await changePassword(form("same123456789", "same123456789"));
    expect(r).toMatchObject({ ok: false, field: "newPassword" });
    expect(r.ok === false && r.error).toContain("khác");
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it("mật khẩu mới ngắn hơn 12 ký tự → chặn ở zod, KHÔNG đụng DB", async () => {
    const r = await changePassword(form("cur1234a", "short1a"));
    expect(r).toMatchObject({ ok: false, field: "newPassword" });
    expect(r.ok === false && r.error).toContain("12");
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it("mật khẩu mới không đủ phức tạp (thiếu số) → chặn ở zod, KHÔNG đụng DB", async () => {
    const r = await changePassword(form("cur1234a", "onlylettersnodigit"));
    expect(r).toMatchObject({ ok: false, field: "newPassword" });
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it("xác nhận không khớp → chặn ở zod (field confirmPassword)", async () => {
    const r = await changePassword(form("cur1234a", "new123456789", "khac123456789"));
    expect(r).toMatchObject({ ok: false, field: "confirmPassword" });
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it("không tìm thấy user → trả lỗi, KHÔNG verify/update", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue(null);
    const r = await changePassword(form("cur1234a", "new123456789"));
    expect(r).toEqual({ ok: false, error: "Không tìm thấy người dùng" });
    expect(verifyPassword).not.toHaveBeenCalled();
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it("thành công → hash ĐÚNG mật khẩu mới + update + reset lockout (namespace riêng)", async () => {
    const r = await changePassword(form("cur1234a", "brandnew1234"));
    expect(r).toEqual({ ok: true, data: undefined });
    expect(hashPassword).toHaveBeenCalledWith("brandnew1234"); // hash đúng newPassword, không nhầm biến
    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: "test-user" },
      data: { passwordHash: "hashed-new" },
    });
    expect(resetAttempts).toHaveBeenCalledWith(KHOA_LOCKOUT_USER);
  });

  it("xoá bộ đếm khoá NGAY sau khi xác thực, TRƯỚC lúc băm/ghi DB/cấp cookie", async () => {
    // Để lượt xoá ở tận cuối hàm là mở một cửa sổ dài (băm mật khẩu mới hàng trăm ms + ghi DB +
    // cấp cookie): một lượt đăng nhập SAI chen vào giữa sẽ bị lượt xoá muộn thổi bay, khoá 60
    // giây rơi về 0. Chốt bằng THỨ TỰ gọi: xoá phải xảy ra trước cả ba việc kia.
    await changePassword(form("cur1234a", "brandnew1234"));

    const thuTuXoa = vi.mocked(resetAttempts).mock.invocationCallOrder[0];
    expect(thuTuXoa).toBeLessThan(vi.mocked(hashPassword).mock.invocationCallOrder[0]);
    expect(thuTuXoa).toBeLessThan(vi.mocked(prisma.user.update).mock.invocationCallOrder[0]);
    expect(thuTuXoa).toBeLessThan(vi.mocked(createSession).mock.invocationCallOrder[0]);
  });

  it("đẩy mốc phiên đi CÙNG transaction với lượt ghi hash", async () => {
    await changePassword(form("cur1234a", "brandnew1234"));

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    // Cùng một client ⇒ hai lệnh cùng sống hoặc cùng chết.
    expect(vi.mocked(thuHoiMoiPhien)).toHaveBeenCalledWith(prisma);
  });

  it("đẩy mốc phiên LỖI → KHÔNG trả ok và KHÔNG cấp cookie mới", async () => {
    vi.mocked(thuHoiMoiPhien).mockRejectedValueOnce(new Error("mất kết nối DB"));

    const r = await changePassword(form("cur1234a", "brandnew1234"));

    expect(r.ok).toBe(false);
    // Cấp cookie mới lúc này = xác nhận một lượt đổi mật khẩu chưa chắc đã ghi được.
    expect(createSession).not.toHaveBeenCalled();
  });

  it("từ chối mật khẩu mới VƯỢT trần — không để đặt được thứ mà màn đăng nhập sẽ chặn", async () => {
    // Nếu trần ở đây rộng hơn trần của `loginSchema` thì chủ shop đặt xong sẽ TỰ KHOÁ MÌNH VĨNH
    // VIỄN: hash mới ghi thành công, mọi phiên bị thu hồi, rồi lượt đăng nhập kế tiếp bị chặn ở
    // bước kiểm dữ liệu và chỉ nhận thông báo chung "Email hoặc mật khẩu không đúng". Test này
    // đọc THẲNG `MAX_PASSWORD_LENGTH` (bản thật) nên hai màn không thể trôi lệch nhau.
    const quaDai = "a1" + "x".repeat(MAX_PASSWORD_LENGTH); // dài hơn trần đúng 1 ký tự trở lên

    const r = await changePassword(form("cur1234a", quaDai));

    expect(r.ok).toBe(false);
    // Không được ghi gì: mật khẩu này sẽ không dùng để đăng nhập lại được.
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it("nhận mật khẩu mới ĐÚNG BẰNG trần (không chặn oan biên)", async () => {
    const dungTran = "a1" + "x".repeat(MAX_PASSWORD_LENGTH - 2);
    expect(dungTran).toHaveLength(MAX_PASSWORD_LENGTH);

    const r = await changePassword(form("cur1234a", dungTran));

    expect(r.ok).toBe(true);
  });

  it("nhận mật khẩu mới ĐÚNG BẰNG trần dưới 12 ký tự (không chặn oan biên)", async () => {
    const dungTranDuoi = "a1" + "x".repeat(10); // đúng 12 ký tự
    expect(dungTranDuoi).toHaveLength(12);

    const r = await changePassword(form("cur1234a", dungTranDuoi));

    expect(r.ok).toBe(true);
  });

  it("mật khẩu HIỆN TẠI ngắn hơn 12 ký tự (đặt từ trước lượt nâng trần) vẫn xác thực được — trần mới CHỈ áp cho mật khẩu MỚI", async () => {
    // currentPassword không đi qua MIN_NEW_PASSWORD_LENGTH — chỉ `min(1)` + so khớp hash thật.
    const r = await changePassword(form("old8char", "brandnew1234"));
    expect(r).toEqual({ ok: true, data: undefined });
    expect(verifyPassword).toHaveBeenCalledWith("old8char", USER.passwordHash);
  });
});
