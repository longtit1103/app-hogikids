import { execFileSync } from "node:child_process";

import { giuKhoaDocQuyenDbTest, KHOA_PLAYWRIGHT } from "../helpers/khoa-doc-quyen-db-test";
import { TEST_USER_EMAIL, TEST_USER_PASSWORD } from "./test-constants";
import { forceE2eDatabaseUrl } from "./test-database-url";

/**
 * Playwright global setup.
 *
 * Runs once, in the Playwright RUNNER process (not the spawned `next dev`
 * webServer), before any test file executes. It forces DATABASE_URL onto
 * the test database before anything in the runner process could statically
 * import the Prisma singleton — dev's Postgres is shared with prod, so any
 * test helper that queries Prisma directly (reset/seed helpers, DB
 * assertions) must never resolve against `.env`'s prod DATABASE_URL.
 *
 * Beyond the environment guard, this also provisions the e2e test database for
 * the auth e2e (tests/e2e/auth.spec.ts): applies the Prisma schema, then resets
 * and reseeds a single known test user with a real scrypt hash so the login
 * flow can be exercised against actual credentials.
 */
export default async function globalSetup(): Promise<() => Promise<void>> {
  // Guard chống xoá nhầm DB PROD, dùng CHUNG với playwright.config.ts (seedTestUser() bên dưới chạy
  // prisma.user.deleteMany({})). Hàm này chốt URL rồi mới ghi đè DATABASE_URL — đúng thứ tự bắt buộc.
  const e2eDatabaseUrl = forceE2eDatabaseUrl();

  // Applies any pending migrations to the (possibly empty) test database.
  // Safe to re-run — `migrate deploy` is a no-op once the schema is current.
  // Khoá độc quyền TRƯỚC khi `migrate deploy` + `seedTestUser()` (hàm sau chạy
  // `user.deleteMany({})`): hai lượt e2e chồng nhau thì lượt này xoá user giữa lúc lượt kia đang
  // đăng nhập. Cổng 3000 đã chặn phần lớn ca chạy chồng TRÊN CÙNG MÁY (`reuseExistingServer: false`
  // + lockfile của Next 16), nhưng HAI MÁY khác nhau trỏ chung một database e2e qua Tailscale thì
  // không có gì chặn — đó là lỗ mà khoá này bịt.
  const khoa = await giuKhoaDocQuyenDbTest(e2eDatabaseUrl, KHOA_PLAYWRIGHT, "Playwright e2e");

  try {
    // Applies any pending migrations to the (possibly empty) test database.
    // Safe to re-run — `migrate deploy` is a no-op once the schema is current.
    execFileSync("npx", ["prisma", "migrate", "deploy"], {
      env: { ...process.env, DATABASE_URL: e2eDatabaseUrl },
      stdio: "inherit",
    });

    await seedTestUser();
    await seedShopIds();
  } catch (e) {
    await khoa.nha(); // hỏng lúc dựng DB thì phải trả khoá ngay, đừng giam tới hết tiến trình
    throw e;
  }

  // Playwright gọi hàm trả về này như global teardown. Kể cả nó không được gọi (tiến trình bị
  // giết), khoá vẫn tự nhả khi kết nối đóng — đã đo bằng `kill -9`.
  return async () => {
    await khoa.nha();
  };
}

/**
 * Resets the User table to a single, known test account. Imported lazily
 * (relative path, not the "@/" alias — Playwright's own TS transform, unlike
 * vitest's configured alias, isn't guaranteed to resolve it) after
 * DATABASE_URL has been forced to the test DB and the schema exists.
 */
async function seedTestUser(): Promise<void> {
  const { PrismaClient } = await import("@prisma/client");
  const { hashPassword } = await import("../../src/lib/password");

  const prisma = new PrismaClient();
  try {
    await prisma.user.deleteMany({});
    const passwordHash = await hashPassword(TEST_USER_PASSWORD);
    await prisma.user.create({
      data: { email: TEST_USER_EMAIL, passwordHash },
    });
  } finally {
    await prisma.$disconnect();
  }
}

/**
 * Seed 4 shop id fixture vào `Setting` — app dưới webServer đọc shop id từ cấu hình
 * (src/lib/ket-noi/cau-hinh-shop.ts) nên e2e ingest sẽ bị từ chối ngay cửa nếu thiếu.
 * Cùng bộ giá trị với vitest (tests/setup.ts) — nguồn duy nhất: tests/helpers/shop-ids-fixture.ts.
 */
async function seedShopIds(): Promise<void> {
  const { PrismaClient, Prisma } = await import("@prisma/client");
  const { SEED_SHOP_ID } = await import("../helpers/shop-ids-fixture");

  const prisma = new PrismaClient();
  try {
    await prisma.$executeRaw`
      INSERT INTO "Setting" (key, value)
      VALUES ${Prisma.join(SEED_SHOP_ID.map(([k, v]) => Prisma.sql`(${k}, ${v})`))}
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value
    `;
  } finally {
    await prisma.$disconnect();
  }
}
