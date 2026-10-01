import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Integration (`hogikids_test`): đăng nhập / đăng xuất theo epoch TỪNG NGƯỜI + tài khoản bị khoá +
 * nhật ký. `login`/`logout` chạy THẬT (DB, scrypt, iron-session); chỉ kho cookie (cần request scope
 * của Next) được giả bằng một Map.
 */
type MucCookie = { value: string; options?: Record<string, unknown> };
const gia = vi.hoisted(() => ({ khoCookie: new Map<string, MucCookie>() }));

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => gia.khoCookie.get(name),
    set: (name: string, value: string, options?: Record<string, unknown>) => {
      gia.khoCookie.set(name, { value, options });
    },
    delete: (name: string) => {
      gia.khoCookie.delete(name);
    },
  }),
}));

import { login, logout } from "@/lib/actions/auth";
import { thuGiuKhoaPhucHoi } from "@/lib/backup/khoa-bao-tri";
import { getLockoutSecondsRemaining, resetAttempts } from "@/lib/login-lockout";
import { hashPassword } from "@/lib/password";
import { prisma } from "@/lib/prisma";
import { docNguoiDungPhien } from "@/lib/quyen/nguoi-dung-phien";
import { getSession } from "@/lib/session";
import { donKhoaPhucHoi } from "./helpers/khoa-bao-tri-reset";

const EMAIL = "nv-khoa@auth-login.test";
const EMAIL_KHONG_CO = "khong-co@auth-login.test";
// Hai email khác nhau ĐÚNG ở vị trí `_` — `_` là ký tự đại diện của ILIKE, tra không phân biệt hoa/thường
// kiểu ILIKE thì `kho_1@…` khớp cả `khoa1@…`.
const EMAIL_KHOA1 = "khoa1@gach-duoi.test";
const EMAIL_KHO_1 = "kho_1@gach-duoi.test";
const MAT_KHAU = "Mat-khau-dung-1";
const LOI_CHUNG = "Email hoặc mật khẩu không đúng";
const LOI_BI_KHOA = "Tài khoản đã bị khoá, liên hệ chủ shop";

let userId = "";
let hash = "";

function form(email: string, matKhau: string, ghiNho = false): FormData {
  const fd = new FormData();
  fd.set("email", email);
  fd.set("password", matKhau);
  if (ghiNho) fd.set("remember", "on");
  return fd;
}

async function nhatKy() {
  return prisma.auditLog.findMany({ orderBy: { thoiDiem: "asc" } });
}

beforeAll(async () => {
  hash = await hashPassword(MAT_KHAU);
});

beforeEach(async () => {
  gia.khoCookie.clear();
  resetAttempts(EMAIL);
  resetAttempts(EMAIL_KHONG_CO);
  resetAttempts(EMAIL_KHOA1);
  resetAttempts(EMAIL_KHO_1);
  donKhoaPhucHoi();
  await prisma.auditLog.deleteMany({});
  await prisma.user.deleteMany({ where: { email: EMAIL } });
  userId = (
    await prisma.user.create({
      data: { email: EMAIL, passwordHash: hash, role: "STAFF", quyen: ["don-hang:xem"] },
    })
  ).id;
});

afterEach(() => donKhoaPhucHoi());

afterAll(async () => {
  await prisma.auditLog.deleteMany({});
  await prisma.user.deleteMany({ where: { email: { in: [EMAIL, EMAIL_KHOA1, EMAIL_KHO_1] } } });
  await prisma.$disconnect();
});

describe("login — tài khoản bị khoá", () => {
  beforeEach(async () => {
    await prisma.user.update({ where: { id: userId }, data: { isActive: false } });
  });

  it("mật khẩu ĐÚNG ⇒ báo bị khoá, không cấp cookie, nhật ký DANG_NHAP_BI_KHOA mang actor", async () => {
    expect(await login(form(EMAIL, MAT_KHAU))).toEqual({ ok: false, error: LOI_BI_KHOA, code: "BI_KHOA" });
    expect(gia.khoCookie.size).toBe(0);
    expect(await nhatKy()).toMatchObject([
      { hanhDong: "DANG_NHAP_BI_KHOA", ketQua: "LOI", actorId: userId, actorEmail: EMAIL },
    ]);
  });

  it("mật khẩu ĐÚNG lặp lại KHÔNG nhích bộ đếm khoá tạm", async () => {
    for (let i = 0; i < 6; i += 1) await login(form(EMAIL, MAT_KHAU));
    expect(getLockoutSecondsRemaining(EMAIL)).toBe(0);
  });

  it("mật khẩu SAI ⇒ thông báo chung (không lộ đã khoá) + DANG_NHAP_SAI, không actor", async () => {
    expect(await login(form(EMAIL, "sai-mat-khau-1"))).toEqual({ ok: false, error: LOI_CHUNG });
    expect(await nhatKy()).toMatchObject([
      { hanhDong: "DANG_NHAP_SAI", ketQua: "LOI", actorId: null, danhTinhKhaiBao: EMAIL },
    ]);
  });
});

describe("login — sai / không tồn tại", () => {
  it("email không tồn tại ⇒ thông báo chung + DANG_NHAP_SAI ghi email khai", async () => {
    expect(await login(form(EMAIL_KHONG_CO, MAT_KHAU))).toEqual({ ok: false, error: LOI_CHUNG });
    expect(await nhatKy()).toMatchObject([
      { hanhDong: "DANG_NHAP_SAI", actorId: null, danhTinhKhaiBao: EMAIL_KHONG_CO },
    ]);
  });
});

describe("login — email KHÔNG tồn tại vẫn nhích bộ đếm khoá (chống dò tài khoản)", () => {
  it("5 lượt sai ⇒ lượt 6 bị khoá tạm y như email có thật", async () => {
    for (let i = 0; i < 5; i += 1) {
      expect(await login(form(EMAIL_KHONG_CO, "sai-mat-khau-1"))).toEqual({ ok: false, error: LOI_CHUNG });
    }
    expect(getLockoutSecondsRemaining(EMAIL_KHONG_CO)).toBeGreaterThan(0);
    expect(await login(form(EMAIL_KHONG_CO, "sai-mat-khau-1"))).toMatchObject({ ok: false, code: "LOCKED" });
  });
});

describe("login — tra email CHÍNH XÁC, `_` không phải ký tự đại diện", () => {
  let idKhoa1 = "";
  let idKho1 = "";

  beforeEach(async () => {
    await prisma.user.deleteMany({ where: { email: { in: [EMAIL_KHOA1, EMAIL_KHO_1] } } });
    // `khoa1` tạo TRƯỚC: tra kiểu ILIKE không `orderBy` sẽ trả dòng này cho chuỗi `kho_1@…`.
    idKhoa1 = (await prisma.user.create({ data: { email: EMAIL_KHOA1, passwordHash: hash } })).id;
    idKho1 = (await prisma.user.create({ data: { email: EMAIL_KHO_1, passwordHash: hash } })).id;
  });

  it("đăng nhập `kho_1@…` đúng mật khẩu ⇒ vào đúng tài khoản `kho_1`", async () => {
    expect(await login(form(EMAIL_KHO_1, MAT_KHAU))).toEqual({ ok: true, data: undefined });
    expect((await getSession()).userId).toBe(idKho1);
  });

  it("gõ hoa/thường khác ⇒ vẫn đúng tài khoản (email đã chuẩn hoá trước khi tra)", async () => {
    expect(await login(form(`  ${EMAIL_KHOA1.toUpperCase()} `, MAT_KHAU))).toEqual({ ok: true, data: undefined });
    expect((await getSession()).userId).toBe(idKhoa1);
  });

  it("sai 5 lần ở `khoa1` KHÔNG khoá `kho_1`", async () => {
    for (let i = 0; i < 5; i += 1) await login(form(EMAIL_KHOA1, "sai-mat-khau-1"));
    expect(getLockoutSecondsRemaining(EMAIL_KHOA1)).toBeGreaterThan(0);
    expect(getLockoutSecondsRemaining(EMAIL_KHO_1)).toBe(0);
    expect(await login(form(EMAIL_KHO_1, MAT_KHAU))).toEqual({ ok: true, data: undefined });
    expect((await getSession()).userId).toBe(idKho1);
  });
});

describe("login — thành công", () => {
  it("cookie mang đúng User.sessionEpoch, lastLoginAt được ghi, nhật ký DANG_NHAP_OK", async () => {
    const epoch = "f".repeat(32);
    await prisma.user.update({ where: { id: userId }, data: { sessionEpoch: epoch } });

    expect(await login(form(EMAIL.toUpperCase(), MAT_KHAU, true))).toEqual({ ok: true, data: undefined });

    const phien = await getSession();
    expect(phien.userId).toBe(userId);
    expect(phien.mocPhien).toBe(epoch);
    expect((await docNguoiDungPhien())?.id).toBe(userId);

    const u = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    expect(u.lastLoginAt).toBeInstanceOf(Date);
    expect(await nhatKy()).toMatchObject([
      { hanhDong: "DANG_NHAP_OK", ketQua: "OK", actorId: userId, actorEmail: EMAIL },
    ]);
  });

  it("đang phục hồi DB ⇒ vẫn đăng nhập được nhưng KHÔNG ghi DB (lastLoginAt, nhật ký)", async () => {
    expect(thuGiuKhoaPhucHoi()).not.toBeNull();

    expect(await login(form(EMAIL, MAT_KHAU))).toEqual({ ok: true, data: undefined });

    expect((await prisma.user.findUniqueOrThrow({ where: { id: userId } })).lastLoginAt).toBeNull();
    expect(await nhatKy()).toHaveLength(0);
  });
});

describe("logout", () => {
  it("ghi DANG_XUAT mang actor rồi xoá phiên", async () => {
    await login(form(EMAIL, MAT_KHAU, true));
    await prisma.auditLog.deleteMany({});

    expect(await logout()).toEqual({ ok: true, data: undefined });

    expect(await nhatKy()).toMatchObject([{ hanhDong: "DANG_XUAT", ketQua: "OK", actorId: userId }]);
    expect((await getSession()).userId).toBeUndefined();
  });

  it("không có phiên hợp lệ ⇒ vẫn ok, không ghi nhật ký", async () => {
    expect(await logout()).toEqual({ ok: true, data: undefined });
    expect(await nhatKy()).toHaveLength(0);
  });
});
