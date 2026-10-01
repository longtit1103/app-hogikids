import { beforeEach, describe, expect, it, vi } from "vitest";

// Finding M7: changePassword (lockout + chặn trùng mật khẩu cũ + regex phức tạp) trước
// đây 0 test. Mock prisma/session/password/lockout để test THUẦN logic action, KHÔNG DB.
vi.mock("@/lib/session", () => ({
  // Đổi mật khẩu THU HỒI mọi phiên cũ của người này rồi cấp lại cookie cho đúng thiết bị đang thao tác.
  docGhiNhoCuaPhien: vi.fn(async () => true),
  thuHoiPhienCuaNguoi: vi.fn(async () => "moc-moi"),
  createSession: vi.fn(async () => undefined),
}));
/** Người đang gọi (qua cổng action) — cookie mang epoch "moc-cu". */
const NGUOI_DUNG = {
  id: "test-user",
  email: "owner@hogikids.test",
  tenHienThi: "",
  role: "OWNER" as const,
  quyen: new Set<never>(),
  phaiDoiMatKhau: false,
  mocPhien: "moc-cu",
};
vi.mock("@/lib/quyen/cong-action", () => ({
  congAction: vi.fn(async () => ({ ok: true, nguoiDung: NGUOI_DUNG })),
}));
vi.mock("@/lib/nhat-ky/ghi-nhat-ky", () => ({
  ghiNhatKy: vi.fn(async () => undefined),
  ghiNhatKyLoi: vi.fn(async () => undefined),
}));
/**
 * Client TRONG transaction — object KHÁC `prisma` (dùng chung các hàm giả để assertion `prisma.user.update`
 * vẫn soi được lượt ghi). Khác danh tính là điều kiện để assertion "gọi bằng tx" có nghĩa: mock
 * `$transaction` bằng `fn(prisma)` thì lệnh ghi bằng client gốc SAU commit cũng khớp.
 */
const TX = vi.hoisted(() => ({}) as Record<string, unknown>);
vi.mock("@/lib/prisma", () => {
  const prisma = {
    user: { findUnique: vi.fn(), update: vi.fn() },
    // Dòng user đọc DƯỚI khoá `FOR UPDATE` trong transaction.
    $queryRaw: vi.fn(),
    $transaction: vi.fn(),
  };
  Object.assign(TX, { user: { update: prisma.user.update }, $queryRaw: prisma.$queryRaw });
  prisma.$transaction.mockImplementation(async (fn: (tx: unknown) => unknown) => fn(TX));
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
import { ghiNhatKy, ghiNhatKyLoi } from "@/lib/nhat-ky/ghi-nhat-ky";
import { congAction } from "@/lib/quyen/cong-action";
import {
  getLockoutSecondsRemaining,
  recordFailedAttempt,
  resetAttempts,
} from "@/lib/login-lockout";
import { hashPassword, MAX_PASSWORD_LENGTH, verifyPassword } from "@/lib/password";
import { prisma } from "@/lib/prisma";
import { createSession, thuHoiPhienCuaNguoi } from "@/lib/session";

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
    // `async (fn) => fn(TX)` khai trong factory là điều kiện sống của MỌI case chạm DB.
    vi.mocked(prisma.$transaction).mockClear();
    vi.mocked(thuHoiPhienCuaNguoi).mockReset().mockResolvedValue("moc-moi");
    vi.mocked(createSession).mockReset().mockResolvedValue(undefined);
    vi.mocked(prisma.$queryRaw)
      .mockReset()
      .mockResolvedValue([{ sessionEpoch: "moc-cu", mustChangePassword: false, isActive: true }] as never);
    vi.mocked(congAction).mockClear();
    vi.mocked(ghiNhatKy).mockReset().mockResolvedValue(undefined);
    vi.mocked(ghiNhatKyLoi).mockReset().mockResolvedValue(undefined);
  });

  it("cổng action từ chối ⇒ trả nguyên kết quả cổng, KHÔNG đụng DB", async () => {
    vi.mocked(congAction).mockResolvedValueOnce({
      ok: false,
      error: "Phiên đăng nhập đã hết hạn — đăng nhập lại",
      code: "CHUA_DANG_NHAP",
    });
    const r = await changePassword(form("cur1234a", "new123456789"));
    expect(r).toMatchObject({ ok: false, code: "CHUA_DANG_NHAP" });
    expect(congAction).toHaveBeenCalledWith(); // không đòi quyền module
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
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
    expect(ghiNhatKyLoi).toHaveBeenCalledWith(
      expect.objectContaining({ hanhDong: "DOI_MAT_KHAU", actor: { id: "test-user", email: USER.email } }),
    );
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

  it("luật mật khẩu mới + thứ tự lỗi giữ nguyên: hiện tại trống báo trước; câu lỗi đúng từng chữ", async () => {
    expect(await changePassword(form("", "short1a"))).toEqual({
      ok: false,
      error: "Vui lòng nhập mật khẩu hiện tại",
      field: "currentPassword",
    });
    expect(await changePassword(form("cur1234a", "short1a"))).toEqual({
      ok: false,
      error: "Mật khẩu mới phải có ít nhất 12 ký tự",
      field: "newPassword",
    });
    expect(await changePassword(form("cur1234a", "onlylettersnodigit"))).toEqual({
      ok: false,
      error: "Mật khẩu mới phải có cả chữ và số",
      field: "newPassword",
    });
    expect(await changePassword(form("cur1234a", "new123456789", ""))).toEqual({
      ok: false,
      error: "Vui lòng nhập lại mật khẩu mới",
      field: "confirmPassword",
    });
    expect(await changePassword(form("cur1234a", "new123456789", "khac123456789"))).toEqual({
      ok: false,
      error: "Mật khẩu xác nhận không khớp",
      field: "confirmPassword",
    });
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
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

  it("đổi epoch + nhật ký đi CÙNG transaction với lượt ghi hash; cookie cấp từ epoch transaction trả ra", async () => {
    await changePassword(form("cur1234a", "brandnew1234"));

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    // Cùng client TRANSACTION (không phải client gốc) ⇒ các lệnh cùng sống hoặc cùng chết.
    expect(vi.mocked(thuHoiPhienCuaNguoi)).toHaveBeenCalledWith(TX, "test-user");
    expect(ghiNhatKy).toHaveBeenCalledWith(TX, {
      actor: { id: "test-user", email: "owner@hogikids.test" },
      hanhDong: "DOI_MAT_KHAU",
    });
    expect(ghiNhatKy).not.toHaveBeenCalledWith(prisma, expect.anything());
    expect(createSession).toHaveBeenCalledWith("test-user", true, "moc-moi");
  });

  it("epoch dưới khoá dòng LỆCH cookie đang gọi ⇒ TRANG_THAI_DA_DOI, không ghi hash, không cấp cookie", async () => {
    vi.mocked(prisma.$queryRaw).mockResolvedValue([{ sessionEpoch: "moc-da-doi", mustChangePassword: false, isActive: true }] as never);

    const r = await changePassword(form("cur1234a", "brandnew1234"));

    expect(r).toEqual({ ok: false, code: "TRANG_THAI_DA_DOI", error: "Trạng thái tài khoản đã đổi, đăng nhập lại" });
    expect(prisma.user.update).not.toHaveBeenCalled();
    expect(thuHoiPhienCuaNguoi).not.toHaveBeenCalled();
    expect(createSession).not.toHaveBeenCalled();
    expect(ghiNhatKyLoi).toHaveBeenCalledWith(
      expect.objectContaining({ hanhDong: "DOI_MAT_KHAU", ghiChu: { lyDo: "TRANG_THAI_DA_DOI" } }),
    );
  });

  it("chủ shop vừa bật 'phải đổi mật khẩu' (cờ dưới khoá dòng) ⇒ TRANG_THAI_DA_DOI", async () => {
    vi.mocked(prisma.$queryRaw).mockResolvedValue([{ sessionEpoch: "moc-cu", mustChangePassword: true, isActive: true }] as never);
    const r = await changePassword(form("cur1234a", "brandnew1234"));
    expect(r).toMatchObject({ ok: false, code: "TRANG_THAI_DA_DOI" });
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it("tài khoản đã bị khoá (isActive=false dưới khoá dòng) ⇒ TRANG_THAI_DA_DOI, không ghi hash", async () => {
    vi.mocked(prisma.$queryRaw).mockResolvedValue([{ sessionEpoch: "moc-cu", mustChangePassword: false, isActive: false }] as never);
    const r = await changePassword(form("cur1234a", "brandnew1234"));
    expect(r).toMatchObject({ ok: false, code: "TRANG_THAI_DA_DOI" });
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it("dòng user biến mất dưới khoá ⇒ TRANG_THAI_DA_DOI", async () => {
    vi.mocked(prisma.$queryRaw).mockResolvedValue([] as never);
    const r = await changePassword(form("cur1234a", "brandnew1234"));
    expect(r).toMatchObject({ ok: false, code: "TRANG_THAI_DA_DOI" });
  });

  it("đẩy mốc phiên LỖI → KHÔNG trả ok và KHÔNG cấp cookie mới", async () => {
    vi.mocked(thuHoiPhienCuaNguoi).mockRejectedValueOnce(new Error("mất kết nối DB"));

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
