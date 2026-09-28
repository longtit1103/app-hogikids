import { describe, expect, it } from "vitest";

import { parsePgUrl, pgDumpArgsFromUrl } from "@/lib/backup/run-pg-dump";

/**
 * Unit test THUẦN cho arg-builder pg_dump — KHÔNG cần Postgres (chỉ `runPgDump`
 * mới thực thi binary, được kiểm ở runtime trong container). Trọng tâm: parse
 * URL đúng host/port/user/db và decode password URL-encoded.
 */
describe("pgDumpArgsFromUrl", () => {
  it("URL có password encode (p%40ss) → args đúng + PGPASSWORD giải mã 'p@ss'", () => {
    const { args, env } = pgDumpArgsFromUrl("postgresql://u:p%40ss@supabase-db:5432/hogikids");

    expect(args).toEqual(["-h", "supabase-db", "-p", "5432", "-U", "u", "-d", "hogikids", "-n", "public", "-Fc"]);
    expect(env.PGPASSWORD).toBe("p@ss");
  });

  it("URL không ghi cổng → port mặc định '5432'", () => {
    const { args } = pgDumpArgsFromUrl("postgresql://u:pw@supabase-db/hogikids");

    // -p đứng ngay sau -h host; giá trị kế tiếp là port mặc định.
    expect(args[3]).toBe("5432");
    expect(args).toEqual(["-h", "supabase-db", "-p", "5432", "-U", "u", "-d", "hogikids", "-n", "public", "-Fc"]);
  });
});

describe("parsePgUrl", () => {
  it("decode cả user lẫn password URL-encoded; db = pathname bỏ '/'", () => {
    const parsed = parsePgUrl("postgresql://us%40er:p%40ss@db-host:6543/hogikids_test");

    expect(parsed).toEqual({
      host: "db-host",
      port: "6543",
      user: "us@er",
      db: "hogikids_test",
      password: "p@ss",
      schema: "public",
    });
  });
});
