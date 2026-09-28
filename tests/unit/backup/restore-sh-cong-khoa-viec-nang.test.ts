import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * `deploy/restore.sh` phải tôn trọng "khoá việc nặng" của app TRƯỚC khi DROP schema đích.
 *
 * Kịch bản hỏng: chủ shop `docker compose stop app` rồi chạy restore.sh, trong khi một script dựng
 * lại / ghi giá vốn đang chạy ở container RIÊNG (`docker compose run --rm app …`) — stop app không
 * dừng được nó. Không có cổng thì DROP đè lên đúng lúc nó đang ghi.
 *
 * Thiết kế được khoá ở đây: cổng CHỈ ĐỌC dưới `LOCK … ACCESS EXCLUSIVE`, nằm CÙNG MỘT chuỗi
 * `psql -c` với DROP (⇒ cùng một transaction: khoá đang giữ thì RAISE, rollback, schema còn nguyên).
 * Không giành/nhả, không `trap` — khoá nằm trong chính bảng sắp bị DROP.
 *
 * Test RENDER câu SQL thật (source script + thay `docker` bằng hàm in tham số cuối) thay vì so chuỗi
 * trên file: chỉ bản đã nội suy mới chứng minh `\$\$` ra `$$` và schema vào đúng chỗ.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../..");
const RESTORE_SH = path.join(repoRoot, "deploy/restore.sh");
const doc = (p: string) => readFileSync(path.join(repoRoot, p), "utf8");

/**
 * Từng lần `docker exec … psql -c <sql>` mà `drop_schema_dich` gửi đi (mỗi phần tử = một lần gọi
 * = một transaction ngầm). `docker` giả in tham số cuối + `\0` sau MỖI lần gọi để đếm được số lần —
 * nối đuôi bằng `\n` là mù với đột biến "tách cổng ra một lần psql riêng" (review 25/09).
 */
function cacLanGoiPsql(schema: string, dumpTuTao: "" | "1"): string[] {
  return execFileSync(
    "bash",
    [
      "-c",
      'source "$1"; docker() { printf "%s\\0" "${@: -1}"; }; drop_schema_dich postgres "$2" "$3"',
      "bash",
      RESTORE_SH,
      schema,
      dumpTuTao,
    ],
    { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
  )
    .split("\0")
    .filter((s) => s.length > 0);
}

/** Câu SQL của lần gọi DUY NHẤT — cổng và DROP phải nằm chung một `-c`. */
function sqlDonSchema(schema: string, dumpTuTao: "" | "1"): string {
  const goi = cacLanGoiPsql(schema, dumpTuTao);
  expect(goi).toHaveLength(1);
  return goi[0];
}

describe("restore.sh — cổng khoá việc nặng trước khi DROP schema", () => {
  const sql = sqlDonSchema("app", "");

  it("khoá dùng ĐÚNG key của app — bản song sinh của KHOA_KEY", () => {
    const ts = doc("src/lib/backup/khoa-viec-nang.ts");
    const m = ts.match(/const KHOA_KEY = "([^"]+)";/);
    expect(m).not.toBeNull();
    expect(sql).toContain(`WHERE "key" = '${(m as RegExpMatchArray)[1]}'`);
  });

  it("đọc hạn ở ĐÚNG trường 2 của giá trị `<token>|<hạn ms>|<việc>` — cùng định dạng app ghi", () => {
    const ts = doc("src/lib/backup/khoa-viec-nang.ts");
    // App ghi hạn ở trường 2 và coi khoá RẢNH khi `trường 2 < now` ⇒ cổng coi là BẬN khi `>=`.
    expect(ts).toContain("return `${token}|${Date.now() + HAN_KHOA_MS}|${viec}`;");
    expect(ts).toContain(`split_part("Setting"."value", '|', 2)::bigint < (extract(epoch from now()) * 1000)::bigint`);
    expect(sql).toContain("split_part(v, '|', 2)::bigint >= (extract(epoch from now()) * 1000)::bigint");
  });

  it("cổng đứng TRƯỚC DROP trong CÙNG một chuỗi psql -c, không có COMMIT/BEGIN; nào tách transaction", () => {
    // Đột biến "tách cổng ra một lần psql -c riêng" mở lại khe giữa lúc kiểm và lúc DROP — chỉ bắt
    // được khi đếm số lần gọi, không phải khi nối output.
    expect(cacLanGoiPsql("app", "")).toHaveLength(1);
    expect(cacLanGoiPsql("app", "1")).toHaveLength(1);
    const iCong = sql.indexOf("KHOA_VIEC_NANG_DANG_GIU");
    const iDrop = sql.indexOf('DROP SCHEMA IF EXISTS "app" CASCADE;');
    expect(iCong).toBeGreaterThan(-1);
    expect(iDrop).toBeGreaterThan(iCong);
    expect(sql).not.toMatch(/\bCOMMIT\b|\bROLLBACK\b|\bBEGIN\s*;|\bSTART\s+TRANSACTION\b/i);
  });

  it("cổng thật sự CHẶN: RAISE EXCEPTION (không phải NOTICE) khi khoá CÓ và CÒN HẠN", () => {
    // Đột biến `RAISE NOTICE` hay `IF v IS NULL` biến cổng thành vô hại mà mọi test vị trí vẫn xanh.
    expect(sql).toContain("IF v IS NOT NULL AND split_part(v, '|', 2)::bigint >=");
    expect(sql).toMatch(/RAISE EXCEPTION 'KHOA_VIEC_NANG_DANG_GIU/);
    expect(sql).not.toMatch(/RAISE (NOTICE|WARNING|INFO|LOG|DEBUG)/);
  });

  it("ép READ COMMITTED làm câu ĐẦU — cổng đọc bản khoá mới nhất dù cluster mặc định REPEATABLE READ", () => {
    expect(sql.trimStart().startsWith("SET TRANSACTION ISOLATION LEVEL READ COMMITTED;")).toBe(true);
  });

  it("có SET LOCAL lock_timeout đứng SAU SET TRANSACTION và TRƯỚC LOCK TABLE — chặn treo vô hạn khi phiên khác giữ lock Postgres trên Setting", () => {
    // `SET LOCAL` chỉ hiệu lực trong transaction hiện tại — phải ở SAU câu SET TRANSACTION (câu đó
    // bắt buộc đứng đầu) và TRƯỚC LOCK TABLE để có tác dụng lên chính lệnh LOCK đó.
    const iIsolation = sql.indexOf("SET TRANSACTION ISOLATION LEVEL READ COMMITTED;");
    const iTimeout = sql.indexOf("SET LOCAL lock_timeout");
    const iLock = sql.indexOf("LOCK TABLE");
    expect(iIsolation).toBe(0);
    expect(iTimeout).toBeGreaterThan(iIsolation);
    expect(iLock).toBeGreaterThan(iTimeout);
    expect(sql).toMatch(/SET LOCAL lock_timeout = '\d+s';/);
  });

  it("psql từ chối vì lock timeout ⇒ thông điệp lỗi gợi ý rõ, không lẫn với khoá việc nặng của app", () => {
    const r = spawnSync(
      "bash",
      [
        "-c",
        'source "$1"; docker() { echo "ERROR:  canceling statement due to lock timeout" >&2; return 3; }; set -e; drop_schema_dich postgres app ""; echo DA_DI_TIEP',
        "bash",
        RESTORE_SH,
      ],
      { encoding: "utf8" },
    );
    expect(r.status).not.toBe(0);
    expect(r.stdout).not.toContain("DA_DI_TIEP");
    expect(r.stderr).toContain("schema CÒN NGUYÊN");
    expect(r.stderr).toContain("canceling statement due to lock timeout");
    expect(r.stderr).toContain("KHÔNG phải khoá việc nặng của app");
    expect(r.stderr).toMatch(/Dừng app/);
  });

  it("áp cho CẢ HAI biến thể dọn (dump tự tạo schema hay không)", () => {
    const tuTao = sqlDonSchema("app", "1");
    expect(tuTao).toContain("KHOA_VIEC_NANG_DANG_GIU");
    expect(tuTao.indexOf("KHOA_VIEC_NANG_DANG_GIU")).toBeLessThan(tuTao.indexOf("DROP SCHEMA"));
    expect(tuTao).not.toContain("CREATE SCHEMA");
  });

  it("khoá bảng ACCESS EXCLUSIVE TRƯỚC khi đọc — không ai giành/gia hạn được giữa lúc kiểm và DROP", () => {
    const iLock = sql.indexOf('LOCK TABLE "app"."Setting" IN ACCESS EXCLUSIVE MODE;');
    const iDoc = sql.indexOf('SELECT "value" INTO v FROM "app"."Setting"');
    expect(iLock).toBeGreaterThan(-1);
    expect(iDoc).toBeGreaterThan(iLock);
  });

  it("CHỈ ĐỌC — không giành, không nhả, không sửa khoá của ai", () => {
    const cong = sql.slice(0, sql.indexOf("DROP SCHEMA"));
    expect(cong).not.toMatch(/\b(INSERT|UPDATE|DELETE)\b/i);
  });

  it("bảng khoá chưa tồn tại (DB nháp mới, cluster DR trắng) ⇒ bỏ qua cổng, không làm hỏng lượt phục hồi", () => {
    expect(sql).toContain(`IF to_regclass('"app"."Setting"') IS NULL THEN RETURN; END IF;`);
  });

  it("nội suy đúng: dollar-quote thật, schema theo tham số — không hardcode 'app'", () => {
    expect(sql).toContain("DO $$");
    expect(sql).toContain("END\n$$;");
    expect(sql).not.toContain("\\$");
    const khac = sqlDonSchema("kho_thu", "");
    expect(khac).toContain('LOCK TABLE "kho_thu"."Setting"');
    expect(khac).not.toContain('"app"');
  });

  it("MÃ NGUỒN hàm sinh SQL không có backtick — backtick trong nháy kép bash bị CHẠY như lệnh (bài học 23/09)", () => {
    // Soi MÃ NGUỒN chứ không soi output: backtick bị thực thi thì biến mất khỏi output ⇒ test soi
    // output sẽ xanh NHỜ chính lỗi đó.
    const sh = doc("deploy/restore.sh");
    const dau = sh.indexOf("sql_cong_khoa_viec_nang() {");
    const cuoi = sh.indexOf("\n}\n", dau);
    expect(dau).toBeGreaterThan(-1);
    expect(sh.slice(dau, cuoi)).not.toContain("`");
  });

  it("psql từ chối (khoá đang giữ) ⇒ hàm trả lỗi, `set -e` dừng script TRƯỚC bước nạp, kèm chỉ dẫn", () => {
    const r = spawnSync(
      "bash",
      [
        "-c",
        'source "$1"; docker() { echo "ERROR:  KHOA_VIEC_NANG_DANG_GIU" >&2; return 3; }; set -e; drop_schema_dich postgres app ""; echo DA_DI_TIEP',
        "bash",
        RESTORE_SH,
      ],
      { encoding: "utf8" },
    );
    expect(r.status).not.toBe(0);
    expect(r.stdout).not.toContain("DA_DI_TIEP");
    expect(r.stderr).toContain("schema CÒN NGUYÊN");
    expect(r.stderr).toContain("tối đa 5 phút");
  });
});
