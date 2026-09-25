import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * `deploy/full-backup.sh` phải mang theo CẤU HÌNH dựng lại stack Supabase, không chỉ `.env` + compose.
 *
 * DR lượt 3 (25/09/2026) chạy thật và xác nhận tarball cũ THIẾU 12 path bind-mount (kong.yml, db/*.sql,
 * functions, pooler.exs, vector.yml…) + volume `supabase_db-config` (có `pgsodium_root.key`) ⇒ dựng stack trên
 * máy trắng vỡ, còn khoá pgsodium thì mất vĩnh viễn. Test soi MÃ NGUỒN để một lần sửa sau không âm thầm:
 * thêm `|| true` (lỗi bị nuốt ⇒ bản sao lưu thiếu mà vẫn báo OK), bỏ exclude dữ liệu PG, hoặc đổi tên file
 * làm runbook bung hụt.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../..");
const doc = (p: string) => readFileSync(path.join(repoRoot, p), "utf8");

const script = doc("deploy/full-backup.sh");
const runbook = doc("deploy/runbook-dr-cai-lai-minipc.md");

/** Dòng lệnh (bỏ comment) chứa `needle`, gộp dòng nối `\`. */
function lenhChua(needle: string): string {
  const lenh = script
    .replace(/\\\n\s*/g, " ")
    .split("\n")
    .filter((d) => !d.trimStart().startsWith("#"))
    .filter((d) => d.includes(needle));
  expect(lenh).toHaveLength(1);
  return lenh[0];
}

describe("full-backup.sh — tarball dựng lại được stack Supabase", () => {
  it("tar volume db-config (pgsodium_root.key) và KHÔNG nuốt lỗi", () => {
    const l = lenhChua("supabase_db-config:/data");
    expect(l).toContain("supabase_db_config.tar.gz");
    expect(l).not.toMatch(/\|\|\s*true/);
  });

  it("tar file cấu hình bind-mount, loại dữ liệu PG + storage, KHÔNG nuốt lỗi", () => {
    const l = lenhChua("volumes-config.tar.gz");
    expect(l).toContain(`--exclude='volumes/db/data'`);
    expect(l).toContain(`--exclude='volumes/storage'`);
    expect(l).toMatch(/\svolumes\s*$/);
    expect(l).not.toMatch(/\|\|\s*true/);
  });

  it("runbook bung ĐÚNG tên file script tạo ra, trước khi compose tự sinh volume rỗng", () => {
    expect(runbook).toContain("configs/supabase/volumes-config.tar.gz");
    expect(runbook).toContain("supabase_db_config.tar.gz");
    expect(runbook).toContain("test -s /data/pgsodium_root.key");
  });

  it("cổng nghiệm thu workflow là NGƯỠNG DƯỚI, không so cứng số đếm (số workflow chỉ tăng)", () => {
    expect(runbook).not.toContain(`= "3|1|9"`);
    expect(runbook).toContain(`[ "\${W:-0}" -ge 9 ]`);
  });
});
