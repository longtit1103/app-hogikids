import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `doiMatKhauLanDau` chạy THẬT trên DB test: `docNguoiDungPhien`/`kiemPhien`, iron-session, khoá dòng
 * Postgres, và (ca c) `datLaiMatKhau` thật của chủ shop. Chỉ giả:
 *  - kho cookie của Next — mỗi "request" một kho riêng theo `AsyncLocalStorage` (hai request cùng
 *    cookie là hai BẢN SAO: lượt thắng ghi cookie mới vào kho của CHÍNH nó, không rò sang lượt kia);
 *  - `hashPassword` / `ghiNhatKy` bọc quanh bản thật để cắm barrier.
 *
 * Cùng khuôn với `tests/phien/khe-dua-dang-nhap-reset-doi-mat-khau.integration.test.ts` (b)(c), áp cho
 * đường đổi mật khẩu LẦN ĐẦU: đối chiếu epoch + cờ `mustChangePassword` dưới `SELECT … FOR UPDATE`.
 */
type MucCookie = { value: string };
const gia = await vi.hoisted(async () => {
  const { AsyncLocalStorage } = await import("node:async_hooks");
  return { als: new AsyncLocalStorage<Map<string, MucCookie>>() };
});

vi.mock("next/headers", () => {
  const kho = () => {
    const k = gia.als.getStore();
    if (!k) throw new Error("cookies() gọi ngoài trongRequest() — test dựng sai");
    return k;
  };
  return {
    cookies: async () => ({
      get: (name: string) => kho().get(name),
      set: (name: string, value: string) => {
        kho().set(name, { value });
      },
      delete: (name: string) => {
        kho().delete(name);
      },
    }),
  };
});

vi.mock("@/lib/nhat-ky/ghi-nhat-ky", async (importActual) => {
  const that = await importActual<typeof import("@/lib/nhat-ky/ghi-nhat-ky")>();
  return { ...that, ghiNhatKy: vi.fn(that.ghiNhatKy) };
});

vi.mock("@/lib/password", async (importActual) => {
  const that = await importActual<typeof import("@/lib/password")>();
  return { ...that, hashPassword: vi.fn(that.hashPassword) };
});

import { doiMatKhauLanDau } from "@/lib/actions/doi-mat-khau-lan-dau";
import { datLaiMatKhau } from "@/lib/actions/tai-khoan";
import { ghiNhatKy } from "@/lib/nhat-ky/ghi-nhat-ky";
import { hashPassword, verifyPassword } from "@/lib/password";
import { prisma } from "@/lib/prisma";
import { kiemPhien } from "@/lib/quyen/nguoi-dung-phien";
import { createSession, getSession } from "@/lib/session";

import { donKhoaPhucHoi } from "../helpers/khoa-bao-tri-reset";
import { chuShopTrongDb, donDuLieuTaiKhoan, taoStaffTrongDb } from "./du-lieu-tai-khoan-test";

const passwordThat = await vi.importActual<typeof import("@/lib/password")>("@/lib/password");
const nhatKyThat = await vi.importActual<typeof import("@/lib/nhat-ky/ghi-nhat-ky")>("@/lib/nhat-ky/ghi-nhat-ky");

const MK_TAM = "TamThoi23456789a";
const MK_MOI_1 = "Mat-khau-moi-1111";
const MK_MOI_2 = "Mat-khau-moi-2222";
const EPOCH_BAN_DAU = "a".repeat(32);
const TEN_COOKIE = "hogikids_session";
const LOI_TRANG_THAI = { ok: false, error: "Trạng thái tài khoản đã đổi, đăng nhập lại", code: "TRANG_THAI_DA_DOI" };

let userId = "";

type Deferred<T> = { promise: Promise<T>; resolve: (v: T) => void };
function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** Chạy `fn` như MỘT request có kho cookie riêng (bản sao `cookieVao`). */
async function trongRequest<T>(cookieVao: Map<string, MucCookie>, fn: () => Promise<T>) {
  const kho = new Map(cookieVao);
  const ketQua = await gia.als.run(kho, fn);
  return { ketQua, kho };
}

/** Cookie phiên hợp lệ cấp bằng `createSession` thật với epoch cho trước. */
async function cookieCua(id: string, moc: string, ghiNho = true): Promise<Map<string, MucCookie>> {
  const { kho } = await trongRequest(new Map(), () => createSession(id, ghiNho, moc));
  return kho;
}

async function kiemKho(kho: Map<string, MucCookie>) {
  return gia.als.run(new Map(kho), async () => {
    const session = await getSession();
    return { session: { ...session }, nguoiDung: await kiemPhien(session) };
  });
}

function formMoi(moi: string, xacNhan = moi): FormData {
  const fd = new FormData();
  fd.set("newPassword", moi);
  fd.set("confirmPassword", xacNhan);
  return fd;
}

const dongUser = () => prisma.user.findUniqueOrThrow({ where: { id: userId } });

/** Chờ tới khi có ≥ 1 phiên Postgres đang CHỜ KHOÁ trên câu `FOR UPDATE`. */
async function choCoPhienChoKhoa(hanMs = 10_000): Promise<void> {
  const batDau = Date.now();
  while (Date.now() - batDau < hanMs) {
    const [{ n }] = await prisma.$queryRaw<{ n: number }[]>`
      SELECT count(*)::int AS n FROM pg_stat_activity
      WHERE datname = current_database() AND wait_event_type = 'Lock' AND query ILIKE '%FOR UPDATE%'`;
    if (n > 0) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("Hết hạn chờ: doiMatKhauLanDau không tới bước SELECT … FOR UPDATE");
}

beforeEach(async () => {
  donKhoaPhucHoi();
  vi.mocked(hashPassword).mockReset().mockImplementation(passwordThat.hashPassword);
  vi.mocked(ghiNhatKy).mockReset().mockImplementation(nhatKyThat.ghiNhatKy);
  await donDuLieuTaiKhoan();
  userId = (await taoStaffTrongDb("lan-dau", { matKhau: MK_TAM, mustChangePassword: true, sessionEpoch: EPOCH_BAN_DAU })).id;
});

afterAll(async () => {
  await donDuLieuTaiKhoan();
  await prisma.$disconnect();
});

describe("doiMatKhauLanDau — luồng thường", () => {
  it.each([true, false])("OK (ghi nhớ=%s): hash mới, bỏ cờ, epoch mới, cookie cấp lại đúng loại, nhật ký", async (ghiNho) => {
    const cookie = await cookieCua(userId, EPOCH_BAN_DAU, ghiNho);

    const { ketQua, kho } = await trongRequest(cookie, () => doiMatKhauLanDau(formMoi(MK_MOI_1)));

    expect(ketQua).toEqual({ ok: true, data: undefined });
    const dong = await dongUser();
    expect(await verifyPassword(MK_MOI_1, dong.passwordHash)).toBe(true);
    expect(dong.mustChangePassword).toBe(false);
    expect(dong.sessionEpoch).not.toBe(EPOCH_BAN_DAU);
    const moi = await kiemKho(kho);
    expect(moi.session).toMatchObject({ userId, mocPhien: dong.sessionEpoch, ghiNho });
    expect(moi.nguoiDung).toMatchObject({ id: userId, phaiDoiMatKhau: false });
    expect((await kiemKho(cookie)).nguoiDung).toBeNull();
    const nhatKy = await prisma.auditLog.findMany({ where: { actorId: userId, hanhDong: "DOI_MAT_KHAU_LAN_DAU" } });
    expect(nhatKy).toEqual([expect.objectContaining({ ketQua: "OK", ghiChu: null })]);
  });

  it("người KHÔNG có cờ phải đổi ⇒ KHONG_CO_QUYEN, không đổi gì", async () => {
    await prisma.user.update({ where: { id: userId }, data: { mustChangePassword: false } });
    const cookie = await cookieCua(userId, EPOCH_BAN_DAU);
    const truoc = await dongUser();

    const { ketQua, kho } = await trongRequest(cookie, () => doiMatKhauLanDau(formMoi(MK_MOI_1)));

    expect(ketQua).toMatchObject({ ok: false, code: "KHONG_CO_QUYEN" });
    expect(await dongUser()).toEqual(truoc);
    expect(kho.get(TEN_COOKIE)).toEqual(cookie.get(TEN_COOKIE));
  });

  it("chưa đăng nhập ⇒ CHUA_DANG_NHAP", async () => {
    const { ketQua } = await trongRequest(new Map(), () => doiMatKhauLanDau(formMoi(MK_MOI_1)));
    expect(ketQua).toMatchObject({ ok: false, code: "CHUA_DANG_NHAP" });
  });

  it("MK < 12 ký tự / xác nhận lệch / giữ nguyên MK tạm ⇒ lỗi đúng ô, không đổi gì", async () => {
    const cookie = await cookieCua(userId, EPOCH_BAN_DAU);
    const truoc = await dongUser();

    const ngan = await trongRequest(cookie, () => doiMatKhauLanDau(formMoi("ngan1234")));
    expect(ngan.ketQua).toMatchObject({ ok: false, field: "newPassword" });
    const lech = await trongRequest(cookie, () => doiMatKhauLanDau(formMoi(MK_MOI_1, MK_MOI_2)));
    expect(lech.ketQua).toMatchObject({ ok: false, field: "confirmPassword" });
    const giuTam = await trongRequest(cookie, () => doiMatKhauLanDau(formMoi(MK_TAM)));
    expect(giuTam.ketQua).toMatchObject({ ok: false, field: "newPassword", error: "Mật khẩu mới phải khác mật khẩu tạm" });

    expect(await dongUser()).toEqual(truoc);
  });

  it("nhật ký ném ⇒ hash/cờ/epoch KHÔNG đổi, không cấp cookie", async () => {
    const cookie = await cookieCua(userId, EPOCH_BAN_DAU);
    const truoc = await dongUser();
    vi.mocked(ghiNhatKy).mockImplementation(async (db, p) => {
      if (p.hanhDong === "DOI_MAT_KHAU_LAN_DAU") throw new Error("nhật ký hỏng");
      return nhatKyThat.ghiNhatKy(db, p);
    });
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const { ketQua, kho } = await trongRequest(cookie, () => doiMatKhauLanDau(formMoi(MK_MOI_1)));
      expect(ketQua).toEqual({ ok: false, error: "Không lưu được mật khẩu mới — thử lại" });
      expect(await dongUser()).toEqual(truoc);
      expect(kho.get(TEN_COOKIE)).toEqual(cookie.get(TEN_COOKIE));
    } finally {
      log.mockRestore();
    }
  });
});

describe("doiMatKhauLanDau — khe đua", () => {
  it("(b) hai lượt song song cùng một cookie ⇒ đúng 1 OK + 1 TRANG_THAI_DA_DOI; hash cuối là của lượt OK", async () => {
    const cookie = await cookieCua(userId, EPOCH_BAN_DAU);

    // Barrier: cả hai lượt phải qua đọc phiên (cùng epoch) + kiểm dữ liệu rồi mới cho băm xong — tức cả
    // hai chắc chắn vào transaction với CÙNG epoch mong đợi, khoá dòng quyết người thắng.
    let soLuotBam = 0;
    const caHaiDaToi = deferred<void>();
    vi.mocked(hashPassword).mockImplementation(async (mk: string) => {
      const h = await passwordThat.hashPassword(mk);
      soLuotBam += 1;
      if (soLuotBam === 2) caHaiDaToi.resolve();
      await caHaiDaToi.promise;
      return h;
    });

    const [r1, r2] = await Promise.all([
      trongRequest(cookie, () => doiMatKhauLanDau(formMoi(MK_MOI_1))),
      trongRequest(cookie, () => doiMatKhauLanDau(formMoi(MK_MOI_2))),
    ]);

    expect(soLuotBam).toBe(2);
    const ketQua = [r1.ketQua, r2.ketQua];
    const thang = ketQua.findIndex((k) => k.ok);
    expect(ketQua.filter((k) => k.ok)).toHaveLength(1);
    expect(ketQua[1 - thang]).toEqual(LOI_TRANG_THAI);

    const dong = await dongUser();
    const [mkThang, mkThua] = thang === 0 ? [MK_MOI_1, MK_MOI_2] : [MK_MOI_2, MK_MOI_1];
    expect(await verifyPassword(mkThang, dong.passwordHash)).toBe(true);
    expect(await verifyPassword(mkThua, dong.passwordHash)).toBe(false);
    expect(dong.mustChangePassword).toBe(false);

    const khoThang = (thang === 0 ? r1 : r2).kho;
    const khoThua = (thang === 0 ? r2 : r1).kho;
    expect((await kiemKho(khoThang)).nguoiDung).toMatchObject({ id: userId, mocPhien: dong.sessionEpoch });
    expect((await kiemKho(khoThua)).nguoiDung).toBeNull();

    const nhatKy = await prisma.auditLog.findMany({
      where: { actorId: userId, hanhDong: "DOI_MAT_KHAU_LAN_DAU" },
      select: { ketQua: true, ghiChu: true },
    });
    expect(nhatKy).toEqual(
      expect.arrayContaining([
        { ketQua: "OK", ghiChu: null },
        { ketQua: "LOI", ghiChu: { lyDo: "TRANG_THAI_DA_DOI" } },
      ]),
    );
    expect(nhatKy).toHaveLength(2);
  });

  it("(c) chủ shop đặt lại MK đang giữ FOR UPDATE + đổi epoch, đổi MK lần đầu chờ khoá ⇒ TRANG_THAI_DA_DOI, hash reset không bị đè", async () => {
    const cookie = await cookieCua(userId, EPOCH_BAN_DAU);
    const chuShop = await chuShopTrongDb();
    const cookieChuShop = await cookieCua(chuShop.id, chuShop.mocPhien, false);

    // Barrier trong `datLaiMatKhau` THẬT: tới bước ghi nhật ký là dòng đã khoá, hash + cờ + epoch mới
    // đã ghi nhưng CHƯA commit — treo ở đó tới khi được thả.
    const daKhoa = deferred<void>();
    const choCommit = deferred<void>();
    vi.mocked(ghiNhatKy).mockImplementation(async (db, p) => {
      await nhatKyThat.ghiNhatKy(db, p);
      if (p.hanhDong === "TAI_KHOAN_DAT_LAI_MK") {
        daKhoa.resolve();
        await choCommit.promise;
      }
    });

    const reset = trongRequest(cookieChuShop, () => datLaiMatKhau(userId));
    await daKhoa.promise;

    // Chưa commit ⇒ đọc phiên (MVCC) vẫn thấy epoch cũ và cho qua; tới SELECT … FOR UPDATE thì chờ.
    const doiMk = trongRequest(cookie, () => doiMatKhauLanDau(formMoi(MK_MOI_1)));
    await choCoPhienChoKhoa();

    choCommit.resolve();
    const { ketQua: kqReset } = await reset;
    const { ketQua, kho } = await doiMk;

    expect(kqReset.ok).toBe(true);
    expect(ketQua).toEqual(LOI_TRANG_THAI);
    const dong = await dongUser();
    if (!kqReset.ok) return;
    expect(await verifyPassword(kqReset.data.matKhauTam, dong.passwordHash)).toBe(true);
    expect(await verifyPassword(MK_MOI_1, dong.passwordHash)).toBe(false);
    expect(dong.mustChangePassword).toBe(true);
    expect((await kiemKho(cookie)).nguoiDung).toBeNull();
    expect(kho.get(TEN_COOKIE)).toEqual(cookie.get(TEN_COOKIE)); // không cấp cookie mới
  });

  it("(d) tài khoản bị khoá (isActive=false) ngay lúc chờ khoá dòng, epoch KHÔNG đổi ⇒ TRANG_THAI_DA_DOI, hash không đổi", async () => {
    const cookie = await cookieCua(userId, EPOCH_BAN_DAU);
    const truoc = await dongUser();

    // Giao dịch giữ khoá dòng: tắt isActive nhưng KHÔNG đổi epoch/cờ phải đổi — chỉ điều kiện isActive
    // trong câu đối chiếu dưới khoá mới chặn được lượt đổi mật khẩu đang chờ.
    const daKhoa = deferred<void>();
    const choCommit = deferred<void>();
    const khoa = prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`UPDATE "User" SET "isActive" = false WHERE "id" = ${userId}`;
        daKhoa.resolve();
        await choCommit.promise;
      },
      { timeout: 30_000 },
    );
    await daKhoa.promise;

    // Chưa commit ⇒ đọc phiên (MVCC) vẫn thấy isActive=true và cho qua; tới SELECT … FOR UPDATE thì chờ.
    const doiMk = trongRequest(cookie, () => doiMatKhauLanDau(formMoi(MK_MOI_1)));
    await choCoPhienChoKhoa();
    choCommit.resolve();
    await khoa;
    const { ketQua, kho } = await doiMk;

    expect(ketQua).toEqual(LOI_TRANG_THAI);
    const dong = await dongUser();
    expect(dong.passwordHash).toBe(truoc.passwordHash);
    expect(dong.mustChangePassword).toBe(true);
    expect(dong.sessionEpoch).toBe(EPOCH_BAN_DAU);
    expect(kho.get(TEN_COOKIE)).toEqual(cookie.get(TEN_COOKIE)); // không cấp cookie mới
  });
});
