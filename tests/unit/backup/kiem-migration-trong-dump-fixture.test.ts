import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { gunzipSync } from "node:zlib";

import { describe, expect, it } from "vitest";

import {
  assertDumpCoM1HoanTat,
  docDongPrismaMigrationsTuCopy,
  LoiBackupTruocPhanQuyen,
  m1HoanTat,
  TEN_MIGRATION_PHAN_QUYEN,
} from "@/lib/backup/kiem-migration-trong-dump";

/**
 * Parser cổng "dump đời trước phân quyền" trên 4 dump THẬT do `pg_dump` 15 sinh
 * (`tests/fixtures/backup/sinh-fixture.sh`) — hai định dạng × đời trước/sau M1.
 *
 * `.dump` đi đúng đường nhánh custom sẽ dùng: `pg_restore -a -n app -t _prisma_migrations -f -`
 * (chỉ đọc file, không nối DB) rồi đưa text vào parser. `.sql.gz` giải nén rồi đưa NGUYÊN văn.
 */

const THU_MUC = path.resolve(process.cwd(), "tests/fixtures/backup");

function textTuDump(ten: string): string {
  return execFileSync("pg_restore", ["-a", "-n", "app", "-t", "_prisma_migrations", "-f", "-", path.join(THU_MUC, ten)], {
    encoding: "utf8",
  });
}

function textTuSqlGz(ten: string): string {
  return gunzipSync(readFileSync(path.join(THU_MUC, ten))).toString("utf8");
}

const CA = [
  { ten: "truoc-m1.dump", doc: textTuDump, m1: false },
  { ten: "sau-m1.dump", doc: textTuDump, m1: true },
  { ten: "truoc-m1.sql.gz", doc: textTuSqlGz, m1: false },
  { ten: "sau-m1.sql.gz", doc: textTuSqlGz, m1: true },
] as const;

describe("parser trên 4 fixture dump thật", () => {
  it.each(CA)("$ten ⇒ m1HoanTat = $m1", ({ ten, doc, m1 }) => {
    const rows = docDongPrismaMigrationsTuCopy(doc(ten), "app");

    // Đọc được cả khối (không phải [] do lệch định dạng) — mọi migration trong fixture đều hoàn tất.
    expect(rows.length).toBeGreaterThanOrEqual(40);
    expect(rows.every((r) => r.finished_at !== null && r.rolled_back_at === null)).toBe(true);
    expect(rows.some((r) => r.migration_name === TEN_MIGRATION_PHAN_QUYEN)).toBe(m1);

    expect(m1HoanTat(rows)).toBe(m1);
    if (m1) expect(() => assertDumpCoM1HoanTat(rows)).not.toThrow();
    else expect(() => assertDumpCoM1HoanTat(rows)).toThrow(LoiBackupTruocPhanQuyen);
  });

  it("đích schema khác `app` ⇒ không nhận khối nào (dump fixture qualify `app.`)", () => {
    expect(docDongPrismaMigrationsTuCopy(textTuSqlGz("sau-m1.sql.gz"), "public")).toEqual([]);
    expect(docDongPrismaMigrationsTuCopy(textTuDump("sau-m1.dump"), "public")).toEqual([]);
  });
});
