import { sealData } from "iron-session";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Cookie phiên sống qua migration phân quyền M1 (spec §3.1, §8.2 — Review Focus #2).
 *
 * Trước M1: epoch thu hồi là MỘT dòng toàn cục `Setting('sessionEpoch')`, cookie mang `mocPhien` =
 * dòng đó (cookie đời rất cũ không có `mocPhien`, quy về "0"). M1 copy `Setting.sessionEpoch` →
 * `User.sessionEpoch` (thiếu dòng ⇒ "0"). Hệ quả phải chứng minh bằng `prisma migrate deploy` THẬT
 * trên DB dùng-một-lần — không chỉ khẳng định:
 *  - cookie chủ shop đang dùng (mang đúng epoch toàn cục) VẪN VÀO sau deploy, không bị đá ra;
 *  - cookie đã bị thu hồi trước M1 (epoch cũ, hoặc đời không-`mocPhien` khi epoch ≠ "0") KHÔNG hồi sinh.
 *
 * Cookie seal bằng đúng bộ mật khẩu app dùng; đọc lại qua `getSession()` THẬT (chỉ giả kho cookie
 * của Next) rồi `kiemPhien(session, clientDbTam)`.
 */
const gia = vi.hoisted(() => ({ khoCookie: new Map<string, { value: string }>() }));

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => gia.khoCookie.get(name),
    set: (name: string, value: string) => {
      gia.khoCookie.set(name, { value });
    },
    delete: (name: string) => {
      gia.khoCookie.delete(name);
    },
  }),
}));

import { kiemPhien } from "@/lib/quyen/nguoi-dung-phien";
import { getSession, type SessionData } from "@/lib/session";
import { taoPrismaClient } from "@/lib/tao-prisma-client";

import {
  apMigrations,
  type DbMigration,
  moDbMigration,
  saoThuMucMigrations,
  xoaThuMucMigrationsTam,
} from "../helpers/db-migration-dung-mot-lan";

const M1 = "20260930170000_tai_khoan_phu_phan_quyen";
const TEN_COOKIE = "hogikids_session";
const EPOCH_TOAN_CUC = "1727000000000";
const EPOCH_DA_THU_HOI = "1726000000000";
const USER_ID = "FX-chu-shop";
const HAN = 180_000;

let db: DbMigration;
const thuMucTam: string[] = [];

/** Bộ mật khẩu seal giống hệt `getSessionPassword()` của `session.ts` (map id → secret). */
function matKhauPhien(): Record<string, string> {
  const secret = process.env.SESSION_SECRET;
  if (!secret || secret.length < 32) throw new Error("Test cần SESSION_SECRET (>= 32 ký tự)");
  const truoc = process.env.SESSION_SECRET_PREVIOUS;
  return truoc ? { "1": truoc, "2": secret } : { "1": secret };
}

async function seal(data: SessionData): Promise<string> {
  return sealData(data, { password: matKhauPhien(), ttl: 60 * 60 * 24 * 30 });
}

/** Đặt cookie vào kho giả, đọc qua `getSession()` thật, kiểm với client MỚI trỏ DB tạm. */
async function kiemCookie(cookie: string) {
  gia.khoCookie.clear();
  gia.khoCookie.set(TEN_COOKIE, { value: cookie });
  const session = await getSession();
  // Client mới cho mỗi lượt kiểm: schema vừa DROP/CREATE ⇒ enum `Role` mang OID mới, client cũ có
  // thể giữ câu lệnh đã chuẩn bị trên kiểu cũ.
  const client = taoPrismaClient(db.url);
  try {
    return await kiemPhien(session, client);
  } finally {
    await client.$disconnect();
  }
}

/** DB trắng → mọi migration TRỪ M1 → 1 user (đời một-tài-khoản) + tuỳ chọn dòng epoch toàn cục. */
async function dungDbTruocM1(epochToanCuc: string | null): Promise<void> {
  await db.datLai();
  const d = saoThuMucMigrations({ boQua: [M1] });
  thuMucTam.push(d);
  apMigrations(db.url, d);
  await db.prisma.$executeRawUnsafe(
    `INSERT INTO "User" ("id", "email", "passwordHash") VALUES ($1, 'owner@fixture.test', 'hash-gia')`,
    USER_ID,
  );
  if (epochToanCuc !== null) {
    await db.prisma.$executeRawUnsafe(`INSERT INTO "Setting" ("key", "value") VALUES ('sessionEpoch', $1)`, epochToanCuc);
  }
}

function apM1(): void {
  const d = saoThuMucMigrations();
  thuMucTam.push(d);
  apMigrations(db.url, d);
}

beforeAll(async () => {
  db = await moDbMigration();
});

beforeEach(() => {
  gia.khoCookie.clear();
});

afterAll(async () => {
  for (const d of thuMucTam) xoaThuMucMigrationsTam(d);
  await db?.dong();
});

describe("cookie qua M1 — Setting.sessionEpoch có giá trị", () => {
  it(
    "cookie mang đúng epoch toàn cục ⇒ VÀO (OWNER); epoch đã thu hồi hoặc cookie không mocPhien ⇒ null",
    async () => {
      await dungDbTruocM1(EPOCH_TOAN_CUC);
      // Seal TRƯỚC M1 — đúng như cookie đang nằm trong trình duyệt chủ shop lúc deploy.
      const cookieDangDung = await seal({ userId: USER_ID, mocPhien: EPOCH_TOAN_CUC, ghiNho: true });
      const cookieDaThuHoi = await seal({ userId: USER_ID, mocPhien: EPOCH_DA_THU_HOI, ghiNho: true });
      // Đời cũ không `mocPhien`: trước M1 đã bị từ chối (quy về "0" ≠ epoch toàn cục) — không được hồi sinh.
      const cookieKhongMoc = await seal({ userId: USER_ID });

      apM1();

      const [u] = await db.prisma.$queryRawUnsafe<{ sessionEpoch: string; role: string }[]>(
        `SELECT "sessionEpoch", "role"::text AS role FROM "User" WHERE "id" = $1`,
        USER_ID,
      );
      expect(u).toEqual({ sessionEpoch: EPOCH_TOAN_CUC, role: "OWNER" });

      const nd = await kiemCookie(cookieDangDung);
      expect(nd).toMatchObject({ id: USER_ID, role: "OWNER", mocPhien: EPOCH_TOAN_CUC, phaiDoiMatKhau: false });
      expect(await kiemCookie(cookieDaThuHoi)).toBeNull();
      expect(await kiemCookie(cookieKhongMoc)).toBeNull();
    },
    HAN,
  );
});

describe("cookie qua M1 — chưa từng thu hồi (không có dòng Setting.sessionEpoch)", () => {
  it(
    "M1 ghi epoch \"0\" ⇒ cookie đời cũ không mocPhien VÀO",
    async () => {
      await dungDbTruocM1(null);
      const cookieKhongMoc = await seal({ userId: USER_ID });

      apM1();

      const [u] = await db.prisma.$queryRawUnsafe<{ sessionEpoch: string }[]>(
        `SELECT "sessionEpoch" FROM "User" WHERE "id" = $1`,
        USER_ID,
      );
      expect(u.sessionEpoch).toBe("0");
      expect(await kiemCookie(cookieKhongMoc)).toMatchObject({ id: USER_ID, role: "OWNER", mocPhien: "0" });
    },
    HAN,
  );
});
