import { afterAll, afterEach, describe, expect, it } from "vitest";

import { prisma } from "@/lib/prisma";

import { ghiN8nDb } from "../../scripts/setup-clone/ghi-setting-ban-dau";
import type { ThamSo } from "../../scripts/setup-clone/kiem-env-va-chan-db";

/**
 * `ghiN8nDb` suy `n8nDbSsl` (chế độ TLS của credential Postgres mà n8n dựng) từ `DATABASE_URL` của app: URL đã
 * đòi TLS (`sslmode=require` / `verify-full`) hoặc host Supabase cloud ⇒ `require`; còn lại ⇒ `disable`.
 * Suy hụt `verify-full` là credential n8n đi RÕ qua Internet trong khi app đi TLS. Ghi vào bảng `Setting` của DB
 * TEST (setup ép `DATABASE_URL` = `TEST_DATABASE_URL`) — URL truyền vào chỉ để suy, không nối tới.
 */
const thamSo: ThamSo = { rotateRoPassword: false, toiBietDbThat: false, khongTuongTac: true };
const KHOA_N8N = ["n8nDbHost", "n8nDbPort", "n8nDbName", "n8nDbUser", "n8nDbSsl", "n8nDbRoPassword"];

async function sslSuyRa(databaseUrl: string): Promise<string | undefined> {
  await ghiN8nDb(databaseUrl, thamSo, null);
  return (await prisma.setting.findUnique({ where: { key: "n8nDbSsl" } }))?.value;
}

afterEach(async () => {
  await prisma.setting.deleteMany({ where: { key: { in: KHOA_N8N } } });
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("ghiN8nDb suy n8nDbSsl từ sslmode của DATABASE_URL", () => {
  it.each([
    ["postgresql://u:p@db.vi-du.vn:5432/hogi?sslmode=verify-full", "require"],
    ["postgresql://u:p@db.vi-du.vn:5432/hogi?schema=app&sslmode=verify-full", "require"],
    ["postgresql://u:p@db.vi-du.vn:5432/hogi?sslmode=verify-full&schema=app", "require"],
    ["postgresql://u:p@db.vi-du.vn:5432/hogi?sslmode=require", "require"],
    ["postgresql://u:p@db.vi-du.vn:5432/hogi?schema=app&sslmode=require", "require"],
    ["postgresql://u:p@db.vi-du.vn:5432/hogi?sslmode=disable", "disable"],
    ["postgresql://u:p@db.vi-du.vn:5432/hogi?schema=app", "disable"],
    ["postgresql://u:p@db.vi-du.vn:5432/hogi", "disable"],
    // Giá trị chỉ BẮT ĐẦU bằng tên chế độ không được tính là chế độ đó.
    ["postgresql://u:p@db.vi-du.vn:5432/hogi?sslmode=verify-fullx", "disable"],
    // Host Supabase cloud luôn đòi TLS, kể cả khi URL không khai sslmode.
    ["postgresql://u:p@db.abcxyz.supabase.co:5432/postgres", "require"],
  ])("%s ⇒ %s", async (url, mong) => {
    expect(await sslSuyRa(url)).toBe(mong);
  });
});
