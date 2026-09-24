import { execFileSync } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, it, expect } from "vitest";

// Locks the SHELL twins of the schema guards in deploy/restore.sh. The host DR path
// (`bash deploy/restore.sh`) runs `docker exec` against the live Supabase container and
// its plain path has NO `pg_restore -n <schema>` backstop, so assert_toc_only_schema /
// assert_sql_only_schema are the ONLY defense against restoring a foreign-schema dump
// onto the shared `postgres` DB. These tests source restore.sh (which is guarded so
// sourcing never runs main()) and drive the guard functions against the fixtures.

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../..");
const RESTORE_SH = path.join(repoRoot, "deploy/restore.sh");
const fixture = (name: string) => path.join(repoRoot, "tests/fixtures/restore", name);

/** Run a sourced guard fn; return its exit code (0 = accept, non-zero = reject). */
function runGuard(
  fnCall: string,
  args: string[],
  input?: Buffer,
): number {
  try {
    execFileSync("bash", ["-c", `source "$1"; ${fnCall}`, "bash", RESTORE_SH, ...args], {
      input,
      stdio: [input ? "pipe" : "ignore", "ignore", "ignore"],
    });
    return 0;
  } catch (e) {
    return (e as { status?: number | null }).status ?? 1;
  }
}

/** assert_toc_only_schema reads the TOC on STDIN; arg is the target schema. */
const tocGuard = (schema: string, fx: string): number =>
  runGuard('assert_toc_only_schema "$2"', [schema], readFileSync(fixture(fx)));

/** assert_sql_only_schema reads a FILE; args are (schema, sqlfile). */
const sqlGuard = (schema: string, fx: string): number =>
  runGuard('assert_sql_only_schema "$2" "$3"', [schema, fixture(fx)]);

/** Như `sqlGuard` nhưng với SQL nội tuyến — cho các ca ngắn không đáng đẻ thêm file fixture. */
function sqlInline(sql: string, schema = "app"): number {
  const p = path.join(os.tmpdir(), `hogikids-inline-${process.pid}-${Math.random().toString(36).slice(2)}.sql`);
  writeFileSync(p, sql);
  try {
    return runGuard('assert_sql_only_schema "$2" "$3"', [schema, p]);
  } finally {
    rmSync(p, { force: true });
  }
}

describe("restore.sh assert_toc_only_schema (shell TOC guard)", () => {
  it("chấp nhận TOC chỉ có object schema app", () => {
    expect(tocGuard("app", "toc-app-only.txt")).toBe(0);
  });
  it("từ chối TOC có object schema public/auth (dump full-DB)", () => {
    expect(tocGuard("app", "toc-foreign.txt")).not.toBe(0);
  });
});

describe("restore.sh assert_sql_only_schema (shell plain-SQL guard)", () => {
  it("chấp nhận SQL plain chỉ đụng schema app", () => {
    expect(sqlGuard("app", "sql-app-only.sql")).toBe(0);
  });
  it("từ chối SQL có CREATE SCHEMA khác app (dump full-DB)", () => {
    expect(sqlGuard("app", "sql-foreign-schema.sql")).not.toBe(0);
  });
  it("từ chối SQL ghi vào schema hệ thống (TRUNCATE storage.objects)", () => {
    expect(sqlGuard("app", "sql-system-write.sql")).not.toBe(0);
  });
  // Finding 2 (H3): dump plain của DB `public` cũ — không có CREATE SCHEMA, public không
  // phải schema hệ thống, nên chỉ guard (e) đối xứng mới bắt được.
  it("từ chối object schema public khi đích là app (H3 — guard đối xứng)", () => {
    expect(sqlGuard("app", "sql-public-foreign.sql")).not.toBe(0);
  });
  it("chấp nhận object schema public khi đích là public (tương thích ngược)", () => {
    expect(sqlGuard("public", "sql-public-foreign.sql")).toBe(0);
  });

  // --- Bypass đã xác nhận: guard cũ neo verb ở ĐẦU DÒNG (khác TS neo đầu CÂU) nên câu
  // ghi schema ngoài đích đặt sau `;` cùng dòng, hoặc verb/qualifier tách dòng, đều lọt.
  // Đường plain KHÔNG có `-n` backstop nên phải fail-closed như twin TS.
  it("từ chối câu ghi schema ngoài đích SAU `;` cùng dòng (SELECT 1; DROP _supavisor.)", () => {
    expect(sqlGuard("app", "sql-multistatement-per-line.sql")).not.toBe(0);
  });
  it("từ chối verb tách dòng khỏi schema hệ thống (TRUNCATE\\n auth.users)", () => {
    expect(sqlGuard("app", "sql-crossline-system.sql")).not.toBe(0);
  });
  it("từ chối object public tách dòng khỏi verb (CREATE TABLE\\n public.\"Order\")", () => {
    expect(sqlGuard("app", "sql-crossline-public-foreign.sql")).not.toBe(0);
  });
  it("KHÔNG false-positive khi payload COPY chứa data giống verb+qualifier (đích app)", () => {
    expect(sqlGuard("app", "sql-copy-payload-foreign-lookalike.sql")).toBe(0);
  });

  // --- (g) meta-command psql. Đường CLI nạp bằng `psql < file` với role supabase_admin nên `\!`
  // chạy shell trong container DB. Guard (c) chỉ bắt \connect/\c.
  it("(g) từ chối meta-command chạy shell (\\! id)", () => {
    expect(sqlGuard("app", "sql-meta-command-shell.sql")).not.toBe(0);
  });
  it("(g) từ chối meta-command GIỮA câu (SELECT 1 \\g | sh)", () => {
    expect(sqlGuard("app", "sql-meta-command-giua-cau.sql")).not.toBe(0);
  });
  // Dump THẬT ở bản CRLF: mốc `FROM stdin;$` / `^\.$` của awk KHÔNG khớp `\r`, nên nếu không bỏ
  // `\r` thì payload COPY sót lại và dòng data `\N` bị từ chối oan (guard (b) cũng oan theo).
  it("KHÔNG false-positive với dump hợp lệ bản CRLF", () => {
    const lf = readFileSync(fixture("sql-app-only.sql"), "utf8");
    const crlfPath = path.join(os.tmpdir(), `hogikids-crlf-${process.pid}.sql`);
    writeFileSync(crlfPath, lf.replace(/\n/g, "\r\n"));
    try {
      expect(runGuard('assert_sql_only_schema "$2" "$3"', ["app", crlfPath])).toBe(0);
    } finally {
      rmSync(crlfPath, { force: true });
    }
  });

  // --- Cặp `\restrict`/`\unrestrict` của pg_dump ≥ 15.14 (bản vá bảo mật 08/2025). ĐO THẬT trên
  // prod 31/07: pg_dump 15.18 trong container app phát hai dòng này ở mọi dump `-Fp`. Đường CLI là
  // đường DR cho file lớn — từ chối MỌI dump plain đời mới sẽ chặn đúng lúc cần phục hồi nhất.
  it("CHẤP NHẬN dump plain có cặp \\restrict/\\unrestrict (pg_dump ≥ 15.14)", () => {
    expect(sqlGuard("app", "sql-restrict-token.sql")).toBe(0);
  });

  // --- Mốc `COPY … FROM stdin;` GIẢ giấu trong chuỗi nháy đơn đa dòng: chế độ bỏ-payload mở tới
  // dòng `\.` và xoá cả vùng đó khỏi bản soi ⇒ (b)/(e)/(g) mù, psql vẫn chạy TRUNCATE auth.users.
  it("từ chối chuỗi nháy đơn đa dòng giấu mốc COPY giả (che TRUNCATE auth.users)", () => {
    expect(sqlGuard("app", "sql-chuoi-nhay-da-dong.sql")).not.toBe(0);
  });

  // --- (f) DẠNG HÀM của SET search_path. Check (d) chỉ bắt CÂU LỆNH `SET search_path`, nên dump
  // chỉnh tay dùng set_config rồi ghi UNQUALIFIED né được cả (b) lẫn (e) — rồi chạy bằng
  // `psql -U supabase_admin` trên DB CHUNG.
  it("(f) từ chối set_config('search_path','auth',false)", () => {
    expect(sqlGuard("app", "sql-set-config-search-path.sql")).not.toBe(0);
  });
  it("(f) CHẤP NHẬN dạng chuỗi rỗng hợp lệ set_config('search_path', '', false)", () => {
    // sql-restrict-token.sql chứa đúng câu pg_dump thật phát ra → không được từ chối oan.
    expect(sqlGuard("app", "sql-restrict-token.sql")).toBe(0);
  });

  // --- `--` nằm TRONG thân dollar-quote KHÔNG phải comment: cắt từ `--` tới hết dòng làm câu
  // `TRUNCATE auth.users;` biến mất khỏi bản soi, trong khi psql coi `$$--$$` là chuỗi và VẪN chạy.
  it("từ chối `SELECT $$--$$; TRUNCATE auth.users;` — `--` trong dollar-quote không phải comment", () => {
    expect(sqlGuard("app", "sql-dollar-quote-comment.sql")).not.toBe(0);
  });

  // --- Tag dollar-quote bắt đầu bằng chữ số KHÔNG hợp lệ (đo thật PG 15.8) nên psql vẫn thực thi
  // `\! id` bên trong.
  it("từ chối $9$ \\! id $9$ — tag chữ số KHÔNG mở dollar-quote", () => {
    expect(sqlGuard("app", "sql-dollar-tag-chu-so.sql")).not.toBe(0);
  });

  // --- (d) phải soi bản đã bỏ comment: chèn comment giữa token là cùng một kiểu né với (f), vá
  // (f) mà bỏ ngỏ (d) thì kẻ tấn công chỉ việc đổi dạng câu.
  it("(d) từ chối SET search_path né bằng comment khối (SET/* x */search_path)", () => {
    expect(sqlGuard("app", "sql-set-search-path-ne-comment.sql")).not.toBe(0);
  });

  // --- Chống TỪ CHỐI OAN: set_config trong THÂN function chỉ chạy khi GỌI hàm, KHÔNG chạy lúc
  // restore ⇒ không phải vector. Giữ đối xứng với twin TS.
  it("(f) KHÔNG false-positive: set_config nằm trong thân function ($$…$$)", () => {
    expect(sqlGuard("app", "sql-set-config-than-ham.sql")).toBe(0);
  });

  // --- (i) `COPY … FROM/TO PROGRAM`: chạy lệnh hệ điều hành dưới quyền server. Ở ĐƯỜNG NÀY nó
  // nặng hơn hẳn bản app — `restore.sh` nạp bằng `-U supabase_admin` (SUPERUSER THẬT), mà
  // `COPY … PROGRAM` đòi đúng quyền đó. Check (g) không bắt được: dạng SQL thuần không có `\`.
  // 🔴 Bash GIỮ trap RETURN sau khi hàm đặt nó trả về ⇒ nó bắn THÊM một lần nữa lúc hàm KHÁC trả
  // về, khi `norm`/`normf` đã ra khỏi tầm; `set -u` biến đó thành `unbound variable` và script kết
  // thúc bằng LỖI ngay sau dòng "✓ Phục hồi xong". Đo thật trong DR diễn tập 23/09.
  // Test cũ không chạm tới vì nó chỉ gọi guard rồi thoát — phải có một hàm trả về SAU đó mới lộ.
  it("trap dọn file tạm tự gỡ — hàm trả về SAU guard không nổ `unbound variable`", () => {
    const out = execFileSync(
      "bash",
      [
        "-c",
        'source "$1"; assert_sql_only_schema "$2" "$3"; sau(){ :; }; sau; echo XONG',
        "bash",
        RESTORE_SH,
        "app",
        fixture("sql-app-only.sql"),
      ],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
    expect(out).toContain("XONG");
  });

  it("(i) từ chối COPY … FROM PROGRAM", () => {
    expect(sqlGuard("app", "sql-copy-from-program.sql")).not.toBe(0);
  });
  it("(i) từ chối COPY … TO PROGRAM (chiều rò dữ liệu ra)", () => {
    expect(sqlGuard("app", "sql-copy-to-program.sql")).not.toBe(0);
  });
  it("(i) CHẤP NHẬN dump có chữ 'program' ở tên cột, dữ liệu COPY và literal", () => {
    expect(sqlGuard("app", "sql-copy-stdin-chua-chu-program.sql")).toBe(0);
  });

  // --- (j) câu lệnh ĐẶC QUYỀN.
  it("(j) từ chối ALTER ROLE", () => {
    expect(sqlGuard("app", "sql-cau-lenh-dac-quyen.sql")).not.toBe(0);
  });
  it("(j) từ chối SECURITY DEFINER", () => {
    expect(sqlGuard("app", "sql-security-definer.sql")).not.toBe(0);
  });
  it.each([
    ["CREATE EXTENSION", "CREATE EXTENSION pg_stat_statements;\n"],
    ["CREATE ROLE", "CREATE ROLE ke_tan_cong LOGIN SUPERUSER;\n"],
    ["ALTER SYSTEM", "ALTER SYSTEM SET archive_command = 'sh -c id';\n"],
    ["CREATE LANGUAGE", "CREATE TRUSTED PROCEDURAL LANGUAGE plperlu;\n"],
  ])("(j) từ chối %s", (_ten, sql) => {
    expect(sqlInline(sql)).not.toBe(0);
  });
});
