import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { gunzipSync } from "node:zlib";

import { PrismaClient } from "@prisma/client";
import { sealData, unsealData } from "iron-session";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { hashPassword, verifyPassword } from "@/lib/password";
import { kiemPhien } from "@/lib/quyen/nguoi-dung-phien";
import type { SessionData } from "@/lib/session";

import {
  apMigrations,
  type DbMigration,
  kiemUrlMigration,
  moDbMigration,
  saoThuMucMigrations,
  xoaThuMucMigrationsTam,
} from "../helpers/db-migration-dung-mot-lan";

/**
 * Ba script SQL vận hành của đợt phân quyền (spec §7.3, §7.4) chạy ĐÚNG như người vận hành chạy:
 * `psql -X -v ON_ERROR_STOP=1 -f <file>` trên DB migration dùng-một-lần — không qua Prisma raw (Prisma
 * không nhận nhiều câu/`BEGIN` trong một lệnh) và không tách file theo `;` (tách là đổi ngữ nghĩa
 * transaction của chính file cần chứng minh).
 *
 * Kèm DIỄN TẬP quy trình host "Phục hồi dump đời trước phân quyền": `restore.sh` cần docker nên không
 * chạy trong Vitest; ở đây mô phỏng đúng các bước của nó trên DB migration — nạp fixture plain
 * `truoc-m1.sql.gz` bằng psql → `migrate deploy` (đủ M1) → script thu hồi phiên.
 */

const M1 = "20260930170000_tai_khoan_phu_phan_quyen";
const HAN = 180_000;
const THU_MUC_DEPLOY = path.resolve(process.cwd(), "deploy");
const SQL_ROLLBACK = path.join(THU_MUC_DEPLOY, "rollback-phan-quyen-m1.sql");
const SQL_TIEN_LAI = path.join(THU_MUC_DEPLOY, "tien-lai-phan-quyen-m1.sql");
const SQL_THU_HOI = path.join(THU_MUC_DEPLOY, "thu-hoi-phien-sau-phuc-hoi.sql");
const FIXTURE_TRUOC_M1 = path.resolve(process.cwd(), "tests/fixtures/backup/truoc-m1.sql.gz");
/** Giá trị đời dump trong fixture (xem tests/fixtures/backup/README.md). */
const FIXTURE_USER_ID = "FX-user-owner";
const FIXTURE_EPOCH = "1727000000000";
const HEX32 = /^[0-9a-f]{32}$/;

let db: DbMigration;
const thuMucTam: string[] = [];

/**
 * Chạy MỘT file SQL bằng psql thật. URL phải qua cổng DB migration; bỏ `?schema=` (psql không hiểu —
 * schema đích do chính file `SET search_path = app;`). Exit ≠ 0 ⇒ ném kèm stderr của psql.
 */
function chayFileSqlBangPsql(url: string, file: string): void {
  kiemUrlMigration(url);
  const u = new URL(url);
  u.search = "";
  try {
    execFileSync("psql", ["-X", "-v", "ON_ERROR_STOP=1", "-d", u.toString(), "-f", file], {
      stdio: "pipe",
      encoding: "utf8",
    });
  } catch (e) {
    const loi = e as { status?: number | null; stderr?: string; message?: string };
    throw new Error(`psql -f ${path.basename(file)} thất bại (exit ${loi.status ?? "?"}):\n${loi.stderr ?? loi.message ?? ""}`);
  }
}

function apDuMigrations(): void {
  const d = saoThuMucMigrations();
  thuMucTam.push(d);
  apMigrations(db.url, d);
}

/** Bộ mật khẩu seal giống hệt `getSessionPassword()` của `session.ts`. */
function matKhauPhien(): Record<string, string> {
  const secret = process.env.SESSION_SECRET;
  if (!secret || secret.length < 32) throw new Error("Test cần SESSION_SECRET (>= 32 ký tự)");
  const truoc = process.env.SESSION_SECRET_PREVIOUS;
  return truoc ? { "1": truoc, "2": secret } : { "1": secret };
}

async function sealCookie(userId: string, mocPhien: string): Promise<string> {
  const data: SessionData = { userId, mocPhien, ghiNho: true };
  return sealData(data, { password: matKhauPhien(), ttl: 60 * 60 * 24 * 30 });
}

/**
 * Mở cookie rồi `kiemPhien` với client MỚI trỏ DB migration: schema vừa DROP/nạp lại ⇒ enum `Role`
 * mang OID mới, client cũ có thể giữ câu lệnh đã chuẩn bị trên kiểu cũ.
 */
async function kiemCookie(cookie: string) {
  const session = await unsealData<SessionData>(cookie, { password: matKhauPhien() });
  const client = new PrismaClient({ datasources: { db: { url: db.url } } });
  try {
    return await kiemPhien(session, client);
  } finally {
    await client.$disconnect();
  }
}

type DongUser = {
  id: string;
  role: string;
  sessionEpoch: string;
  passwordHash: string;
  mustChangePassword: boolean;
  shopName: string;
  shopPhone: string | null;
  shopLogoPath: string | null;
};

async function docUsers(): Promise<Record<string, DongUser>> {
  const rows = await db.prisma.$queryRawUnsafe<DongUser[]>(
    `SELECT "id", "role"::text AS role, "sessionEpoch", "passwordHash", "mustChangePassword",
            "shopName", "shopPhone", "shopLogoPath"
     FROM "User" ORDER BY "id"`,
  );
  return Object.fromEntries(rows.map((r) => [r.id, r]));
}

async function docEpochToanCuc(): Promise<string | null> {
  const rows = await db.prisma.$queryRawUnsafe<{ value: string }[]>(
    `SELECT "value" FROM "Setting" WHERE "key" = 'sessionEpoch'`,
  );
  return rows[0]?.value ?? null;
}

async function docDauLuiBan(): Promise<string | null> {
  const rows = await db.prisma.$queryRawUnsafe<{ value: string }[]>(
    `SELECT "value" FROM "Setting" WHERE "key" = 'phanQuyenDangLui'`,
  );
  return rows[0]?.value ?? null;
}

async function docShopProfile(): Promise<{ shopName: string; shopPhone: string | null; shopLogoPath: string | null }[]> {
  return db.prisma.$queryRawUnsafe(`SELECT "shopName", "shopPhone", "shopLogoPath" FROM "ShopProfile" ORDER BY "id"`);
}

async function soDong(sql: string): Promise<number> {
  const [{ n }] = await db.prisma.$queryRawUnsafe<{ n: bigint }[]>(`SELECT count(*)::bigint AS n FROM ${sql}`);
  return Number(n);
}

beforeAll(async () => {
  db = await moDbMigration();
});

afterAll(async () => {
  for (const d of thuMucTam) xoaThuMucMigrationsTam(d);
  await db?.dong();
});

describe("rollback M1 → tiến lại → thu hồi phiên (psql -f đúng file trong deploy/)", () => {
  const MK_CHU = "mat-khau-chu-shop-fixture";
  const MK_STAFF = "mat-khau-staff-fixture";

  it(
    "rollback đổi mọi epoch + khoá STAFF + chép ShopProfile về OWNER; tiến lại chép ngược + đổi epoch; thu hồi phiên từ chối cookie cũ",
    async () => {
      await db.datLai();
      apDuMigrations();
      const hashChu = await hashPassword(MK_CHU);
      await db.prisma.$executeRawUnsafe(`INSERT INTO "Setting" ("key", "value") VALUES ('sessionEpoch', 'epoch-toan-cuc-cu')`);
      await db.prisma.$executeRawUnsafe(
        `INSERT INTO "User" ("id", "email", "passwordHash", "role", "sessionEpoch", "shopName", "shopPhone", "shopLogoPath")
         VALUES ('FX-owner', 'owner@fixture.test', $1, 'OWNER', 'epoch-owner-cu', 'Shop cu tren User', NULL, NULL),
                ('FX-staff', 'staff@fixture.test', $2, 'STAFF', 'epoch-staff-cu', 'HogiKids', NULL, NULL)`,
        hashChu,
        await hashPassword(MK_STAFF),
      );
      // STAFF ĐÃ BỊ KHOÁ: binary cũ không biết `isActive` ⇒ hash thật còn lại là tài khoản toàn quyền
      // sống lại. Rollback phải sentinel cả dòng này; thu hồi phiên phải đổi epoch cả dòng này (mở khoá
      // sau đó mà epoch còn đời cũ thì cookie cũ sống lại).
      await db.prisma.$executeRawUnsafe(
        `INSERT INTO "User" ("id", "email", "passwordHash", "role", "sessionEpoch", "shopName", "isActive")
         VALUES ('FX-staff-khoa', 'staff-khoa@fixture.test', $1, 'STAFF', 'epoch-staff-khoa-cu', 'Shop cua staff khoa', false)`,
        await hashPassword(MK_STAFF),
      );
      await db.prisma.$executeRawUnsafe(
        `INSERT INTO "ShopProfile" ("id", "shopName", "shopPhone", "shopLogoPath")
         VALUES (1, 'Shop sua tu khi len M1', '+84-fixture', '/uploads/logo-fixture.png')`,
      );
      const cookieChu = await sealCookie("FX-owner", "epoch-owner-cu");
      const cookieStaff = await sealCookie("FX-staff", "epoch-staff-cu");
      // Mốc đối chứng: trước script, cả hai cookie VÀO — nếu không thì "null sau script" chẳng chứng minh gì.
      expect(await kiemCookie(cookieChu)).toMatchObject({ id: "FX-owner", role: "OWNER" });
      expect(await kiemCookie(cookieStaff)).toMatchObject({ id: "FX-staff", role: "STAFF" });

      // --- rollback ---
      chayFileSqlBangPsql(db.url, SQL_ROLLBACK);

      const epochToanCuc = await docEpochToanCuc();
      expect(epochToanCuc).toMatch(HEX32);
      const sauRollback = await docUsers();
      expect(sauRollback["FX-owner"].sessionEpoch).toMatch(HEX32);
      expect(sauRollback["FX-staff"].sessionEpoch).toMatch(HEX32);
      // Ngẫu nhiên TỪNG dòng, không phải một giá trị chung (cũng không trùng epoch toàn cục).
      expect(new Set([epochToanCuc, sauRollback["FX-owner"].sessionEpoch, sauRollback["FX-staff"].sessionEpoch]).size).toBe(3);

      // STAFF: hash sentinel không khớp mật khẩu cũ, chuỗi rỗng, hay chính chuỗi sentinel.
      const staff = sauRollback["FX-staff"];
      expect(staff.passwordHash).toBe(`${"0".repeat(32)}:${"0".repeat(128)}`);
      for (const thu of [MK_STAFF, "", "0", "0".repeat(32), MK_CHU]) {
        expect(await verifyPassword(thu, staff.passwordHash), `mật khẩu thử "${thu}"`).toBe(false);
      }
      expect(staff.mustChangePassword).toBe(true);
      expect(sauRollback["FX-staff-khoa"].passwordHash, "STAFF đã khoá cũng phải sentinel").toBe(staff.passwordHash);
      expect(sauRollback["FX-staff-khoa"].mustChangePassword).toBe(true);
      // Dấu lùi bản: ISO UTC — §2b tiền kiểm, banner OWNER, và cổng của `tien-lai` đều đọc dòng này.
      expect(await docDauLuiBan()).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);

      // OWNER: mật khẩu giữ nguyên, 3 cột shop = ShopProfile.
      const chu = sauRollback["FX-owner"];
      expect(await verifyPassword(MK_CHU, chu.passwordHash)).toBe(true);
      expect(chu.mustChangePassword).toBe(false);
      expect({ shopName: chu.shopName, shopPhone: chu.shopPhone, shopLogoPath: chu.shopLogoPath }).toEqual({
        shopName: "Shop sua tu khi len M1",
        shopPhone: "+84-fixture",
        shopLogoPath: "/uploads/logo-fixture.png",
      });

      expect(await kiemCookie(cookieChu)).toBeNull();
      expect(await kiemCookie(cookieStaff)).toBeNull();

      // --- binary cũ chạy, chủ shop sửa thông tin shop (binary cũ chỉ ghi 3 cột trên User) ---
      await db.prisma.$executeRawUnsafe(
        `UPDATE "User" SET "shopName" = 'Shop sua luc rollback', "shopPhone" = '+84-sua-luc-rollback', "shopLogoPath" = NULL
         WHERE "role" = 'OWNER'`,
      );
      const cookieLucRollback = await sealCookie("FX-owner", chu.sessionEpoch);
      expect(await kiemCookie(cookieLucRollback)).not.toBeNull();

      // --- tiến lại ---
      chayFileSqlBangPsql(db.url, SQL_TIEN_LAI);

      expect(await docShopProfile()).toEqual([
        { shopName: "Shop sua luc rollback", shopPhone: "+84-sua-luc-rollback", shopLogoPath: null },
      ]);
      expect(await docDauLuiBan(), "tien-lai xoá dấu lùi bản").toBeNull();
      const sauTienLai = await docUsers();
      for (const id of ["FX-owner", "FX-staff"]) {
        expect(sauTienLai[id].sessionEpoch).toMatch(HEX32);
        expect(sauTienLai[id].sessionEpoch, id).not.toBe(sauRollback[id].sessionEpoch);
      }
      expect(sauTienLai["FX-owner"].sessionEpoch).not.toBe(sauTienLai["FX-staff"].sessionEpoch);
      // STAFF vẫn khoá tới khi chủ shop đặt lại mật khẩu ở /quan-tri.
      expect(sauTienLai["FX-staff"].passwordHash).toBe(staff.passwordHash);
      expect(await kiemCookie(cookieLucRollback)).toBeNull();

      // Chạy lặp tien-lai (dấu đã xoá) ⇒ tiền kiểm chặn, KHÔNG đè ShopProfile / epoch.
      await db.prisma.$executeRawUnsafe(`UPDATE "ShopProfile" SET "shopName" = 'Shop sua tren binary moi'`);
      expect(() => chayFileSqlBangPsql(db.url, SQL_TIEN_LAI)).toThrow(/TIEN_LAI_DUNG[\s\S]*phanQuyenDangLui/);
      expect((await docShopProfile())[0].shopName).toBe("Shop sua tren binary moi");
      expect((await docUsers())["FX-owner"].sessionEpoch).toBe(sauTienLai["FX-owner"].sessionEpoch);

      // --- thu hồi phiên ---
      const cookieTruocThuHoi = await sealCookie("FX-owner", sauTienLai["FX-owner"].sessionEpoch);
      expect(await kiemCookie(cookieTruocThuHoi)).not.toBeNull();

      chayFileSqlBangPsql(db.url, SQL_THU_HOI);

      const sauThuHoi = await docUsers();
      for (const id of ["FX-owner", "FX-staff", "FX-staff-khoa"]) {
        expect(sauThuHoi[id].sessionEpoch).toMatch(HEX32);
        expect(sauThuHoi[id].sessionEpoch, id).not.toBe(sauTienLai[id].sessionEpoch);
      }
      expect(await kiemCookie(cookieTruocThuHoi)).toBeNull();
    },
    HAN,
  );
});

describe("rollback/tien-lai — ca biên", () => {
  /** DB đủ migration + 1 OWNER + ShopProfile — trạng thái ngay sau deploy M1. */
  async function dungDbSauM1(): Promise<void> {
    await db.datLai();
    apDuMigrations();
    await db.prisma.$executeRawUnsafe(
      `INSERT INTO "User" ("id", "email", "passwordHash", "role", "sessionEpoch")
       VALUES ('FX-owner', 'owner@fixture.test', 'x:y', 'OWNER', 'epoch-owner-cu')`,
    );
    await db.prisma.$executeRawUnsafe(`INSERT INTO "ShopProfile" ("id", "shopName") VALUES (1, 'Shop ho so')`);
  }

  it(
    "DB chưa từng có dòng Setting sessionEpoch ⇒ rollback vẫn TẠO epoch toàn cục (cookie mocPhien \"0\" của binary cũ chết)",
    async () => {
      await dungDbSauM1();
      expect(await docEpochToanCuc()).toBeNull();
      chayFileSqlBangPsql(db.url, SQL_ROLLBACK);
      expect(await docEpochToanCuc()).toMatch(HEX32);
    },
    HAN,
  );

  it(
    "tien-lai khi KHÔNG có dấu lùi bản ⇒ RAISE, không câu nào có hiệu lực",
    async () => {
      await dungDbSauM1();
      await db.prisma.$executeRawUnsafe(`UPDATE "User" SET "shopName" = 'Cot User cu'`);
      expect(() => chayFileSqlBangPsql(db.url, SQL_TIEN_LAI)).toThrow(/TIEN_LAI_DUNG[\s\S]*phanQuyenDangLui/);
      expect((await docShopProfile())[0].shopName).toBe("Shop ho so");
      expect((await docUsers())["FX-owner"].sessionEpoch).toBe("epoch-owner-cu");
    },
    HAN,
  );

  it(
    "tien-lai khi thiếu bảng ShopProfile (phục hồi dump đời trước M1 trong cửa sổ lùi) ⇒ RAISE chỉ sang migrate deploy",
    async () => {
      await dungDbSauM1();
      chayFileSqlBangPsql(db.url, SQL_ROLLBACK);
      await db.prisma.$executeRawUnsafe(`DROP TABLE "ShopProfile"`);
      expect(() => chayFileSqlBangPsql(db.url, SQL_TIEN_LAI)).toThrow(/TIEN_LAI_DUNG[\s\S]*ShopProfile[\s\S]*migrate deploy/);
      expect(await docDauLuiBan()).not.toBeNull();
    },
    HAN,
  );

  it(
    "tien-lai khi ShopProfile rỗng ⇒ RAISE (không UPDATE 0 dòng lặng lẽ)",
    async () => {
      await dungDbSauM1();
      chayFileSqlBangPsql(db.url, SQL_ROLLBACK);
      await db.prisma.$executeRawUnsafe(`DELETE FROM "ShopProfile"`);
      expect(() => chayFileSqlBangPsql(db.url, SQL_TIEN_LAI)).toThrow(/TIEN_LAI_DUNG[\s\S]*0 dòng/);
      expect(await docDauLuiBan()).not.toBeNull();
    },
    HAN,
  );
});

describe("diễn tập host: phục hồi dump đời trước phân quyền (spec §7.4)", () => {
  let thuMucFixture = "";

  afterAll(() => {
    if (thuMucFixture) rmSync(thuMucFixture, { recursive: true, force: true });
  });

  it(
    "nạp truoc-m1.sql.gz bằng psql → script chạy trước migrate thì hỏng NGUYÊN TỬ → migrate đủ M1 → thu hồi phiên ⇒ 1 OWNER, 1 ShopProfile, cookie đời dump bị từ chối",
    async () => {
      // Bước 2 (restore.sh): schema đích bị dọn, KHÔNG tạo lại — fixture plain tự `CREATE SCHEMA app;`
      // (khác `datLai()`: tạo trước thì ON_ERROR_STOP dừng ngay ở "schema already exists").
      kiemUrlMigration(db.url);
      await db.prisma.$executeRawUnsafe("DROP SCHEMA IF EXISTS app CASCADE");
      // Fixture giữ `ALTER … OWNER TO hogikids` như dump prod. Máy dev nối bằng chính role đó; CI nối
      // bằng superuser `ci` nên phải có role đích (NOLOGIN — chỉ để nhận quyền sở hữu).
      const coRole = await db.prisma.$queryRawUnsafe<{ x: number }[]>(
        `SELECT 1 AS x FROM pg_roles WHERE rolname = 'hogikids'`,
      );
      if (coRole.length === 0) await db.prisma.$executeRawUnsafe("CREATE ROLE hogikids NOLOGIN");

      thuMucFixture = mkdtempSync(path.join(tmpdir(), "hogikids-fixture-truoc-m1-"));
      const sqlFixture = path.join(thuMucFixture, "truoc-m1.sql");
      writeFileSync(sqlFixture, gunzipSync(readFileSync(FIXTURE_TRUOC_M1)));
      chayFileSqlBangPsql(db.url, sqlFixture);

      expect(await soDong(`"_prisma_migrations" WHERE migration_name = '${M1}'`)).toBe(0);
      expect(await docEpochToanCuc()).toBe(FIXTURE_EPOCH);

      // Chạy nhầm TRƯỚC migrate: psql dừng, exit ≠ 0 — và rollback không để lại nửa vời (câu đầu đã
      // đổi `Setting` nhưng câu sau hỏng ⇒ cả transaction lùi).
      expect(() => chayFileSqlBangPsql(db.url, SQL_THU_HOI)).toThrow(/thu-hoi-phien-sau-phuc-hoi\.sql thất bại[\s\S]*sessionEpoch/);
      expect(() => chayFileSqlBangPsql(db.url, SQL_ROLLBACK)).toThrow(/rollback-phan-quyen-m1\.sql thất bại/);
      expect(await docEpochToanCuc()).toBe(FIXTURE_EPOCH);

      // Bước 3: migrate deploy (đủ M1) — nhánh 1 user copy epoch đời dump sang User.
      apDuMigrations();
      const cookieDoiDump = await sealCookie(FIXTURE_USER_ID, FIXTURE_EPOCH);
      // Chính lỗ hổng bước 4 phải bịt: thiếu thu hồi phiên thì cookie đời dump SỐNG LẠI.
      expect(await kiemCookie(cookieDoiDump)).toMatchObject({ id: FIXTURE_USER_ID, role: "OWNER" });

      // Bước 4: thu hồi phiên.
      chayFileSqlBangPsql(db.url, SQL_THU_HOI);

      // Bước 5: kiểm.
      expect(await soDong(`"User" WHERE "role" = 'OWNER'`)).toBe(1);
      expect(await soDong(`"ShopProfile"`)).toBe(1);
      const users = Object.values(await docUsers());
      expect(users).toHaveLength(1);
      expect(users[0].sessionEpoch).toMatch(HEX32);
      expect(users[0].sessionEpoch).not.toBe(FIXTURE_EPOCH);
      expect(await kiemCookie(cookieDoiDump)).toBeNull();
    },
    HAN,
  );
});
