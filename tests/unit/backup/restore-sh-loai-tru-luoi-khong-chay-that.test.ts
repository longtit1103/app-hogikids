import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * LƯỚI: câu khoá đăng nhập (đổi role / thu quyền CONNECT cấp DATABASE) chỉ được nằm trong `tests/**`
 * dưới dạng CHUỖI để so — KHÔNG BAO GIỜ được chạy thật.
 *
 * Vì sao: dev và test nối CÙNG cluster với prod qua Tailscale (DB test là DB khác trên chính cluster
 * `supabase-db`, cùng role `hogikids`). Role là đối tượng TOÀN CLUSTER: một test lỡ chạy câu đổi role
 * sang không-đăng-nhập là đánh sập app prod; thu quyền CONNECT nhầm DB là cắt app/Supabase.
 *
 * Luật (soi tĩnh, không chạy gì):
 *  - File TS/JS trong `tests/**` có chứa câu đó ⇒ KHÔNG được có bất kỳ đường chạy SQL nào (Prisma raw,
 *    gói `pg`, gọi `psql`, biến URL DB).
 *  - File `.sh` trong `tests/**` có chứa câu đó ⇒ không dòng nào gọi trực tiếp `docker`/`psql`.
 *  - File `.sql` có chứa câu đó chỉ được là FIXTURE guard (`tests/fixtures/restore/`), và file test nào
 *    đọc thư mục fixture đó cũng không được có đường chạy SQL.
 *  - Stub `docker` của harness không bao giờ gọi xuyên tới docker thật.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../..");
const TESTS = path.join(repoRoot, "tests");
const FILE_NAY = path.relative(repoRoot, fileURLToPath(import.meta.url));

// Ghép chuỗi để chính file này không chứa nguyên văn câu bị cấm.
const CAU_CAM = new RegExp(["ALTER", "\\s+ROLE"].join("") + "|" + ["REVOKE", "\\s+CONNECT"].join(""), "i");
const DUONG_CHAY_SQL =
  /\$(executeRaw|queryRaw)|(executeRaw|queryRaw)Unsafe|from\s+["']pg["']|require\(\s*["']pg["']\s*\)|new\s+(Client|Pool)\s*\(|["'`]psql["'`]|DATABASE_URL/;
const DONG_GOI_DOCKER_PSQL = /^\s*(?:exec\s+|command\s+)?(?:docker|psql)\b/m;

function quetFile(thuMuc: string): string[] {
  const kq: string[] = [];
  for (const e of readdirSync(thuMuc, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name.startsWith(".")) continue;
    const p = path.join(thuMuc, e.name);
    if (e.isDirectory()) kq.push(...quetFile(p));
    else if (/\.(ts|tsx|mts|cts|js|mjs|cjs|sh|sql)$/.test(e.name)) kq.push(path.relative(repoRoot, p));
  }
  return kq;
}

const tatCa = quetFile(TESTS).filter((f) => f !== FILE_NAY);
const doc = (f: string) => readFileSync(path.join(repoRoot, f), "utf8");
const coCauCam = tatCa.filter((f) => CAU_CAM.test(doc(f)));

describe("lưới: tests/** không chạy thật câu khoá đăng nhập (role / CONNECT cấp DB)", () => {
  it("lưới thấy đúng các file đã biết — không quét rỗng", () => {
    expect(coCauCam).toEqual(
      expect.arrayContaining([
        "tests/deploy/harness/restore/docker-gia.sh",
        "tests/unit/backup/restore-sh-loai-tru-cap-db.test.ts",
        "tests/fixtures/restore/sql-cau-lenh-dac-quyen.sql",
      ]),
    );
  });

  it("file TS/JS có câu cấm ⇒ không có đường chạy SQL nào", () => {
    const vi = coCauCam
      .filter((f) => /\.(ts|tsx|mts|cts|js|mjs|cjs)$/.test(f))
      .filter((f) => DUONG_CHAY_SQL.test(doc(f)));
    expect(vi).toEqual([]);
  });

  it("file .sh có câu cấm ⇒ không dòng nào gọi docker/psql thật", () => {
    const vi = coCauCam.filter((f) => f.endsWith(".sh")).filter((f) => DONG_GOI_DOCKER_PSQL.test(doc(f)));
    expect(vi).toEqual([]);
  });

  it("file .sql có câu cấm chỉ là fixture guard; test đọc fixture đó không chạy SQL", () => {
    const sql = coCauCam.filter((f) => f.endsWith(".sql"));
    expect(sql.filter((f) => !f.startsWith("tests/fixtures/restore/"))).toEqual([]);
    const docFixture = tatCa.filter((f) => /\.(ts|mts|js|mjs)$/.test(f) && doc(f).includes("fixtures/restore"));
    expect(docFixture.filter((f) => DUONG_CHAY_SQL.test(doc(f)))).toEqual([]);
  });

  it("stub docker của harness không gọi xuyên tới docker thật; harness chặn docker thật bằng PATH + DOCKER_HOST", () => {
    const stub = doc("tests/deploy/harness/restore/docker-gia.sh");
    expect(stub).not.toMatch(/\bexec\s+docker\b|\bcommand\s+docker\b|\/bin\/docker\b|\bwhich\s+docker\b/);
    expect(stub).not.toMatch(DONG_GOI_DOCKER_PSQL);
    const harness = doc("tests/deploy/harness/restore/chay-restore-voi-docker-gia.ts");
    expect(harness).toContain("PATH: `${bin}:");
    expect(harness).toContain("DOCKER_HOST:");
    expect(harness).toContain("RESTORE_TEP_DANG_DO:");
  });
});
