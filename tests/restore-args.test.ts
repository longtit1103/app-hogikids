import { gzipSync } from "node:zlib";

import { describe, expect, it } from "vitest";

import {
  assertNotArchive,
  detectRestoreFormat,
  gunzipHead,
  restoreArgsFromUrl,
} from "@/lib/backup/run-restore";

/**
 * Unit test THUẦN cho detect/assert/arg-builder phục hồi — KHÔNG cần Postgres,
 * KHÔNG exec (chỉ `runRestore` mới chạy pg_restore/psql, kiểm ở integration/thủ
 * công). Trọng tâm: nhận diện định dạng, CHẶN .tar.gz backup-toàn-server (C1),
 * và dựng args đúng + decode password.
 */
describe("detectRestoreFormat", () => {
  it("magic 'PGDMP' → custom", () => {
    expect(detectRestoreFormat(Buffer.from("PGDMP\x01\x0d", "binary"))).toBe("custom");
  });

  it("magic gzip 0x1f 0x8b → plain-gzip", () => {
    expect(detectRestoreFormat(Buffer.from([0x1f, 0x8b, 0x08]))).toBe("plain-gzip");
  });

  it("nội dung SQL thuần (không magic) → null (từ chối)", () => {
    expect(detectRestoreFormat(Buffer.from("SELECT 1"))).toBeNull();
  });
});

describe("assertNotArchive", () => {
  /** Dựng buffer 512 byte có ASCII 'ustar' tại offset 257 (magic TAR). */
  function tarHead(): Buffer {
    const buf = Buffer.alloc(512, 0);
    buf.write("./some-file", 0, "ascii"); // tên file trong header tar
    buf.write("ustar", 257, "ascii");
    return buf;
  }

  it("TAR (ustar @257) = backup-toàn-server .tar.gz → THROW (chặn C1)", () => {
    expect(() => assertNotArchive(tarHead())).toThrow();
  });

  it("bắt đầu '--\\n' (header pg_dump plain) → KHÔNG throw", () => {
    expect(() => assertNotArchive(Buffer.from("--\n-- PostgreSQL database dump\n"))).not.toThrow();
  });

  it("bắt đầu 'SET statement_timeout' → KHÔNG throw", () => {
    expect(() => assertNotArchive(Buffer.from("SET statement_timeout = 0;\n"))).not.toThrow();
  });

  it("bắt đầu 'CREATE TABLE' → KHÔNG throw", () => {
    expect(() => assertNotArchive(Buffer.from("CREATE TABLE public.\"Order\" (\n"))).not.toThrow();
  });

  it("nội dung nhị phân/không-SQL → THROW", () => {
    expect(() => assertNotArchive(Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe]))).toThrow();
  });
});

describe("gunzipHead (SEC-H1 — đọc head bounded, KHÔNG bung cả file vào RAM)", () => {
  it(".sql.gz hợp lệ giải nén > 4KiB → vẫn đọc đúng head SQL, không throw", () => {
    // Dump giả ~1.3MB text — gunzipSync trần với maxOutputLength 4096 sẽ THROW
    // trên file này; gunzipHead phải đọc được head vì chỉ đưa 4KiB nén đầu vào zlib.
    const sql = "--\n-- PostgreSQL database dump\n" + "INSERT INTO t VALUES (1);\n".repeat(50_000);
    const head = gunzipHead(gzipSync(Buffer.from(sql)));

    expect(head.length).toBeLessThanOrEqual(512);
    expect(head.toString("utf8").startsWith("--\n-- PostgreSQL database dump")).toBe(true);
    expect(() => assertNotArchive(head)).not.toThrow();
  });

  it("gzip-bomb (64MiB số 0 nén còn ~64KiB) → output bị chặn, không nở toàn phần", () => {
    const bomb = gzipSync(Buffer.alloc(64 * 1024 * 1024, 0));
    // Input nén đưa vào zlib bị cắt 4KiB ⇒ output tối đa ~4.2MiB (deflate 1032×),
    // head trả về ≤ 512 byte — không thể OOM dù bomb to cỡ nào.
    const head = gunzipHead(bomb);
    expect(head.length).toBeLessThanOrEqual(512);
  });

  it(".tar.gz backup-toàn-server → head vẫn lộ magic ustar cho assertNotArchive chặn (C1)", () => {
    const tar = Buffer.alloc(1024, 0);
    tar.write("./some-file", 0, "ascii");
    tar.write("ustar", 257, "ascii");
    expect(() => assertNotArchive(gunzipHead(gzipSync(tar)))).toThrow();
  });

  it("không phải gzip → throw (giữ hành vi từ chối file hỏng)", () => {
    expect(() => gunzipHead(Buffer.from("not gzip at all"))).toThrow();
  });
});

describe("restoreArgsFromUrl", () => {
  const url = "postgresql://u:p%40ss@supabase-db:5432/hogikids";

  it("custom → pg_restore với --clean --if-exists --no-owner --no-privileges --exit-on-error + conn + PGPASSWORD decode", () => {
    const { cmd, args, env } = restoreArgsFromUrl(url, "custom");

    expect(cmd).toBe("pg_restore");
    expect(args).toEqual([
      "--clean",
      "--if-exists",
      "--no-owner",
      "--no-privileges",
      "--exit-on-error",
      "-n",
      "public",
      "-h",
      "supabase-db",
      "-p",
      "5432",
      "-U",
      "u",
      "-d",
      "hogikids",
    ]);
    // Fail loud: cờ dừng ở lỗi đầu tiên PHẢI có mặt (restore hỏng một phần → non-zero).
    expect(args).toContain("--exit-on-error");
    expect(env.PGPASSWORD).toBe("p@ss");
  });

  it("plain-gzip → psql với -v ON_ERROR_STOP=1", () => {
    const { cmd, args, env } = restoreArgsFromUrl(url, "plain-gzip");

    expect(cmd).toBe("psql");
    expect(args).toEqual([
      "-h",
      "supabase-db",
      "-p",
      "5432",
      "-U",
      "u",
      "-d",
      "hogikids",
      "-v",
      "ON_ERROR_STOP=1",
    ]);
    expect(env.PGPASSWORD).toBe("p@ss");
  });

  it("URL không ghi cổng → port mặc định '5432'", () => {
    const { args } = restoreArgsFromUrl("postgresql://u:pw@supabase-db/hogikids", "custom");
    expect(args).toContain("-p");
    expect(args[args.indexOf("-p") + 1]).toBe("5432");
  });
});
