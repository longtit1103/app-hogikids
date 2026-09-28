import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { sqlKhoiPhucDuongDocN8n } from "@/lib/backup/run-restore";
import { KEY_N8N_DUOC_DOC, MIGRATION_VIEW_N8N_ALLOWLIST } from "@/lib/n8n/role-doc-kho-khoa";

/**
 * Mỗi lượt phục hồi đều xoá sạch quyền đọc bảng `Setting` của role n8n (`--clean --if-exists` dựng
 * lại bảng, `--no-privileges` bỏ GRANT trong dump, nhánh plain thì xoá cả schema). Không có bước cấp
 * lại thì các workflow n8n chết câm trong khi app vẫn đăng nhập bình thường. Test đọc CÂU SQL phát ra
 * nên không cần Postgres.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../..");
const doc = (p: string) => readFileSync(path.join(repoRoot, p), "utf8");

/** Bỏ comment để chỉ soi MÃ THỰC THI (comment có nhắc tên hàm là cố ý). */
function chiMaThucThi(ts: string): string {
  return ts.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*(\/\/|\*).*$/gm, "");
}

describe("cấp lại quyền đọc cho n8n sau khi phục hồi", () => {
  const sql = sqlKhoiPhucDuongDocN8n("app");

  it("cấp ĐÚNG 2 quyền cũ: USAGE trên schema + SELECT view SettingN8n", () => {
    expect(sql).toContain('GRANT USAGE ON SCHEMA "app" TO n8n_config_ro');
    expect(sql).toContain('GRANT SELECT ON "app"."SettingN8n" TO n8n_config_ro');
  });

  it("KHÔNG cấp rộng hơn — role này cố ý chỉ đọc đúng 1 bảng", () => {
    expect(sql).not.toMatch(/GRANT\s+ALL/i);
    expect(sql).not.toMatch(/ON\s+ALL\s+TABLES/i);
    expect(sql).not.toMatch(/ALTER\s+DEFAULT\s+PRIVILEGES/i);
    expect(sql).not.toMatch(/INSERT|UPDATE|DELETE|TRUNCATE|REFERENCES|TRIGGER/i);
  });

  it("KHÔNG đổi owner, KHÔNG xoá/dựng schema — thứ duy nhất nó dựng lại là chính view kho khoá", () => {
    expect(sql).not.toMatch(/REASSIGN|OWNER\s+TO|DROP\s+SCHEMA|CREATE\s+SCHEMA|DROP\s+TABLE|DELETE\s+FROM/i);
  });

  it("dựng lại ĐỊNH NGHĨA view theo allowlist hiện hành — nạp dump cũ không được đưa view về fail-open", () => {
    // Định nghĩa view nằm trong dump. Bản backup tạo trước 21/09/2026 mang bản `key NOT IN (…)`
    // phơi 43/45 key; phần cấp quyền vẫn chạy ngon nên không gì đỏ, và ô cảnh báo ở /cai-dat chỉ
    // đo QUYỀN chứ không đọc ĐỊNH NGHĨA. Câu này là chỗ duy nhất kéo view về đúng allowlist.
    expect(sql).toMatch(/CREATE OR REPLACE VIEW "app"\."SettingN8n"/);
    expect(sql).not.toMatch(/key\s+NOT\s+IN/i);
    for (const key of KEY_N8N_DUOC_DOC) expect(sql).toContain(`'${key}'`);
    expect(sql).toMatch(/security_barrier = true/);
  });

  it("chỉ dựng lại view khi bảng `Setting` còn đó — dump quá cũ thì bỏ qua, không làm hỏng lượt phục hồi", () => {
    expect(sql).toContain(`to_regclass('"app"."Setting"')`);
  });

  it("schema lấy theo tham số, KHÔNG hardcode 'app'", () => {
    const khac = sqlKhoiPhucDuongDocN8n("kho_thu");
    expect(khac).toContain('GRANT USAGE ON SCHEMA "kho_thu" TO n8n_config_ro');
    expect(khac).not.toContain('"app"');
  });

  it("thiếu role hoặc thiếu bảng thì bỏ qua, không làm hỏng lượt phục hồi", () => {
    expect(sql).toContain("SELECT 1 FROM pg_roles WHERE rolname = 'n8n_config_ro'");
    expect(sql).toContain(`to_regclass('"app"."SettingN8n"')`);
  });

  it("danh sách key ĐƯỢC ĐỌC khớp TUYỆT ĐỐI giữa hằng TS và SQL migration tạo view", () => {
    // Từ 21/09/2026 view là ALLOWLIST (fail-closed): lệch một phía thì hoặc workflow chết câm
    // (thiếu key), hoặc một bí mật lọt ra (thừa key). Lưới sâu hơn — gồm cả phép so với câu SQL
    // trong chính `n8n/*.json` — nằm ở `tests/unit/n8n/allowlist-kho-khoa-n8n.test.ts`.
    const sql = readFileSync(MIGRATION_VIEW_N8N_ALLOWLIST, "utf8");
    const cauTaoView = sql.slice(sql.indexOf("CREATE OR REPLACE VIEW")).replace(/--[^\n]*/g, "");
    const m = cauTaoView.match(/key IN \(([^)]*)\)/);
    expect(m).not.toBeNull();
    const trongSql = [...(m as RegExpMatchArray)[1].matchAll(/'([^']+)'/g)].map(([, k]) => k).sort();
    expect(trongSql).toEqual([...KEY_N8N_DUOC_DOC].sort());
  });

  it("CẢ HAI nhánh phục hồi đều gọi bước cấp lại quyền", () => {
    const ma = chiMaThucThi(doc("src/lib/backup/run-restore.ts"));
    // 1 chỗ khai báo + 1 lời gọi ở nhánh custom + 1 ở nhánh plain.
    expect(ma.match(/capLaiQuyenDocChoN8n/g)?.length).toBe(3);
  });

  it("tên role khớp đường CLI — bash và TS không dùng chung hằng được", () => {
    expect(doc("deploy/restore.sh")).toContain("n8n_config_ro");
  });
});
