import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * KHOÁ QUYẾT ĐỊNH 29/07: hai đường phục hồi cố ý KHÔNG tương đương.
 *
 *  - Trong app (`run-restore.ts`) chạy bằng role `hogikids`, đo được
 *    `has_database_privilege(…,'CREATE') = false` ⇒ TUYỆT ĐỐI không được tự dọn schema: DROP thì
 *    trót lọt (nó sở hữu schema) nhưng CREATE bị từ chối ⇒ xoá sạch DB rồi chết giữa chừng, đúng
 *    lúc cần cứu dữ liệu. Nên app chỉ GHI ĐÈ THEO OBJECT.
 *  - `deploy/restore.sh` chạy bằng `supabase_admin` (superuser) ⇒ THAY SẠCH được, và đó là đường
 *    dành cho sự cố thật.
 *
 * Test đọc mã nguồn thay vì chạy DB: cái cần khoá ở đây là QUYẾT ĐỊNH, và nó chỉ có thể bị lật
 * bằng cách sửa đúng mấy dòng này. Không có test, một lượt "dọn dẹp" thiện chí sau này sẽ thêm lại
 * DROP SCHEMA vào app và biến mọi lượt phục hồi thành mất dữ liệu.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../..");
const doc = (p: string) => readFileSync(path.join(repoRoot, p), "utf8");
const RESTORE_SH = path.join(repoRoot, "deploy/restore.sh");

/**
 * Render khối SQL hậu kỳ THẬT: `source` restore.sh (file tự chặn `main()` khi được source) rồi
 * chặn lệnh `docker` bằng một hàm cùng tên để in đúng tham số cuối (chuỗi SQL của `psql -c`).
 * Phải render chứ không so chuỗi trên file: khối SQL nằm trong chuỗi nháy kép của bash, chỉ bản
 * đã nội suy mới chứng minh `\$\$` ra `$$` và `$schema`/role vào đúng chỗ.
 */
function sqlHauKy(): string {
  return execFileSync(
    "bash",
    [
      "-c",
      'source "$1"; docker() { printf "%s\\n" "${@: -1}"; }; reassign_owner_scoped postgres app',
      "bash",
      RESTORE_SH,
    ],
    { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
  );
}

/** Bỏ comment khối/dòng để chỉ soi MÃ THỰC THI (bản thân comment có nhắc DROP SCHEMA là cố ý). */
function chiMaThucThi(ts: string): string {
  return ts.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*(\/\/|\*).*$/gm, "");
}

describe("phục hồi trong app — GHI ĐÈ theo object, KHÔNG tự dọn schema", () => {
  const ma = chiMaThucThi(doc("src/lib/backup/run-restore.ts"));

  it("KHÔNG có câu CREATE SCHEMA vô điều kiện — role app không có quyền đó", () => {
    // Chỉ được phép xuất hiện trong nhánh đã kiểm quyền (`donSchemaChoDumpPlain`).
    const soLanTao = ma.match(/CREATE SCHEMA/g)?.length ?? 0;
    expect(soLanTao).toBeLessThanOrEqual(1);
  });

  it("mọi lượt dọn schema đều đi qua cổng hỏi quyền TRƯỚC khi xoá", () => {
    const viTriDon = ma.indexOf("DROP SCHEMA");
    expect(viTriDon).toBeGreaterThan(-1);
    // Hàm kiểm quyền phải được định nghĩa TRƯỚC và được gọi trong cùng hàm dọn.
    expect(ma).toContain("coQuyenTaoSchema");
    const than = ma.slice(ma.indexOf("async function donSchemaChoDumpPlain"), viTriDon);
    expect(than).toContain("coQuyenTaoSchema");
  });

  it("nhánh dump custom (đường dùng thật ở prod) KHÔNG dọn schema", () => {
    // Neo bằng dòng chỉ có trong nhánh custom của `runRestore` — chuỗi `format === "custom"`
    // còn xuất hiện ở `restoreArgsFromUrl` phía trên nên không dùng làm mốc được.
    const dau = ma.indexOf('const dumpPath = tempPath(".dump")');
    expect(dau).toBeGreaterThan(-1);
    const nhanhCustom = ma.slice(dau, ma.indexOf("return { format };", dau));
    expect(nhanhCustom).not.toContain("DROP SCHEMA");
    expect(nhanhCustom).not.toContain("donSchemaChoDumpPlain");
  });
});

describe("deploy/restore.sh — THAY SẠCH (chạy bằng supabase_admin)", () => {
  const sh = doc("deploy/restore.sh");

  it("có bước dọn schema dùng chung cho cả hai định dạng", () => {
    expect(sh).toContain("drop_schema_dich()");
    expect(sh).toMatch(/drop_schema_dich "\$DB" "\$SCHEMA"/);
  });

  it("nhánh custom gọi dọn schema TRƯỚC pg_restore — `--clean` không dọn nổi object sinh sau backup", () => {
    const dau = sh.indexOf('if [[ "$fmt" == "custom" ]]');
    const cuoi = sh.indexOf("else", dau);
    const nhanhCustom = sh.slice(dau, cuoi);
    expect(nhanhCustom.indexOf("drop_schema_dich")).toBeGreaterThan(-1);
    expect(nhanhCustom.indexOf("drop_schema_dich")).toBeLessThan(nhanhCustom.indexOf("pg_restore --clean"));
  });

  it("KHÔNG tạo lại schema khi dump tự tạo — psql sẽ chết ở 'đã tồn tại' ngay sau khi vừa xoá", () => {
    expect(sh).toContain("dump_tu_tao");
    expect(sh).toMatch(/CREATE\[\[:space:\]\]\+SCHEMA/); // biểu thức dò dump có tự tạo schema không
  });

  it("mọi thao tác DB vẫn chạy bằng supabase_admin (đủ quyền tạo schema)", () => {
    expect(sh).not.toMatch(/psql -U (?!supabase_admin)/);
  });
});

/**
 * Hậu kỳ phải TRẢ LẠI ĐÚNG những gì bước "thay sạch" vừa xoá. `DROP SCHEMA … CASCADE` +
 * `pg_restore --no-owner --no-privileges` xoá cả owner lẫn ACL, nên nếu hậu kỳ chỉ đổi owner
 * bảng/sequence thì: (1) enum + function ở lại `supabase_admin` ⇒ `prisma migrate deploy` bằng role
 * app bị từ chối ở migration đụng enum/function đã tồn tại; (2) role chỉ-đọc của n8n mất quyền đọc
 * bảng `Setting` ⇒ cả 10 workflow chết ở node lấy khoá trong khi app vẫn đăng nhập bình thường.
 */
describe("deploy/restore.sh — hậu kỳ trả owner + cấp lại quyền đọc", () => {
  const sql = sqlHauKy();

  it("nội suy đúng: dollar-quote thật, schema và role vào đúng chỗ", () => {
    expect(sql).toContain("DO $$");
    expect(sql).not.toContain("\\$\\$");
    expect(sql).toContain('ALTER SCHEMA "app" OWNER TO hogikids;');
  });

  it("trả owner cho ENUM và ROUTINE, không chỉ bảng/sequence/view", () => {
    expect(sql).toContain("FROM pg_type t");
    expect(sql).toContain("typtype = 'e'");
    expect(sql).toContain("ALTER TYPE %I.%I OWNER TO hogikids");
    expect(sql).toContain("FROM pg_proc p");
    expect(sql).toContain("pg_get_function_identity_arguments");
    expect(sql).toContain("ALTER ROUTINE %I.%I(%s) OWNER TO hogikids");
  });

  it("cấp lại ĐÚNG 2 quyền của role chỉ-đọc n8n (USAGE schema + SELECT view SettingN8n)", () => {
    expect(sql).toContain("GRANT USAGE ON SCHEMA %I TO n8n_config_ro");
    expect(sql).toContain("GRANT SELECT ON %I.%I TO n8n_config_ro");
    expect(sql).toContain("'SettingN8n'");
    // Chiều NGƯỢC: không được trôi về cấp SELECT trên BẢNG gốc (mỗi lượt phục hồi sẽ lặng lẽ
    // mở lại quyền đọc n8nApiKey/n8nDbRoPassword cho n8n).
    expect(sql).not.toContain("'$schema', 'Setting')");
    // Không được rộng hơn 1 bảng — role này cố ý chỉ đọc kho khoá.
    expect(sql).not.toMatch(/GRANT\s+ALL/i);
    expect(sql).not.toMatch(/ON ALL TABLES/i);
    expect(sql).not.toMatch(/GRANT[^;]*(INSERT|UPDATE|DELETE)[^;]*n8n_config_ro/i);
  });

  it("thiếu role n8n thì bỏ qua, không làm gãy hậu kỳ", () => {
    expect(sql).toContain("IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'n8n_config_ro')");
  });
});
