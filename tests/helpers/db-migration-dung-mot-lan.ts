import { execFileSync } from "node:child_process";
import { copyFileSync, cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { PrismaClient } from "@prisma/client";

import { giuKhoaDocQuyenDbTest, type KhoaDaGiu } from "./khoa-doc-quyen-db-test";

/**
 * DB migration DÙNG MỘT LẦN (`TEST_DATABASE_URL_MIGRATION`) cho test chạy `prisma migrate deploy`
 * thật của repo trên schema `app` bị DROP/CREATE tự do.
 *
 * TÁCH HẲN khỏi `TEST_DATABASE_URL`: test ở đây xoá cả schema — trỏ nhầm là mất sạch dữ liệu test
 * đang dùng (hoặc tệ hơn, DB thật). Vì vậy mọi lệnh phá huỷ đi sau một CỔNG kiểm URL
 * (`kiemUrlMigration`): tên database phải tận cùng `_migration_test`, schema phải là `app`, query
 * không có tham số nào khác ngoài `schema`, và KHÔNG được trùng database của
 * `TEST_DATABASE_URL`/`DATABASE_URL`.
 *
 * Chạy chồng: hai lượt Vitest cùng lúc trên một DB migration sẽ DROP schema của nhau giữa chừng ⇒
 * `moDbMigration()` giành khoá tư vấn riêng (`KHOA_VITEST_MIGRATION`) suốt vòng đời, cùng cơ chế
 * `khoa-doc-quyen-db-test.ts`. Trong một lượt, `fileParallelism: false` (vitest.config.ts) đã xếp
 * các file tuần tự.
 */

/** Khoá tư vấn riêng cho DB migration — khác mọi số khoá khác trong hệ (xem khoa-doc-quyen-db-test.ts). */
export const KHOA_VITEST_MIGRATION = 260_930_001;

const THU_MUC_MIGRATIONS_REPO = path.resolve(process.cwd(), "prisma/migrations");
const SCHEMA_PRISMA_REPO = path.resolve(process.cwd(), "prisma/schema.prisma");

const LOI_TU_CHOI = "Từ chối: DB migration phải là *_migration_test — không dùng TEST_DATABASE_URL/DB thật";

function tenDatabase(url: string): string {
  return decodeURIComponent(new URL(url).pathname.replace(/^\//, ""));
}

function cungDatabase(a: string, b: string): boolean {
  const ua = new URL(a);
  const ub = new URL(b);
  return ua.hostname === ub.hostname && ua.port === ub.port && tenDatabase(a) === tenDatabase(b);
}

/** Cổng an toàn — gọi TRƯỚC mọi lệnh phá huỷ/migrate. Ném nếu URL không phải DB migration dùng-một-lần. */
export function kiemUrlMigration(url: string): void {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new Error(`${LOI_TU_CHOI} (URL không đọc được)`);
  }
  if (!/_migration_test$/.test(tenDatabase(url))) throw new Error(LOI_TU_CHOI);
  if (u.searchParams.get("schema") !== "app") throw new Error(`${LOI_TU_CHOI} (schema phải là app)`);
  // CHỈ `schema` — libpq/Prisma đọc cả `host=`, `port=`, `options=`… trong query, nên một tham số lạ
  // có thể lái kết nối sang máy/DB khác mà phần `host:port/tên` vẫn trông đúng.
  const thamSoLa = [...u.searchParams.keys()].filter((k) => k !== "schema");
  if (thamSoLa.length > 0) throw new Error(`${LOI_TU_CHOI} (tham số query lạ: ${thamSoLa.join(", ")})`);
  for (const ten of ["TEST_DATABASE_URL", "DATABASE_URL"] as const) {
    const khac = process.env[ten];
    if (khac && cungDatabase(url, khac)) throw new Error(`${LOI_TU_CHOI} (trùng ${ten})`);
  }
}

export type DbMigration = {
  url: string;
  prisma: PrismaClient;
  /** `DROP SCHEMA IF EXISTS app CASCADE; CREATE SCHEMA app;` — DB về trắng, kể cả `_prisma_migrations`. */
  datLai(): Promise<void>;
  dong(): Promise<void>;
};

/** Mở DB migration dùng-một-lần: kiểm cổng, giành khoá chạy chồng, trả client trỏ đúng DB đó. */
export async function moDbMigration(): Promise<DbMigration> {
  const url = process.env.TEST_DATABASE_URL_MIGRATION;
  if (!url) {
    throw new Error(
      "Thiếu TEST_DATABASE_URL_MIGRATION — test migration cần DB dùng-một-lần riêng " +
        "(…/hogikids_migration_test?schema=app, xem .env.example).",
    );
  }
  kiemUrlMigration(url);

  const khoa: KhoaDaGiu = await giuKhoaDocQuyenDbTest(url, KHOA_VITEST_MIGRATION, "Vitest migration");
  const prisma = new PrismaClient({ datasources: { db: { url } } });

  return {
    url,
    prisma,
    datLai: async () => {
      kiemUrlMigration(url);
      await prisma.$executeRawUnsafe("DROP SCHEMA IF EXISTS app CASCADE");
      await prisma.$executeRawUnsafe("CREATE SCHEMA app");
    },
    dong: async () => {
      try {
        await prisma.$disconnect();
      } finally {
        await khoa.nha();
      }
    },
  };
}

/**
 * Chép `prisma/migrations` của repo sang thư mục tạm `<tmp>/migrations` (kèm `migration_lock.toml`).
 * `boQua`: tên thư mục migration không chép (vd M1 để dựng DB "đời trước").
 * `suaNoiDung`: tên migration → hàm biến đổi `migration.sql` (vd chèn câu lỗi trước `COMMIT;`).
 * Trả đường dẫn thư mục `migrations` tạm; người gọi dọn bằng `xoaThuMucMigrationsTam`.
 */
export function saoThuMucMigrations(
  p: { boQua?: readonly string[]; suaNoiDung?: Readonly<Record<string, (sql: string) => string>> } = {},
): string {
  const goc = mkdtempSync(path.join(tmpdir(), "hogikids-migrations-"));
  const dich = path.join(goc, "migrations");
  const boQua = new Set(p.boQua ?? []);
  cpSync(THU_MUC_MIGRATIONS_REPO, dich, {
    recursive: true,
    filter: (src) => !boQua.has(path.relative(THU_MUC_MIGRATIONS_REPO, src).split(path.sep)[0]),
  });
  for (const [ten, sua] of Object.entries(p.suaNoiDung ?? {})) {
    const file = path.join(dich, ten, "migration.sql");
    writeFileSync(file, sua(readFileSync(file, "utf8")));
  }
  return dich;
}

export function xoaThuMucMigrationsTam(thuMucMigrations: string): void {
  rmSync(path.dirname(thuMucMigrations), { recursive: true, force: true });
}

/**
 * `prisma migrate deploy` (đúng bản Prisma của repo) với thư mục migrations chỉ định. Prisma tìm
 * `migrations/` CẠNH file schema ⇒ chép `schema.prisma` vào thư mục cha của `thuMucMigrations`.
 * Lệnh thất bại (exit ≠ 0) ⇒ ném Error kèm stdout/stderr của Prisma.
 */
export function apMigrations(url: string, thuMucMigrations: string): void {
  kiemUrlMigration(url);
  if (path.basename(thuMucMigrations) !== "migrations") {
    throw new Error(`apMigrations: thư mục phải tên "migrations" (Prisma đọc cạnh schema) — nhận ${thuMucMigrations}`);
  }
  const schemaTam = path.join(path.dirname(thuMucMigrations), "schema.prisma");
  copyFileSync(SCHEMA_PRISMA_REPO, schemaTam);
  try {
    execFileSync("npx", ["prisma", "migrate", "deploy", "--schema", schemaTam], {
      env: { ...process.env, DATABASE_URL: url },
      stdio: "pipe",
      encoding: "utf8",
    });
  } catch (e) {
    const loi = e as { status?: number | null; stdout?: string; stderr?: string };
    throw new Error(
      `prisma migrate deploy thất bại (exit ${loi.status ?? "?"}):\n${loi.stdout ?? ""}\n${loi.stderr ?? ""}`,
    );
  }
}
