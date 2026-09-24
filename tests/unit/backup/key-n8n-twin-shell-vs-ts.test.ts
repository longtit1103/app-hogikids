import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { sqlKhoiPhucDuongDocN8n } from "@/lib/backup/run-restore";
import { KEY_N8N_DUOC_DOC, N8N_SETTING_VIEW } from "@/lib/n8n/role-doc-kho-khoa";

/**
 * ĐỊNH NGHĨA view `SettingN8n` phải được DỰNG LẠI sau MỌI lượt phục hồi, ở CẢ HAI đường:
 *
 *  - app (`sqlKhoiPhucDuongDocN8n` trong `run-restore.ts`) — có từ 21/09/2026;
 *  - host DR (`reassign_owner_scoped` trong `deploy/restore.sh`) — thêm 22/09/2026.
 *
 * VÌ SAO (đo 22/09/2026): định nghĩa view nằm TRONG dump. Bản bash trước đó chỉ `GRANT USAGE` +
 * `GRANT SELECT`, nên phục hồi bằng đường DR — đúng đường dùng khi thảm hoạ thật — một bản backup
 * tạo TRƯỚC 21/09 sẽ đưa view về bản FAIL-OPEN cũ (`key NOT IN (…)`), phơi lại 43/45 key cho role
 * n8n, gồm cả kho token Meta/TikTok. Im lặng tuyệt đối: ô cảnh báo ở `/cai-dat` chỉ đo QUYỀN, không
 * bao giờ đọc ĐỊNH NGHĨA view.
 *
 * Test này KHÔNG chỉ so hai hằng số với nhau — đó đúng là lỗ hổng của Đợt 2 ("ba phép so chỉ so với
 * nhau nên mù tầng TIÊU THỤ"). Nó dựng ra CHÍNH CÂU SQL mà mỗi bên sẽ chạy rồi so tập key đọc được
 * từ hai câu đó.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../..");
const RESTORE_SH = path.join(repoRoot, "deploy/restore.sh");

/**
 * Chạy `reassign_owner_scoped` với `docker` bị thay bằng hàm giả CHỈ IN tham số cuối (câu SQL).
 * Nhờ vậy test soi đúng văn bản sẽ được gửi vào psql, không phải một bản dựng lại gần giống.
 */
function sqlHauKyCuaShell(schema = "app"): string {
  return execFileSync(
    "bash",
    [
      "-c",
      'source "$1"; docker() { printf "%s" "${@: -1}"; }; reassign_owner_scoped postgres "$2" 2>/dev/null',
      "bash",
      RESTORE_SH,
      schema,
    ],
    { encoding: "utf8" },
  );
}

/** Tập key trong mệnh đề `WHERE key IN ('a', 'b', …)` của câu dựng view. */
function keyTrongCauDungView(sql: string): string[] {
  const m = sql.match(/WHERE\s+key\s+IN\s*\(([^)]*)\)/i);
  if (!m) {
    throw new Error(
      "Không thấy mệnh đề `WHERE key IN (…)` trong câu dựng view — một trong hai đường phục hồi " +
        "đã thôi dựng lại ĐỊNH NGHĨA view. Sửa test này CÙNG LÚC với việc đổi đó, đừng xoá nó.",
    );
  }
  return [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
}

describe("KEY_N8N_DUOC_DOC — hai đường phục hồi dựng CÙNG một định nghĩa view", () => {
  it("bash dựng lại ĐỊNH NGHĨA view, không chỉ cấp quyền", () => {
    const sql = sqlHauKyCuaShell();
    expect(sql).toMatch(/CREATE OR REPLACE VIEW/);
    expect(sql).toMatch(/security_barrier/);
    expect(sql).toContain(`"${N8N_SETTING_VIEW}"`);
  });

  it("tập key của bash KHỚP TUYỆT ĐỐI tập key của app", () => {
    const shell = keyTrongCauDungView(sqlHauKyCuaShell());
    const ts = keyTrongCauDungView(sqlKhoiPhucDuongDocN8n("app"));
    expect([...shell].sort()).toEqual([...ts].sort());
  });

  it("cả hai khớp nguồn TS duy nhất `KEY_N8N_DUOC_DOC`", () => {
    const nguon = [...KEY_N8N_DUOC_DOC].sort();
    expect(keyTrongCauDungView(sqlHauKyCuaShell()).sort()).toEqual(nguon);
    expect(keyTrongCauDungView(sqlKhoiPhucDuongDocN8n("app")).sort()).toEqual(nguon);
  });

  it("không bên nào có key lặp (lặp = dấu hiệu merge tay hỏng)", () => {
    const shell = keyTrongCauDungView(sqlHauKyCuaShell());
    expect(shell).toHaveLength(new Set(shell).size);
  });

  /**
   * 🔴 SOI MÃ NGUỒN, KHÔNG SOI VĂN BẢN ĐÃ SINH.
   *
   * Bản đầu của test này kiểm `sqlHauKyCuaShell()` không chứa backtick — và nó MÙ với đúng lớp lỗi
   * cần bắt: backtick nằm trong chuỗi nháy KÉP của bash là command-substitution, bash THỰC THI nó
   * rồi thay bằng output, nên văn bản sinh ra KHÔNG CÒN backtick — test xanh chính vì lỗi đã xảy ra.
   *
   * Đo thật trong DR diễn tập 23/09: một comment SQL bọc backtick làm `restore.sh` chạy
   * `prisma migrate deploy` và `ERROR: must be owner of view SettingN8n` như LỆNH SHELL
   * (`prisma: command not found` · `ERROR:: command not found`), trong khi test vẫn xanh.
   *
   * Luật: trong thân `reassign_owner_scoped`, mọi dòng KHÔNG phải comment bash (`#`) đều nằm trong
   * chuỗi `psql -c "…"` hoặc là mã bash thật ⇒ TUYỆT ĐỐI không được có backtick. Comment bash thì
   * được, vì bash không nội suy bên trong `#`.
   */
  it("mã nguồn `reassign_owner_scoped` không có backtick ngoài comment bash", () => {
    const sh = readFileSync(RESTORE_SH, "utf8");
    const than = sh.slice(
      sh.indexOf("reassign_owner_scoped() {"),
      sh.indexOf("\nmain() {"),
    );
    expect(than.length).toBeGreaterThan(0);
    const pham = than
      .split("\n")
      .filter((d) => !d.trimStart().startsWith("#") && d.includes("`"));
    expect(
      pham,
      "Backtick trong chuỗi nháy kép của bash = command-substitution: bash CHẠY nó rồi thay bằng " +
        "output. Dùng dấu nháy kép hoặc bỏ hẳn dấu này trong comment SQL.",
    ).toEqual([]);
  });
});
