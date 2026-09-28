import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { assertDumpOnlySchema } from "@/lib/backup/assert-dump-schema";

/**
 * Cổng TOC (bản bash `assert_toc_only_schema` + bản TS `assertDumpOnlySchema`) phải hiểu DESC 2 từ
 * `INDEX ATTACH` / `TABLE ATTACH` mà pg_dump phát cho bảng PARTITION.
 *
 * DR lượt 3 (25/09/2026) bắt được: thiếu 2 DESC này thì cổng khớp tiền tố 1 từ `INDEX`/`TABLE`, lấy chữ
 * `ATTACH` làm namespace ⇒ từ chối OAN một dump `-n app` hợp lệ ngay khi app có bảng partition. Hai bản
 * song sinh phải cho CÙNG phán quyết.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const RESTORE_SH = path.resolve(here, "../../..", "deploy/restore.sh");

function bashGuard(toc: string, schema: string): number {
  try {
    execFileSync("bash", ["-c", 'source "$1"; assert_toc_only_schema "$2"', "bash", RESTORE_SH, schema], {
      input: toc,
      stdio: ["pipe", "ignore", "ignore"],
    });
    return 0;
  } catch (e) {
    return (e as { status?: number | null }).status ?? 1;
  }
}

const tsGuard = (toc: string, schema: string): number => {
  try {
    assertDumpOnlySchema(toc, schema);
    return 0;
  } catch {
    return 1;
  }
};

const TOC_PARTITION_APP = [
  ";",
  "; Archive created at 2026-09-25 18:00:00 +07",
  "3801; 1259 16500 TABLE app Order postgres",
  "3802; 1259 16510 TABLE app Order_p2026 postgres",
  "3803; 0 0 TABLE ATTACH app Order_p2026 postgres",
  "3804; 1259 16520 INDEX app Order_p2026_pkey postgres",
  "3805; 0 0 INDEX ATTACH app Order_p2026_pkey postgres",
  "3806; 0 16510 TABLE DATA app Order_p2026 postgres",
  "",
].join("\n");

const TOC_ATTACH_PUBLIC = TOC_PARTITION_APP.replace(
  "3805; 0 0 INDEX ATTACH app",
  "3805; 0 0 INDEX ATTACH public",
);

describe("cổng TOC — DESC `INDEX ATTACH` / `TABLE ATTACH` (bảng partition)", () => {
  it("chấp nhận dump `-n app` có bảng partition (không đọc `ATTACH` thành schema)", () => {
    expect(bashGuard(TOC_PARTITION_APP, "app")).toBe(0);
    expect(tsGuard(TOC_PARTITION_APP, "app")).toBe(0);
  });

  it("vẫn từ chối `INDEX ATTACH` thuộc schema khác đích — namespace đọc ĐÚNG cột", () => {
    expect(bashGuard(TOC_ATTACH_PUBLIC, "app")).not.toBe(0);
    expect(tsGuard(TOC_ATTACH_PUBLIC, "app")).not.toBe(0);
  });
});
