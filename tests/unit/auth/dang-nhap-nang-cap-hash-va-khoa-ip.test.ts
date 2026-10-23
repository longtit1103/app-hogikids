import { randomBytes, scryptSync } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `login()` ở ba điểm mới:
 *  1. Đăng nhập ĐÚNG với hash định dạng cũ ⇒ băm lại đúng MỘT lần (so-rồi-đổi trên hash cũ), không đụng
 *     `sessionEpoch`, lỗi ghi không làm hỏng lượt đăng nhập, bỏ qua khi đang phục hồi DB.
 *  2. Lớp khoá theo IP (`cf-connecting-ip`): thiếu header không đếm; đủ ngưỡng ⇒ `LOCKED`.
 *  3. Nhật ký `DANG_NHAP_SAI` chỉ ghi khi email CÓ tài khoản; thông báo hai nhánh y hệt.
 *
 * Prisma/phiên/nhật ký là hàm giả (không chạm DB); scrypt THẬT cho phần băm lại.
 */
const gia = vi.hoisted(() => ({ ip: null as string | null }));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    user: { findUnique: vi.fn(), updateMany: vi.fn(async () => ({ count: 1 })) },
    $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn({ user: { update: async () => ({}) } })),
  },
}));
vi.mock("@/lib/session", () => ({
  createSession: vi.fn(async () => {}),
  destroySession: vi.fn(async () => {}),
}));
vi.mock("@/lib/nhat-ky/ghi-nhat-ky", () => ({
  ghiNhatKy: vi.fn(async () => undefined),
  ghiNhatKyLoi: vi.fn(async () => undefined),
}));
vi.mock("next/headers", () => ({
  headers: async () => ({ get: (ten: string) => (ten === "cf-connecting-ip" ? gia.ip : null) }),
}));
vi.mock("@/lib/password", async (importActual) => {
  const that = await importActual<typeof import("@/lib/password")>();
  return { ...that, verifyPassword: vi.fn(that.verifyPassword) };
});

import { login } from "@/lib/actions/auth";
import { SO_LAN_SAI_TOI_DA_THEO_IP, xoaBoDemTheoIp } from "@/lib/auth/khoa-dang-nhap-theo-ip";
import { thuGiuKhoaPhucHoi } from "@/lib/backup/khoa-bao-tri";
import { resetAttempts } from "@/lib/login-lockout";
import { ghiNhatKyLoi } from "@/lib/nhat-ky/ghi-nhat-ky";
import { hashPassword, verifyPassword } from "@/lib/password";
import { prisma } from "@/lib/prisma";
import { createSession } from "@/lib/session";

import { donKhoaPhucHoi } from "../../helpers/khoa-bao-tri-reset";

const { verifyPassword: verifyPasswordThat } =
  await vi.importActual<typeof import("@/lib/password")>("@/lib/password");

const EMAIL = "nang-cap-hash@hogikids.test";
const MAT_KHAU = "Mat-khau-dung-1";
const LOI_CHUNG = "Email hoặc mật khẩu không đúng";
const IP = "198.51.100.7";

function form(email: string, matKhau: string): FormData {
  const fd = new FormData();
  fd.set("email", email);
  fd.set("password", matKhau);
  return fd;
}

/** Hash định dạng CŨ đúng như bản trước sinh ra: salt hex thô, scrypt mặc định (N=16384). */
function hashCu(matKhau: string): string {
  const salt = randomBytes(16).toString("hex");
  return `${salt}:${scryptSync(matKhau, salt, 64).toString("hex")}`;
}

function nguoiDung(passwordHash: string, isActive = true) {
  return { id: "u-nang-cap", email: EMAIL, passwordHash, sessionEpoch: "moc-0", isActive } as never;
}

beforeEach(() => {
  gia.ip = null;
  resetAttempts(EMAIL);
  xoaBoDemTheoIp(IP);
  donKhoaPhucHoi();
  vi.mocked(prisma.user.findUnique).mockReset();
  vi.mocked(prisma.user.updateMany).mockReset().mockResolvedValue({ count: 1 } as never);
  vi.mocked(verifyPassword).mockReset().mockImplementation(verifyPasswordThat);
  vi.mocked(createSession).mockClear();
  vi.mocked(ghiNhatKyLoi).mockClear();
});

afterEach(() => {
  donKhoaPhucHoi();
  xoaBoDemTheoIp(IP);
});

describe("login — băm lại hash định dạng cũ", () => {
  it("đăng nhập đúng với hash cũ ⇒ băm lại ĐÚNG 1 lần, so-rồi-đổi trên hash cũ, không đụng sessionEpoch", async () => {
    const cu = hashCu(MAT_KHAU);
    vi.mocked(prisma.user.findUnique).mockResolvedValue(nguoiDung(cu));

    expect(await login(form(EMAIL, MAT_KHAU))).toEqual({ ok: true, data: undefined });
    expect(createSession).toHaveBeenCalledWith("u-nang-cap", false, "moc-0");

    expect(prisma.user.updateMany).toHaveBeenCalledTimes(1);
    // So khớp NGUYÊN đối tượng: `data` chỉ có `passwordHash` (không `sessionEpoch`), `where` khớp hash cũ.
    expect(prisma.user.updateMany).toHaveBeenCalledWith({
      where: { id: "u-nang-cap", passwordHash: cu },
      data: { passwordHash: expect.stringMatching(/^s2\$131072\$[0-9a-f]{32}:[0-9a-f]{128}$/) },
    });
    // Ép kiểu qua `unknown`: tham số `updateMany` là kiểu generic của Prisma, shape đã chốt ngay trên.
    const [thamSo] = vi.mocked(prisma.user.updateMany).mock.calls[0] as unknown as [{ data: { passwordHash: string } }];
    const hashMoi = thamSo.data.passwordHash;
    await expect(verifyPasswordThat(MAT_KHAU, hashMoi)).resolves.toBe(true);

    // Lượt sau DB đã mang hash mới ⇒ không băm lại nữa.
    vi.mocked(prisma.user.findUnique).mockResolvedValue(nguoiDung(hashMoi));
    expect(await login(form(EMAIL, MAT_KHAU))).toEqual({ ok: true, data: undefined });
    expect(prisma.user.updateMany).toHaveBeenCalledTimes(1);
  });

  it("hash đã ở định dạng hiện hành ⇒ không ghi gì", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue(nguoiDung(await hashPassword(MAT_KHAU)));
    expect(await login(form(EMAIL, MAT_KHAU))).toEqual({ ok: true, data: undefined });
    expect(prisma.user.updateMany).not.toHaveBeenCalled();
  });

  it("ghi hash mới LỖI ⇒ lượt đăng nhập vẫn thành công", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue(nguoiDung(hashCu(MAT_KHAU)));
    vi.mocked(prisma.user.updateMany).mockRejectedValueOnce(new Error("mất kết nối DB"));
    const loiConsole = vi.spyOn(console, "error").mockImplementation(() => {});

    expect(await login(form(EMAIL, MAT_KHAU))).toEqual({ ok: true, data: undefined });
    expect(createSession).toHaveBeenCalledTimes(1);
    expect(prisma.user.updateMany).toHaveBeenCalledTimes(1);
    loiConsole.mockRestore();
  });

  it("đang phục hồi DB ⇒ bỏ qua băm lại, đăng nhập vẫn qua", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue(nguoiDung(hashCu(MAT_KHAU)));
    expect(thuGiuKhoaPhucHoi()).not.toBeNull();

    expect(await login(form(EMAIL, MAT_KHAU))).toEqual({ ok: true, data: undefined });
    expect(prisma.user.updateMany).not.toHaveBeenCalled();
  });

  it("mật khẩu SAI hay tài khoản bị khoá ⇒ không băm lại", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue(nguoiDung(hashCu(MAT_KHAU)));
    expect(await login(form(EMAIL, "sai-mat-khau"))).toEqual({ ok: false, error: LOI_CHUNG });

    vi.mocked(prisma.user.findUnique).mockResolvedValue(nguoiDung(hashCu(MAT_KHAU), false));
    expect(await login(form(EMAIL, MAT_KHAU))).toMatchObject({ ok: false, code: "BI_KHOA" });

    expect(prisma.user.updateMany).not.toHaveBeenCalled();
  });
});

describe("login — lớp khoá theo IP", () => {
  // Đo bộ đếm, không đo scrypt: so mật khẩu nhanh để 20+ lượt không ăn hết ngân sách thời gian.
  beforeEach(() => {
    vi.mocked(verifyPassword).mockImplementation(async (plain) => plain === MAT_KHAU);
    vi.mocked(prisma.user.findUnique).mockResolvedValue(null);
  });

  const emailRai = (i: number) => `rai-${i}@hogikids.test`;
  afterEach(() => {
    for (let i = 0; i <= SO_LAN_SAI_TOI_DA_THEO_IP + 5; i += 1) resetAttempts(emailRai(i));
  });

  it("có `cf-connecting-ip`: 20 lượt sai rải qua 20 email ⇒ lượt kế (email mới) bị LOCKED, không tốn scrypt", async () => {
    gia.ip = IP;
    for (let i = 0; i < SO_LAN_SAI_TOI_DA_THEO_IP; i += 1) {
      expect(await login(form(emailRai(i), "sai"))).toEqual({ ok: false, error: LOI_CHUNG });
    }
    const soLanSo = vi.mocked(verifyPassword).mock.calls.length;

    const biChan = await login(form(emailRai(SO_LAN_SAI_TOI_DA_THEO_IP), "sai"));
    expect(biChan).toMatchObject({ ok: false, code: "LOCKED" });
    if (biChan.ok) return;
    // Màn đăng nhập đọc SỐ ĐẦU TIÊN trong thông báo làm giây đếm ngược — phải có đúng một số.
    expect(biChan.error.match(/\d+/g)).toEqual(["300"]);
    expect(vi.mocked(verifyPassword).mock.calls.length).toBe(soLanSo);
  });

  it("THIẾU header ⇒ không đếm theo IP: rải 25 email sai không bị LOCKED", async () => {
    gia.ip = null;
    for (let i = 0; i < SO_LAN_SAI_TOI_DA_THEO_IP + 5; i += 1) {
      expect(await login(form(emailRai(i), "sai"))).toEqual({ ok: false, error: LOI_CHUNG });
    }
  });
});

describe("login — trần nhật ký DANG_NHAP_SAI", () => {
  beforeEach(() => {
    vi.mocked(verifyPassword).mockImplementation(async (plain) => plain === MAT_KHAU);
  });

  it("email CÓ tài khoản ⇒ ghi DANG_NHAP_SAI; email lạ ⇒ không ghi; thông báo y hệt", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValueOnce(nguoiDung("bat-ky"));
    const coTaiKhoan = await login(form(EMAIL, "sai"));
    expect(ghiNhatKyLoi).toHaveBeenCalledTimes(1);
    expect(ghiNhatKyLoi).toHaveBeenCalledWith({ danhTinhKhaiBao: EMAIL, hanhDong: "DANG_NHAP_SAI" });

    vi.mocked(prisma.user.findUnique).mockResolvedValueOnce(null);
    const emailLa = await login(form("khong-co@hogikids.test", "sai"));
    expect(ghiNhatKyLoi).toHaveBeenCalledTimes(1);

    expect(coTaiKhoan).toEqual({ ok: false, error: LOI_CHUNG });
    expect(emailLa).toEqual(coTaiKhoan);
    resetAttempts("khong-co@hogikids.test");
  });
});
