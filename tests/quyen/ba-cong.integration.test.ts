import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { SessionData } from "@/lib/session";

/**
 * Integration (`hogikids_test`): ba cổng trang / action / route × bốn trạng thái (chưa đăng nhập ·
 * phải đổi mật khẩu · thiếu quyền · đủ quyền) + OWNER luôn qua + mảng quyền "ít nhất một" + biến thể
 * chỉ-chủ-shop. User và nhật ký là dòng THẬT; chỉ cookie (cần request scope) và `redirect` được giả.
 */
const gia = vi.hoisted(() => ({ phien: {} as Record<string, unknown> }));

vi.mock("@/lib/session", async (importActual) => ({
  ...(await importActual<typeof import("@/lib/session")>()),
  getSession: vi.fn(async () => gia.phien),
}));

/** Giả `redirect` của Next: ném để dừng luồng (như bản thật), mang đường dẫn để kiểm. */
class ChuyenHuong extends Error {
  constructor(readonly toi: string) {
    super(`REDIRECT ${toi}`);
  }
}
vi.mock("next/navigation", () => ({
  redirect: vi.fn((toi: string) => {
    throw new ChuyenHuong(toi);
  }),
}));

import { thuGiuKhoaPhucHoi } from "@/lib/backup/khoa-bao-tri";
import { prisma } from "@/lib/prisma";
import { congAction, congChuShopAction } from "@/lib/quyen/cong-action";
import { congChuShopRoute, congRoute } from "@/lib/quyen/cong-route";
import { yeuCauChuShopTrang, yeuCauQuyenTrang } from "@/lib/quyen/cong-trang";

import { donKhoaPhucHoi } from "../helpers/khoa-bao-tri-reset";

const EMAIL_STAFF = "staff@ba-cong.test";
const EMAIL_CHU = "chu@ba-cong.test";
const PATH = "/chi-phi?tab=so";

let staffId = "";
let chuId = "";

function dangNhapLa(userId: string | undefined): void {
  gia.phien = (userId ? { userId, mocPhien: "0" } : {}) satisfies SessionData;
}

async function batTrang(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    if (e instanceof ChuyenHuong) return e.toi;
    throw e;
  }
  throw new Error("cổng trang không chuyển hướng");
}

async function dongTuChoi() {
  return prisma.auditLog.findMany({ where: { hanhDong: "TU_CHOI_QUYEN" } });
}

async function donUser(): Promise<void> {
  await prisma.user.deleteMany({
    where: { OR: [{ role: "OWNER" }, { email: { in: [EMAIL_STAFF, EMAIL_CHU] } }] },
  });
}

beforeAll(async () => {
  await donUser();
  staffId = (
    await prisma.user.create({
      data: { email: EMAIL_STAFF, passwordHash: "x", role: "STAFF", quyen: ["don-hang:xem", "chi-phi:xem"] },
    })
  ).id;
  chuId = (
    await prisma.user.create({ data: { email: EMAIL_CHU, passwordHash: "x", role: "OWNER", quyen: [] } })
  ).id;
});

beforeEach(async () => {
  await prisma.auditLog.deleteMany({});
  await prisma.user.updateMany({ where: { id: { in: [staffId, chuId] } }, data: { mustChangePassword: false } });
  dangNhapLa(undefined);
  donKhoaPhucHoi();
});

afterAll(async () => {
  donKhoaPhucHoi();
  await prisma.auditLog.deleteMany({});
  await donUser();
  await prisma.$disconnect();
});

describe("cổng trang — chỉ chuyển hướng, KHÔNG ghi nhật ký", () => {
  it("chưa đăng nhập ⇒ /dang-nhap?redirect=<path đã mã hoá>", async () => {
    expect(await batTrang(yeuCauQuyenTrang(PATH, "chi-phi:xem"))).toBe(
      `/dang-nhap?redirect=${encodeURIComponent(PATH)}`,
    );
  });

  it("phải đổi mật khẩu ⇒ /doi-mat-khau-lan-dau (trước cả kiểm quyền)", async () => {
    await prisma.user.update({ where: { id: staffId }, data: { mustChangePassword: true } });
    dangNhapLa(staffId);
    // Quyền STAFF KHÔNG có: kiểm quyền trước thì ra /khong-co-quyen — ca này bắt đúng thứ tự.
    expect(await batTrang(yeuCauQuyenTrang(PATH, "chi-phi:sua"))).toBe("/doi-mat-khau-lan-dau");
  });

  it("chỉ-chủ-shop: OWNER đang phải đổi mật khẩu ⇒ /doi-mat-khau-lan-dau", async () => {
    await prisma.user.update({ where: { id: chuId }, data: { mustChangePassword: true } });
    dangNhapLa(chuId);
    expect(await batTrang(yeuCauChuShopTrang(PATH))).toBe("/doi-mat-khau-lan-dau");
  });

  it("mảng quyền RỖNG ⇒ từ chối, kể cả OWNER (fail-closed)", async () => {
    dangNhapLa(chuId);
    expect(await batTrang(yeuCauQuyenTrang(PATH, []))).toBe(`/khong-co-quyen?tu=${encodeURIComponent(PATH)}`);
  });

  it("thiếu quyền ⇒ /khong-co-quyen?tu=<path>, không dòng nhật ký", async () => {
    dangNhapLa(staffId);
    expect(await batTrang(yeuCauQuyenTrang(PATH, "chi-phi:sua"))).toBe(
      `/khong-co-quyen?tu=${encodeURIComponent(PATH)}`,
    );
    expect(await dongTuChoi()).toHaveLength(0);
  });

  it("đủ quyền ⇒ trả NguoiDung; không truyền quyền ⇒ chỉ cần đăng nhập", async () => {
    dangNhapLa(staffId);
    expect((await yeuCauQuyenTrang(PATH, "chi-phi:xem")).id).toBe(staffId);
    expect((await yeuCauQuyenTrang(PATH)).id).toBe(staffId);
  });

  it("mảng quyền = ít nhất một", async () => {
    dangNhapLa(staffId);
    expect((await yeuCauQuyenTrang(PATH, ["chi-phi:sua", "don-hang:xem"])).id).toBe(staffId);
    expect(await batTrang(yeuCauQuyenTrang(PATH, ["chi-phi:sua", "cai-dat:xem"]))).toMatch(/^\/khong-co-quyen/);
  });

  it("OWNER qua mọi quyền; chỉ-chủ-shop chặn STAFF", async () => {
    dangNhapLa(chuId);
    expect((await yeuCauQuyenTrang(PATH, "cai-dat:sua")).id).toBe(chuId);
    expect((await yeuCauChuShopTrang(PATH)).id).toBe(chuId);

    dangNhapLa(staffId);
    expect(await batTrang(yeuCauChuShopTrang(PATH))).toBe(`/khong-co-quyen?tu=${encodeURIComponent(PATH)}`);
    expect(await dongTuChoi()).toHaveLength(0);
  });
});

describe("cổng action — trả mã, thiếu quyền ghi TU_CHOI_QUYEN", () => {
  it("chưa đăng nhập ⇒ CHUA_DANG_NHAP", async () => {
    expect(await congAction("chi-phi:xem")).toMatchObject({ ok: false, code: "CHUA_DANG_NHAP" });
    expect(await dongTuChoi()).toHaveLength(0);
  });

  it("phải đổi mật khẩu ⇒ PHAI_DOI_MAT_KHAU (kể cả không đòi quyền)", async () => {
    await prisma.user.update({ where: { id: staffId }, data: { mustChangePassword: true } });
    dangNhapLa(staffId);
    expect(await congAction()).toMatchObject({ ok: false, code: "PHAI_DOI_MAT_KHAU" });
  });

  it("phải đổi mật khẩu kiểm TRƯỚC thiếu quyền: quyền không có vẫn trả PHAI_DOI_MAT_KHAU, không nhật ký", async () => {
    await prisma.user.update({ where: { id: staffId }, data: { mustChangePassword: true } });
    dangNhapLa(staffId);
    expect(await congAction("chi-phi:sua")).toMatchObject({ ok: false, code: "PHAI_DOI_MAT_KHAU" });
    expect(await congChuShopAction()).toMatchObject({ ok: false, code: "PHAI_DOI_MAT_KHAU" });
    expect(await dongTuChoi()).toHaveLength(0);
  });

  it("chỉ-chủ-shop: OWNER đang phải đổi mật khẩu ⇒ PHAI_DOI_MAT_KHAU", async () => {
    await prisma.user.update({ where: { id: chuId }, data: { mustChangePassword: true } });
    dangNhapLa(chuId);
    expect(await congChuShopAction()).toMatchObject({ ok: false, code: "PHAI_DOI_MAT_KHAU" });
  });

  it("mảng quyền RỖNG ⇒ KHONG_CO_QUYEN, kể cả OWNER (fail-closed: mảng rỗng là lỗi lập trình)", async () => {
    dangNhapLa(chuId);
    expect(await congAction([])).toMatchObject({ ok: false, code: "KHONG_CO_QUYEN" });
    dangNhapLa(staffId);
    expect(await congAction([])).toMatchObject({ ok: false, code: "KHONG_CO_QUYEN" });
  });

  it("đang phục hồi DB ⇒ vẫn từ chối nhưng KHÔNG ghi nhật ký (schema đang bị thay)", async () => {
    expect(thuGiuKhoaPhucHoi()).not.toBeNull();
    dangNhapLa(staffId);
    expect(await congAction("chi-phi:sua")).toMatchObject({ ok: false, code: "KHONG_CO_QUYEN" });
    donKhoaPhucHoi();
    expect(await dongTuChoi()).toHaveLength(0);
  });

  it("thiếu quyền ⇒ KHONG_CO_QUYEN + 1 dòng LOI mang actor và quyền thiếu", async () => {
    dangNhapLa(staffId);
    const r = await congAction("chi-phi:sua");
    expect(r).toMatchObject({ ok: false, code: "KHONG_CO_QUYEN" });
    if (!r.ok) expect(r.error).toBeTruthy();

    const dong = await dongTuChoi();
    expect(dong).toHaveLength(1);
    expect(dong[0]).toMatchObject({
      actorId: staffId,
      actorEmail: EMAIL_STAFF,
      ketQua: "LOI",
      ghiChu: { quyenThieu: "chi-phi:sua" },
    });
  });

  it("đủ quyền / mảng ít nhất một ⇒ ok kèm nguoiDung", async () => {
    dangNhapLa(staffId);
    const r = await congAction("chi-phi:xem");
    expect(r.ok && r.nguoiDung.id).toBe(staffId);
    expect((await congAction(["cai-dat:sua", "don-hang:xem"])).ok).toBe(true);
    expect(await dongTuChoi()).toHaveLength(0);
  });

  it("OWNER luôn qua; chỉ-chủ-shop chặn STAFF + ghi nhật ký", async () => {
    dangNhapLa(chuId);
    expect((await congAction("cai-dat:sua")).ok).toBe(true);
    expect((await congChuShopAction()).ok).toBe(true);

    dangNhapLa(staffId);
    expect(await congChuShopAction()).toMatchObject({ ok: false, code: "KHONG_CO_QUYEN" });
    const dong = await dongTuChoi();
    expect(dong).toHaveLength(1);
    expect(dong[0]).toMatchObject({ actorId: staffId, ghiChu: { quyenThieu: "chu-shop" } });
  });
});

describe("cổng route — JSON 401/403, thiếu quyền ghi TU_CHOI_QUYEN", () => {
  async function trangThai(p: ReturnType<typeof congRoute>) {
    const r = await p;
    if (r.ok) return { ok: true as const, id: r.nguoiDung.id };
    return { ok: false as const, status: r.response.status, body: (await r.response.json()) as unknown };
  }

  it("chưa đăng nhập ⇒ 401 {error:'Unauthorized'}", async () => {
    expect(await trangThai(congRoute("chi-phi:xem"))).toEqual({
      ok: false,
      status: 401,
      body: { error: "Unauthorized" },
    });
    expect(await dongTuChoi()).toHaveLength(0);
  });

  it("phải đổi mật khẩu ⇒ 403, không ghi nhật ký từ chối quyền", async () => {
    await prisma.user.update({ where: { id: staffId }, data: { mustChangePassword: true } });
    dangNhapLa(staffId);
    expect(await trangThai(congRoute())).toMatchObject({ ok: false, status: 403 });
    // Quyền không có: phải-đổi-MK vẫn thắng thiếu-quyền.
    expect(await trangThai(congRoute("chi-phi:sua"))).toMatchObject({
      ok: false,
      status: 403,
      body: { code: "PHAI_DOI_MAT_KHAU" },
    });
    expect(await dongTuChoi()).toHaveLength(0);
  });

  it("chỉ-chủ-shop: OWNER đang phải đổi mật khẩu ⇒ 403 PHAI_DOI_MAT_KHAU", async () => {
    await prisma.user.update({ where: { id: chuId }, data: { mustChangePassword: true } });
    dangNhapLa(chuId);
    expect(await trangThai(congChuShopRoute())).toMatchObject({
      ok: false,
      status: 403,
      body: { code: "PHAI_DOI_MAT_KHAU" },
    });
  });

  it("mảng quyền RỖNG ⇒ 403, kể cả OWNER", async () => {
    dangNhapLa(chuId);
    expect(await trangThai(congRoute([]))).toMatchObject({ ok: false, status: 403, body: { code: "KHONG_CO_QUYEN" } });
  });

  it("thiếu quyền ⇒ 403 + 1 dòng nhật ký", async () => {
    dangNhapLa(staffId);
    expect(await trangThai(congRoute(["cai-dat:xem", "chi-phi:sua"]))).toMatchObject({ ok: false, status: 403 });
    const dong = await dongTuChoi();
    expect(dong).toHaveLength(1);
    expect(dong[0]).toMatchObject({ actorId: staffId, ghiChu: { quyenThieu: "cai-dat:xem|chi-phi:sua" } });
  });

  it("đủ quyền ⇒ ok; OWNER luôn qua; chỉ-chủ-shop chặn STAFF", async () => {
    dangNhapLa(staffId);
    expect(await trangThai(congRoute("don-hang:xem"))).toEqual({ ok: true, id: staffId });

    dangNhapLa(chuId);
    expect(await trangThai(congRoute("cai-dat:sua"))).toEqual({ ok: true, id: chuId });
    expect(await trangThai(congChuShopRoute())).toEqual({ ok: true, id: chuId });

    dangNhapLa(staffId);
    expect(await trangThai(congChuShopRoute())).toMatchObject({ ok: false, status: 403 });
    expect(await dongTuChoi()).toHaveLength(1);
  });
});
