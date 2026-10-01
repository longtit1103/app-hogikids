import { spawn } from "node:child_process";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { seedChuShop } from "../../prisma/seed-lib";
import {
  apMigrations,
  type DbMigration,
  kiemUrlMigration,
  moDbMigration,
  saoThuMucMigrations,
  xoaThuMucMigrationsTam,
} from "../helpers/db-migration-dung-mot-lan";

/**
 * Migration phân quyền (M1) NGUYÊN TỬ với đúng Prisma của repo (spec §7.1, §7.2, §8.2).
 *
 * M1 tự bọc `BEGIN;`…`COMMIT;` tường minh thay vì tin engine. Test chứng minh bằng `prisma migrate
 * deploy` thật trên DB dùng-một-lần: một câu lỗi ngay trước `COMMIT;` ⇒ schema không nửa vời
 * (không cột/bảng mới, user chưa thành OWNER), `_prisma_migrations` ghi lượt thất bại; gỡ dòng lỗi
 * rồi áp bản gốc ⇒ thành công. Kèm 2 nhánh theo số user: >1 user ⇒ M1 từ chối; DB trắng ⇒ seed
 * tạo OWNER + ShopProfile.
 */

const M1 = "20260930170000_tai_khoan_phu_phan_quyen";
const HAN = 180_000; // mỗi ca chạy 1–3 lượt `prisma migrate deploy` (~vài giây/lượt)

let db: DbMigration;
const thuMucTam: string[] = [];

function thuMuc(p: Parameters<typeof saoThuMucMigrations>[0] = {}): string {
  const d = saoThuMucMigrations(p);
  thuMucTam.push(d);
  return d;
}

const chenLoiTruocCommit = (sql: string): string => {
  expect(sql).toMatch(/^COMMIT;$/m);
  return sql.replace(/^COMMIT;$/m, 'INSERT INTO "KhongTonTai" VALUES (1);\nCOMMIT;');
};

/**
 * Gỡ khối DO kiểm sớm đứng TRƯỚC `BEGIN;` — chỉ còn chốt >1 user BÊN TRONG transaction. Khẳng định đã
 * gỡ được đúng một khối (M1 đổi hình dạng mà test vẫn xanh vì không gỡ được gì là test mù).
 */
const goKhoiKiemSom = (sql: string): string => {
  const khoi = /^DO \$\$\nDECLARE n integer;\n[\s\S]*?^END \$\$;\n(?=[\s\S]*^BEGIN;$)/m;
  expect(sql).toMatch(khoi);
  const moi = sql.replace(khoi, "");
  expect(moi.indexOf("DO $$")).toBeGreaterThan(moi.search(/^BEGIN;$/m)); // khối DO còn lại nằm SAU BEGIN
  return moi;
};

async function soDong(sql: string): Promise<number> {
  const [{ n }] = await db.prisma.$queryRawUnsafe<{ n: bigint }[]>(`SELECT count(*)::bigint AS n FROM ${sql}`);
  return Number(n);
}

async function coCot(bang: string, cot: string): Promise<boolean> {
  const rows = await db.prisma.$queryRawUnsafe<{ x: number }[]>(
    `SELECT 1 AS x FROM information_schema.columns WHERE table_schema = 'app' AND table_name = $1 AND column_name = $2`,
    bang,
    cot,
  );
  return rows.length > 0;
}

async function coBang(bang: string): Promise<boolean> {
  const rows = await db.prisma.$queryRawUnsafe<{ x: number }[]>(
    `SELECT 1 AS x FROM information_schema.tables WHERE table_schema = 'app' AND table_name = $1`,
    bang,
  );
  return rows.length > 0;
}

async function coKieu(ten: string): Promise<boolean> {
  const rows = await db.prisma.$queryRawUnsafe<{ x: number }[]>(
    `SELECT 1 AS x FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace WHERE n.nspname = 'app' AND t.typname = $1`,
    ten,
  );
  return rows.length > 0;
}

/** Schema còn nguyên đời trước M1: không cột mới, không bảng/enum mới. */
async function kiemChuaCoM1(): Promise<void> {
  for (const cot of ["role", "tenHienThi", "quyen", "isActive", "mustChangePassword", "sessionEpoch", "lastLoginAt"]) {
    expect(await coCot("User", cot), `cột User.${cot}`).toBe(false);
  }
  expect(await coBang("ShopProfile")).toBe(false);
  expect(await coBang("AuditLog")).toBe(false);
  expect(await coKieu("Role")).toBe(false);
  expect(await coKieu("KetQuaNhatKy")).toBe(false);
}

/** DB trắng → áp mọi migration TRỪ M1 → 1 user (email chưa chuẩn hoá) + `Setting.sessionEpoch = 'X'`. */
async function dungDbTruocM1MotUser(): Promise<void> {
  await db.datLai();
  apMigrations(db.url, thuMuc({ boQua: [M1] }));
  await db.prisma.$executeRawUnsafe(
    `INSERT INTO "User" ("id", "email", "passwordHash", "shopName", "shopPhone")
     VALUES ('FX-u1', '  Owner@Fixture.Test ', 'hash-cu', 'Shop Fixture', '+84-fixture')`,
  );
  await db.prisma.$executeRawUnsafe(`INSERT INTO "Setting" ("key", "value") VALUES ('sessionEpoch', 'X')`);
}

async function dongM1(): Promise<{ finished: boolean; rolledBack: boolean }[]> {
  const rows = await db.prisma.$queryRawUnsafe<{ finished: boolean; rolledBack: boolean }[]>(
    `SELECT finished_at IS NOT NULL AS finished, rolled_back_at IS NOT NULL AS "rolledBack"
     FROM "_prisma_migrations" WHERE migration_name = $1 ORDER BY started_at`,
    M1,
  );
  return rows;
}

describe("cổng DB migration dùng-một-lần", () => {
  it("từ chối DB không tận cùng _migration_test, schema khác app, hoặc trùng TEST_DATABASE_URL", () => {
    const loi = /Từ chối: DB migration phải là \*_migration_test/;
    expect(() => kiemUrlMigration("postgresql://u:p@h:5432/hogikids_test?schema=app")).toThrow(loi);
    expect(() => kiemUrlMigration("postgresql://u:p@h:5432/postgres?schema=app")).toThrow(loi);
    expect(() => kiemUrlMigration("postgresql://u:p@h:5432/hogikids_migration_test?schema=public")).toThrow(loi);
    expect(() => kiemUrlMigration("postgresql://u:p@h:5432/hogikids_migration_test")).toThrow(loi);
    expect(() => kiemUrlMigration("khong-phai-url")).toThrow(loi);
    // Neo cuối tên: hậu tố sau `_migration_test` là DB khác (vd bản sao prod), không phải DB dùng-một-lần.
    expect(() => kiemUrlMigration("postgresql://u:p@h:5432/x_migration_test_prod?schema=app")).toThrow(loi);
    // Tham số query lạ: libpq/Prisma đọc `host=` trong query ⇒ URL có thể nối sang máy khác dù phần
    // host:port trông vô hại. Chỉ `schema` được phép.
    expect(() =>
      kiemUrlMigration("postgresql://u:p@h:5432/hogikids_migration_test?schema=app&host=prod-db"),
    ).toThrow(loi);
    expect(() =>
      kiemUrlMigration("postgresql://u:p@h:5432/hogikids_migration_test?schema=app&options=-c%20search_path%3Dpublic"),
    ).toThrow(loi);

    const cu = process.env.TEST_DATABASE_URL;
    try {
      process.env.TEST_DATABASE_URL = "postgresql://u:p@h:5432/x_migration_test?schema=app";
      expect(() => kiemUrlMigration("postgresql://u:p@h:5432/x_migration_test?schema=app")).toThrow(/trùng TEST_DATABASE_URL/);
    } finally {
      process.env.TEST_DATABASE_URL = cu;
    }
    expect(() => kiemUrlMigration("postgresql://u:p@h:5432/hogikids_migration_test?schema=app")).not.toThrow();
  });
});

describe("M1 nguyên tử — prisma migrate deploy thật", () => {
  beforeAll(async () => {
    db = await moDbMigration();
  });

  afterAll(async () => {
    for (const d of thuMucTam) xoaThuMucMigrationsTam(d);
    await db?.dong();
  });

  it(
    "(a) câu lỗi ngay trước COMMIT ⇒ migrate ném, schema không nửa vời, _prisma_migrations ghi lượt hỏng",
    async () => {
      await dungDbTruocM1MotUser();

      expect(() => apMigrations(db.url, thuMuc({ suaNoiDung: { [M1]: chenLoiTruocCommit } }))).toThrow(
        /migrate deploy thất bại/,
      );

      await kiemChuaCoM1();
      const [u] = await db.prisma.$queryRawUnsafe<{ email: string; passwordHash: string }[]>(
        `SELECT "email", "passwordHash" FROM "User" WHERE "id" = 'FX-u1'`,
      );
      expect(u).toEqual({ email: "  Owner@Fixture.Test ", passwordHash: "hash-cu" }); // email chưa chuẩn hoá
      expect(await dongM1()).toEqual([{ finished: false, rolledBack: false }]);
    },
    HAN,
  );

  it(
    "(b) gỡ dòng M1 hỏng rồi áp M1 nguyên bản ⇒ OWNER, epoch copy từ Setting, ShopProfile 1 dòng",
    async () => {
      await dungDbTruocM1MotUser();
      expect(() => apMigrations(db.url, thuMuc({ suaNoiDung: { [M1]: chenLoiTruocCommit } }))).toThrow();
      await db.prisma.$executeRawUnsafe(`DELETE FROM "_prisma_migrations" WHERE migration_name = $1`, M1);

      apMigrations(db.url, thuMuc());

      const users = await db.prisma.$queryRawUnsafe<{ email: string; role: string; sessionEpoch: string }[]>(
        `SELECT "email", "role"::text AS role, "sessionEpoch" FROM "User"`,
      );
      expect(users).toEqual([{ email: "owner@fixture.test", role: "OWNER", sessionEpoch: "X" }]);
      const shop = await db.prisma.$queryRawUnsafe<{ id: number; shopName: string; shopPhone: string | null }[]>(
        `SELECT "id", "shopName", "shopPhone" FROM "ShopProfile"`,
      );
      expect(shop).toEqual([{ id: 1, shopName: "Shop Fixture", shopPhone: "+84-fixture" }]);
      expect(await dongM1()).toEqual([{ finished: true, rolledBack: false }]);
    },
    HAN,
  );

  it(
    "(c) 2 user ⇒ M1 từ chối (RAISE), không cột/bảng mới, 2 user nguyên vẹn",
    async () => {
      await db.datLai();
      apMigrations(db.url, thuMuc({ boQua: [M1] }));
      await db.prisma.$executeRawUnsafe(
        `INSERT INTO "User" ("id", "email", "passwordHash") VALUES
           ('FX-u1', 'owner@fixture.test', 'h1'), ('FX-u2', 'staff@fixture.test', 'h2')`,
      );

      let thongBao = "";
      try {
        apMigrations(db.url, thuMuc());
      } catch (e) {
        thongBao = (e as Error).message;
      }
      expect(thongBao).toMatch(/migrate deploy thất bại/);
      // Người chạy PHẢI thấy nguyên nhân thật. Prisma 6.19 nuốt thông báo RAISE nếu lỗi nằm TRONG
      // transaction M1 tự mở (kết nối kẹt "current transaction is aborted", câu ghi log thất bại của
      // Prisma bị từ chối). Vì vậy M1 đếm User ở khối DO riêng TRƯỚC `BEGIN;` — lỗi ở đó kết thúc
      // transaction ngầm của chính câu lệnh, kết nối sạch, Prisma in đúng thông báo.
      expect(thongBao).toMatch(/Nhieu hon 1 tai khoan \(2\)/);
      expect(thongBao).not.toMatch(/current transaction is aborted/);

      await kiemChuaCoM1();
      expect(await soDong(`"User"`)).toBe(2);
      expect(await dongM1()).toEqual([{ finished: false, rolledBack: false }]);
    },
    HAN,
  );

  it(
    "(d) DB trắng → migrate đủ ⇒ 0 user, 0 ShopProfile; → seedChuShop ⇒ đúng 1 OWNER + 1 ShopProfile",
    async () => {
      await db.datLai();
      apMigrations(db.url, thuMuc());
      expect(await soDong(`"User"`)).toBe(0);
      expect(await soDong(`"ShopProfile"`)).toBe(0);
      expect(await dongM1()).toEqual([{ finished: true, rolledBack: false }]);

      await seedChuShop(db.prisma, { email: "  Owner@Fixture.Test ", password: "mat-khau-fixture" });

      const users = await db.prisma.$queryRawUnsafe<{ email: string; role: string }[]>(
        `SELECT "email", "role"::text AS role FROM "User"`,
      );
      expect(users).toEqual([{ email: "owner@fixture.test", role: "OWNER" }]);
      expect(await soDong(`"ShopProfile"`)).toBe(1);
    },
    HAN,
  );

  it(
    "(c') gỡ khối kiểm sớm, 2 user ⇒ chốt TRONG transaction vẫn từ chối, không cột mới, 2 user nguyên",
    async () => {
      await db.datLai();
      apMigrations(db.url, thuMuc({ boQua: [M1] }));
      await db.prisma.$executeRawUnsafe(
        `INSERT INTO "User" ("id", "email", "passwordHash") VALUES
           ('FX-u1', 'owner@fixture.test', 'h1'), ('FX-u2', 'staff@fixture.test', 'h2')`,
      );

      // Không đòi thông báo RAISE: lỗi nằm sau `BEGIN;` nên Prisma chỉ in "current transaction is
      // aborted" (xem comment đầu M1) — test này chỉ khoá HÀNH VI của chốt thật.
      expect(() => apMigrations(db.url, thuMuc({ suaNoiDung: { [M1]: goKhoiKiemSom } }))).toThrow(
        /migrate deploy thất bại/,
      );

      await kiemChuaCoM1();
      expect(await soDong(`"User"`)).toBe(2);
    },
    HAN,
  );

  it(
    "(e) phiên khác giữ khoá trên User ⇒ M1 dừng nhờ lock_timeout (không treo), schema không nửa vời",
    async () => {
      await dungDbTruocM1MotUser();

      // Phiên giữ khoá là tiến trình `psql` RIÊNG, tự nhả sau GIU_S giây: `apMigrations` chạy đồng bộ
      // (chặn event loop) nên một khoá giữ bằng client trong tiến trình này không bao giờ được nhả kịp.
      // Thiếu lock_timeout thì M1 chờ tới lúc khoá tự nhả rồi áp THÀNH CÔNG ⇒ test đỏ (không treo).
      const GIU_S = 45;
      const APP_GIU_KHOA = "m1-test-giu-khoa-user";
      const urlPsql = new URL(db.url);
      urlPsql.search = ""; // psql không hiểu `?schema=`
      const giuKhoa = spawn(
        "psql",
        [
          "-X",
          "-v",
          "ON_ERROR_STOP=1",
          "-d",
          urlPsql.toString(),
          "-c",
          `BEGIN; LOCK TABLE app."User" IN ACCESS SHARE MODE; SELECT pg_sleep(${GIU_S}); COMMIT;`,
        ],
        { stdio: "ignore", env: { ...process.env, PGAPPNAME: APP_GIU_KHOA } },
      );
      try {
        // Chờ khoá THẬT SỰ được giữ trước khi chạy M1 (không thì M1 thắng đua và test xanh vô nghĩa).
        const hanCho = Date.now() + 10_000;
        for (;;) {
          const [{ n }] = await db.prisma.$queryRawUnsafe<{ n: bigint }[]>(
            `SELECT count(*)::bigint AS n FROM pg_locks l JOIN pg_class c ON c.oid = l.relation
             JOIN pg_namespace ns ON ns.oid = c.relnamespace
             WHERE ns.nspname = 'app' AND c.relname = 'User' AND l.granted AND l.pid <> pg_backend_pid()`,
          );
          if (Number(n) > 0) break;
          if (Date.now() > hanCho) throw new Error("psql giữ khoá không kịp khởi động trong 10s");
          await new Promise((r) => setTimeout(r, 100));
        }

        const batDau = Date.now();
        expect(() => apMigrations(db.url, thuMuc())).toThrow(/migrate deploy thất bại/);
        expect(Date.now() - batDau).toBeLessThan(GIU_S * 1000); // dừng vì lock_timeout, không phải chờ nhả

        await kiemChuaCoM1();
        expect(await dongM1()).toEqual([{ finished: false, rolledBack: false }]);
      } finally {
        giuKhoa.kill();
        // Giết psql chưa đủ: backend đang `pg_sleep` không tự biết client đã đi, vẫn giữ khoá tới hết
        // GIU_S ⇒ `datLai()` của ca sau chờ theo. Kết thúc thẳng backend đó (cùng role ⇒ được phép).
        await db.prisma.$queryRawUnsafe(
          `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name = $1`,
          APP_GIU_KHOA,
        );
      }
    },
    HAN,
  );

  it(
    "(f) index User_email_lower_key chặn 2 email chỉ khác hoa/thường (raw SQL, bỏ qua chuẩn hoá của app)",
    async () => {
      await db.datLai();
      apMigrations(db.url, thuMuc());
      await db.prisma.$executeRawUnsafe(
        `INSERT INTO "User" ("id", "email", "passwordHash") VALUES ('FX-u1', 'Owner@Fixture.Test', 'h1')`,
      );

      await expect(
        db.prisma.$executeRawUnsafe(
          `INSERT INTO "User" ("id", "email", "passwordHash") VALUES ('FX-u2', 'owner@fixture.test', 'h2')`,
        ),
        // Postgres không nêu tên index trong câu lỗi mà nêu BIỂU THỨC khoá — `lower(email)` chỉ có thể
        // đến từ `User_email_lower_key` (unique `email` thường không chặn 2 chuỗi khác hoa/thường).
      ).rejects.toThrow(/Code: `23505`[\s\S]*Key \(lower\(email\)\)=\(owner@fixture\.test\) already exists/);
      expect(await soDong(`"User"`)).toBe(1);
    },
    HAN,
  );
});
