import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * KHE ĐUA đăng nhập / reset / đổi mật khẩu (spec §3.2, §8.2) — chạy THẬT trên DB test: `login`,
 * `changePassword`, `kiemPhien`, iron-session, khoá dòng Postgres. Chỉ giả:
 *  - kho cookie của Next — mỗi "request" một kho riêng theo `AsyncLocalStorage` (hai request cùng
 *    cookie phải là hai bản sao, không phải một Map dùng chung: lượt thắng ghi cookie mới vào kho
 *    của CHÍNH nó, không rò sang lượt kia);
 *  - `verifyPassword`/`hashPassword` bọc quanh bản thật để cắm barrier (hàm băm vẫn chạy thật).
 *
 * Nguyên tắc được chứng minh: epoch trong cookie là epoch của CHÍNH dòng đã xác thực; mọi ghi đổi
 * mật khẩu đối chiếu epoch dưới `SELECT … FOR UPDATE` ⇒ trạng thái mới hơn không bao giờ bị đè.
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

// `ghiNhatKy` bọc quanh bản THẬT (ghi vào DB test) — ca "nhật ký hỏng" ép nó ném cho đúng lượt đổi mật khẩu.
vi.mock("@/lib/nhat-ky/ghi-nhat-ky", async (importActual) => {
  const that = await importActual<typeof import("@/lib/nhat-ky/ghi-nhat-ky")>();
  return { ...that, ghiNhatKy: vi.fn(that.ghiNhatKy) };
});

vi.mock("@/lib/password", async (importActual) => {
  const that = await importActual<typeof import("@/lib/password")>();
  return { ...that, verifyPassword: vi.fn(that.verifyPassword), hashPassword: vi.fn(that.hashPassword) };
});

import { login } from "@/lib/actions/auth";
import { changePassword } from "@/lib/actions/security";
import { resetAttempts } from "@/lib/login-lockout";
import { ghiNhatKy } from "@/lib/nhat-ky/ghi-nhat-ky";
import { hashPassword, verifyPassword } from "@/lib/password";
import { prisma } from "@/lib/prisma";
import { kiemPhien } from "@/lib/quyen/nguoi-dung-phien";
import { getSession, thuHoiPhienCuaNguoi } from "@/lib/session";

import { donKhoaPhucHoi } from "../helpers/khoa-bao-tri-reset";

const that = await vi.importActual<typeof import("@/lib/password")>("@/lib/password");
const nhatKyThat = await vi.importActual<typeof import("@/lib/nhat-ky/ghi-nhat-ky")>("@/lib/nhat-ky/ghi-nhat-ky");

const EMAIL = "khe-dua@phien.test";
const MK_CU = "Mat-khau-cu-0000";
const MK_RESET = "Mat-khau-reset-9999";
const MK_MOI_1 = "Mat-khau-moi-1111";
const MK_MOI_2 = "Mat-khau-moi-2222";
const EPOCH_BAN_DAU = "a".repeat(32);
const TEN_COOKIE = "hogikids_session";

let userId = "";

type Deferred<T> = { promise: Promise<T>; resolve: (v: T) => void };
function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** Chạy `fn` như MỘT request có kho cookie riêng (bản sao `cookieVao`). Trả kết quả + kho sau cùng. */
async function trongRequest<T>(
  cookieVao: Map<string, MucCookie>,
  fn: () => Promise<T>,
): Promise<{ ketQua: T; kho: Map<string, MucCookie> }> {
  const kho = new Map(cookieVao);
  const ketQua = await gia.als.run(kho, fn);
  return { ketQua, kho };
}

/** Mở cookie trong `kho` bằng `getSession()` thật rồi kiểm với DB — `null` = cookie bị từ chối. */
async function kiemKho(kho: Map<string, MucCookie>) {
  return gia.als.run(new Map(kho), async () => {
    const session = await getSession();
    return { session: { ...session }, nguoiDung: await kiemPhien(session) };
  });
}

/** Cookie hợp lệ của user ở trạng thái hiện tại — cấp bằng một lượt `login` thật. */
async function cookieDangNhap(matKhau: string): Promise<Map<string, MucCookie>> {
  const { ketQua, kho } = await trongRequest(new Map(), () => login(formDangNhap(matKhau)));
  expect(ketQua).toEqual({ ok: true, data: undefined });
  expect(kho.has(TEN_COOKIE)).toBe(true);
  return kho;
}

function formDangNhap(matKhau: string): FormData {
  const fd = new FormData();
  fd.set("email", EMAIL);
  fd.set("password", matKhau);
  fd.set("remember", "on");
  return fd;
}

function formDoiMatKhau(hienTai: string, moi: string): FormData {
  const fd = new FormData();
  fd.set("currentPassword", hienTai);
  fd.set("newPassword", moi);
  fd.set("confirmPassword", moi);
  return fd;
}

async function dongUser() {
  return prisma.user.findUniqueOrThrow({ where: { id: userId } });
}

/** Chờ tới khi có ≥ 1 phiên Postgres đang CHỜ KHOÁ trên câu `FOR UPDATE` (barrier cho ca (c)). */
async function choCoPhienChoKhoa(hanMs = 10_000): Promise<void> {
  const batDau = Date.now();
  while (Date.now() - batDau < hanMs) {
    const [{ n }] = await prisma.$queryRaw<{ n: number }[]>`
      SELECT count(*)::int AS n FROM pg_stat_activity
      WHERE datname = current_database() AND wait_event_type = 'Lock' AND query ILIKE '%FOR UPDATE%'`;
    if (n > 0) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("Hết hạn chờ: changePassword không tới bước SELECT … FOR UPDATE");
}

beforeEach(async () => {
  donKhoaPhucHoi();
  resetAttempts(EMAIL);
  resetAttempts(`doimatkhau:${EMAIL}`);
  vi.mocked(verifyPassword).mockReset().mockImplementation(that.verifyPassword);
  vi.mocked(hashPassword).mockReset().mockImplementation(that.hashPassword);
  vi.mocked(ghiNhatKy).mockReset().mockImplementation(nhatKyThat.ghiNhatKy);
  await prisma.auditLog.deleteMany({ where: { OR: [{ actorEmail: EMAIL }, { danhTinhKhaiBao: EMAIL }] } });
  await prisma.user.deleteMany({ where: { email: EMAIL } });
  userId = (
    await prisma.user.create({
      data: { email: EMAIL, passwordHash: await that.hashPassword(MK_CU), role: "STAFF", sessionEpoch: EPOCH_BAN_DAU },
    })
  ).id;
});

afterAll(async () => {
  await prisma.auditLog.deleteMany({ where: { OR: [{ actorEmail: EMAIL }, { danhTinhKhaiBao: EMAIL }] } });
  await prisma.user.deleteMany({ where: { email: EMAIL } });
  await prisma.$disconnect();
});

describe("khe đua phiên", () => {
  it("(a) đăng nhập bằng MK cũ bị reset chen giữa lúc so hash và lúc cấp cookie ⇒ cookie mang epoch CŨ, bị từ chối", async () => {
    // Barrier: `verifyPassword` báo "đã vào" (dòng user + epoch đã đọc xong) rồi treo tới khi được thả.
    const daVao = deferred<void>();
    const tha = deferred<boolean>();
    vi.mocked(verifyPassword).mockImplementationOnce(async () => {
      daVao.resolve();
      return tha.promise;
    });

    const dangNhap = trongRequest(new Map(), () => login(formDangNhap(MK_CU)));
    await daVao.promise;

    // Reset của chủ shop chen vào đúng khe: hash mới + epoch mới, COMMIT trước khi login cấp cookie.
    const epochSauReset = await prisma.$transaction(async (tx) => {
      await tx.user.update({ where: { id: userId }, data: { passwordHash: await that.hashPassword(MK_RESET) } });
      return thuHoiPhienCuaNguoi(tx, userId);
    });
    expect(epochSauReset).not.toBe(EPOCH_BAN_DAU);

    tha.resolve(true); // mật khẩu cũ "đúng" với hash đã đọc trước reset
    const { ketQua, kho } = await dangNhap;
    // Hash login so là hash TRƯỚC reset — đúng lượt đọc mà epoch trong cookie phải đi theo.
    expect(vi.mocked(verifyPassword).mock.calls[0]?.[0]).toBe(MK_CU);
    expect(await that.verifyPassword(MK_CU, String(vi.mocked(verifyPassword).mock.calls[0]?.[1]))).toBe(true);

    // Login trả OK (đã xác thực đúng với dòng nó đọc) — nhưng cookie mang epoch của CHÍNH dòng đó.
    expect(ketQua).toEqual({ ok: true, data: undefined });
    const { session, nguoiDung } = await kiemKho(kho);
    expect(session).toMatchObject({ userId, mocPhien: EPOCH_BAN_DAU });
    expect(nguoiDung).toBeNull();
    expect((await dongUser()).sessionEpoch).toBe(epochSauReset);
  });

  it("(b) hai changePassword song song cùng một cookie ⇒ đúng 1 OK + 1 TRANG_THAI_DA_DOI; hash cuối là của lượt OK", async () => {
    const cookie = await cookieDangNhap(MK_CU);

    // Barrier: cả hai lượt phải qua cổng (đọc cùng epoch) + qua kiểm mật khẩu hiện tại rồi mới cho băm
    // xong — tức cả hai chắc chắn vào transaction với CÙNG epoch mong đợi, khoá dòng quyết người thắng.
    let soLuotBam = 0;
    const caHaiDaToi = deferred<void>();
    vi.mocked(hashPassword).mockImplementation(async (mk: string) => {
      const h = await that.hashPassword(mk);
      soLuotBam += 1;
      if (soLuotBam === 2) caHaiDaToi.resolve();
      await caHaiDaToi.promise;
      return h;
    });

    const [r1, r2] = await Promise.all([
      trongRequest(cookie, () => changePassword(formDoiMatKhau(MK_CU, MK_MOI_1))),
      trongRequest(cookie, () => changePassword(formDoiMatKhau(MK_CU, MK_MOI_2))),
    ]);

    // Cả hai lượt đã tới bước băm ⇒ cả hai đã qua cổng + kiểm mật khẩu với CÙNG epoch cookie: lượt
    // thua bị chặn ở đối chiếu dưới khoá dòng, không phải ở cổng (khác lỗi, khác thông báo).
    expect(soLuotBam).toBe(2);
    const ketQua = [r1.ketQua, r2.ketQua];
    const thang = ketQua.findIndex((k) => k.ok);
    expect(ketQua.filter((k) => k.ok)).toHaveLength(1);
    expect(ketQua[1 - thang]).toEqual({
      ok: false,
      error: "Trạng thái tài khoản đã đổi, đăng nhập lại",
      code: "TRANG_THAI_DA_DOI",
    });

    const dong = await dongUser();
    const [mkThang, mkThua] = thang === 0 ? [MK_MOI_1, MK_MOI_2] : [MK_MOI_2, MK_MOI_1];
    expect(await that.verifyPassword(mkThang, dong.passwordHash)).toBe(true);
    expect(await that.verifyPassword(mkThua, dong.passwordHash)).toBe(false);

    // Cookie lượt thắng mang đúng epoch mới; cookie lượt thua (vẫn là cookie cũ) đã hết hiệu lực.
    const khoThang = (thang === 0 ? r1 : r2).kho;
    const khoThua = (thang === 0 ? r2 : r1).kho;
    expect((await kiemKho(khoThang)).nguoiDung).toMatchObject({ id: userId, mocPhien: dong.sessionEpoch });
    expect((await kiemKho(khoThua)).nguoiDung).toBeNull();

    const nhatKy = await prisma.auditLog.findMany({
      where: { actorId: userId, hanhDong: "DOI_MAT_KHAU" },
      select: { ketQua: true, ghiChu: true },
    });
    expect(nhatKy).toHaveLength(2);
    expect(nhatKy).toEqual(
      expect.arrayContaining([
        { ketQua: "OK", ghiChu: null },
        { ketQua: "LOI", ghiChu: { lyDo: "TRANG_THAI_DA_DOI" } },
      ]),
    );
  });

  it("(c) reset đang giữ FOR UPDATE + đổi epoch, changePassword chờ khoá ⇒ TRANG_THAI_DA_DOI, hash reset không bị đè", async () => {
    const cookie = await cookieDangNhap(MK_CU);
    const hashReset = await that.hashPassword(MK_RESET);

    const daKhoa = deferred<void>();
    const choCommit = deferred<void>();
    const reset = prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT 1 FROM "User" WHERE "id" = ${userId} FOR UPDATE`;
        await tx.user.update({ where: { id: userId }, data: { passwordHash: hashReset } });
        await thuHoiPhienCuaNguoi(tx, userId);
        daKhoa.resolve();
        await choCommit.promise; // giữ khoá dòng, CHƯA commit
      },
      { timeout: 30_000 },
    );
    await daKhoa.promise;

    // Chưa commit ⇒ cổng action (đọc thường, MVCC) vẫn thấy epoch cũ và cho qua; tới SELECT … FOR UPDATE thì chờ.
    const doiMk = trongRequest(cookie, () => changePassword(formDoiMatKhau(MK_CU, MK_MOI_1)));
    await choCoPhienChoKhoa();

    choCommit.resolve();
    await reset;
    const { ketQua } = await doiMk;

    expect(ketQua).toEqual({
      ok: false,
      error: "Trạng thái tài khoản đã đổi, đăng nhập lại",
      code: "TRANG_THAI_DA_DOI",
    });
    const dong = await dongUser();
    expect(dong.passwordHash).toBe(hashReset);
    expect((await kiemKho(cookie)).nguoiDung).toBeNull();
  });

  it("(d) tài khoản bị KHOÁ (isActive=false) chen giữa cổng và khoá dòng, epoch KHÔNG đổi ⇒ TRANG_THAI_DA_DOI", async () => {
    const cookie = await cookieDangNhap(MK_CU);
    const hashTruoc = (await dongUser()).passwordHash;
    // Khoá chen vào SAU cổng (cổng đọc isActive=true) và TRƯỚC `FOR UPDATE`, cố ý KHÔNG đổi epoch:
    // đối chiếu dưới khoá dòng phải tự thấy tài khoản đã khoá, không phụ thuộc lượt khoá có đổi epoch.
    vi.mocked(hashPassword).mockImplementationOnce(async (mk: string) => {
      const h = await that.hashPassword(mk);
      await prisma.user.update({ where: { id: userId }, data: { isActive: false } });
      return h;
    });

    const { ketQua, kho } = await trongRequest(cookie, () => changePassword(formDoiMatKhau(MK_CU, MK_MOI_1)));

    expect(ketQua).toMatchObject({ ok: false, code: "TRANG_THAI_DA_DOI" });
    const dong = await dongUser();
    expect(dong.passwordHash).toBe(hashTruoc);
    expect(dong.sessionEpoch).toBe((await kiemKho(cookie)).session.mocPhien);
    expect(kho.get(TEN_COOKIE)).toEqual(cookie.get(TEN_COOKIE)); // không cấp cookie mới
  });
});

/**
 * Nhật ký OK của đổi mật khẩu PHẢI nằm TRONG transaction ghi hash + epoch (spec §5): nhật ký hỏng ⇒
 * mutation không lưu. Chạy trên Postgres thật — mock `$transaction` bằng `fn(prisma)` không phân biệt
 * được "ghi trong tx" với "ghi bằng client gốc sau commit".
 */
describe("changePassword — nhật ký OK cùng sống cùng chết với mutation", () => {
  it("ghiNhatKy ném ⇒ hash KHÔNG đổi, epoch KHÔNG đổi, không cấp cookie, trả lỗi", async () => {
    const cookie = await cookieDangNhap(MK_CU);
    const truoc = await dongUser();
    vi.mocked(ghiNhatKy).mockImplementation(async (db, p) => {
      if (p.hanhDong === "DOI_MAT_KHAU") throw new Error("nhật ký hỏng");
      return nhatKyThat.ghiNhatKy(db, p);
    });
    const log = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      const { ketQua, kho } = await trongRequest(cookie, () =>
        changePassword(formDoiMatKhau(MK_CU, MK_MOI_1)).catch((loi: unknown) => ({ nem: loi })),
      );

      const sau = await dongUser();
      expect(sau.passwordHash).toBe(truoc.passwordHash);
      expect(sau.sessionEpoch).toBe(truoc.sessionEpoch);
      expect(ketQua).toEqual({ ok: false, error: "Không lưu được mật khẩu mới — thử lại" });
      expect(kho.get(TEN_COOKIE)).toEqual(cookie.get(TEN_COOKIE));
      // Cookie cũ vẫn dùng được — không có lượt đổi mật khẩu nửa vời nào.
      expect((await kiemKho(cookie)).nguoiDung).toMatchObject({ id: userId });
    } finally {
      log.mockRestore();
    }
  });
});
