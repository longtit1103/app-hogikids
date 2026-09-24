import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { assertPlainSqlOnlySchema } from "@/lib/backup/assert-plain-sql-only-schema";

/**
 * CỔNG PARITY TOÀN-FIXTURE cho guard SQL phẳng — hai bản song sinh phải cho CÙNG PHÁN QUYẾT trên
 * CÙNG MỘT BYTE:
 *
 *  - `assertPlainSqlOnlySchema` (TS) — nút "Phục hồi từ file" trong app, chạy bằng role app.
 *  - `assert_sql_only_schema` (bash, `deploy/restore.sh`) — đường DR trên host, nạp bằng
 *    `psql -U supabase_admin` = SUPERUSER THẬT. Đây là đường nguy hiểm hơn.
 *
 * VÌ SAO PHẢI CÓ FILE NÀY (đo 22/09/2026, trước khi thêm guard (i)/(j)): parity giữa hai bên khi
 * đó chỉ đạt được bằng QUY ƯỚC ĐẶT TÊN FIXTURE + review tay. `restore-sh-guard.test.ts` chỉ chạy
 * phía bash; `assert-dump-schema.test.ts` chỉ chạy phía TS và phần lớn ca dùng chuỗi inline riêng
 * chứ không cùng byte với fixture. Không có test nào chạy CẢ HAI trên CÙNG một input rồi so phán
 * quyết ⇒ thêm guard vào một bên mà quên bên kia thì KHÔNG CÓ GÌ ĐỎ. Đúng lớp lỗi của Đợt 2
 * ("ba phép so chỉ so với nhau nên mù tầng tiêu thụ"), lặp lại ở chỗ khác.
 *
 * Bảng `PHAN_QUYET` bên dưới còn là cổng thứ hai: thêm fixture mới mà quên khai vào bảng là ĐỎ.
 * Buộc người thêm phải nói rõ fixture đó KỲ VỌNG được chấp nhận hay bị từ chối — chiều CHẤP NHẬN
 * mới là chiều bắt được "vá quá tay", thứ nguy hiểm hơn bỏ lọt trên đường phục hồi.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../..");
const RESTORE_SH = path.join(repoRoot, "deploy/restore.sh");
const FIXTURE_DIR = path.join(repoRoot, "tests/fixtures/restore");

const SCHEMA_DICH = "app";

type PhanQuyet = "chap-nhan" | "tu-choi";

/**
 * Phán quyết KỲ VỌNG của từng fixture khi schema đích là `app`.
 *
 * ⚠️ `sql-public-foreign.sql` bị TỪ CHỐI với đích `app` nhưng được CHẤP NHẬN với đích `public`
 * (tương thích ngược, xem `restore-sh-guard.test.ts`) — nên bảng này neo đúng MỘT đích.
 */
const PHAN_QUYET: Record<string, PhanQuyet> = {
  "sql-app-only.sql": "chap-nhan",
  "sql-restrict-token.sql": "chap-nhan",
  "sql-copy-payload-foreign-lookalike.sql": "chap-nhan",
  "sql-set-config-than-ham.sql": "chap-nhan",
  // Ca ÂM của guard (i): chữ "program" ở tên cột / dữ liệu COPY / literal — PHẢI qua.
  "sql-copy-stdin-chua-chu-program.sql": "chap-nhan",

  "sql-foreign-schema.sql": "tu-choi",
  "sql-system-write.sql": "tu-choi",
  "sql-public-foreign.sql": "tu-choi",
  "sql-multistatement-per-line.sql": "tu-choi",
  "sql-crossline-system.sql": "tu-choi",
  "sql-crossline-public-foreign.sql": "tu-choi",
  "sql-meta-command-shell.sql": "tu-choi",
  "sql-meta-command-giua-cau.sql": "tu-choi",
  "sql-chuoi-nhay-da-dong.sql": "tu-choi",
  "sql-set-config-search-path.sql": "tu-choi",
  "sql-set-search-path-ne-comment.sql": "tu-choi",
  "sql-dollar-quote-comment.sql": "tu-choi",
  "sql-dollar-tag-chu-so.sql": "tu-choi",
  // Guard (i) + (j), thêm 22/09/2026.
  "sql-copy-from-program.sql": "tu-choi",
  // Lệch song sinh: `/*` trong thân dollar-quote từng làm bản soi của (i)/(j) phía TS mù hẳn.
  "sql-dollar-quote-che-comment-program.sql": "tu-choi",
  "sql-copy-to-program.sql": "tu-choi",
  "sql-cau-lenh-dac-quyen.sql": "tu-choi",
  "sql-security-definer.sql": "tu-choi",
};

/** Mọi fixture SQL phẳng. Lọc theo tiền tố `sql-`: `toc-*.txt` dành cho guard TOC, khác hàm. */
function dsFixtureSql(): string[] {
  return readdirSync(FIXTURE_DIR)
    .filter((f) => f.startsWith("sql-") && f.endsWith(".sql"))
    .sort();
}

function phanQuyetTs(file: string): PhanQuyet {
  try {
    assertPlainSqlOnlySchema(readFileSync(path.join(FIXTURE_DIR, file), "utf8"), SCHEMA_DICH);
    return "chap-nhan";
  } catch {
    return "tu-choi";
  }
}

/**
 * Gọi hàm bash đã `source` (restore.sh có chốt `BASH_SOURCE`/`$0` nên source KHÔNG chạy main).
 * Mọi mã thoát ≠ 0 đều là "từ chối" — guard bash dùng cả `return 1` lẫn exit 2 (chuỗi đa dòng).
 */
function phanQuyetBash(file: string): PhanQuyet {
  try {
    execFileSync(
      "bash",
      [
        "-c",
        'source "$1"; assert_sql_only_schema "$2" "$3"',
        "bash",
        RESTORE_SH,
        SCHEMA_DICH,
        path.join(FIXTURE_DIR, file),
      ],
      { stdio: ["ignore", "ignore", "ignore"] },
    );
    return "chap-nhan";
  } catch {
    return "tu-choi";
  }
}

describe("parity guard SQL phẳng — TS ↔ bash trên TOÀN BỘ fixture", () => {
  it("mọi fixture `sql-*.sql` đều được khai phán quyết kỳ vọng", () => {
    const thieu = dsFixtureSql().filter((f) => !(f in PHAN_QUYET));
    expect(
      thieu,
      "Fixture mới phải khai vào bảng PHAN_QUYET (chấp nhận hay từ chối) — khai rồi mới biết " +
        "bản vá có quá tay không.",
    ).toEqual([]);
  });

  it("bảng PHAN_QUYET không khai fixture đã bị xoá", () => {
    const ds = new Set(dsFixtureSql());
    expect(Object.keys(PHAN_QUYET).filter((f) => !ds.has(f))).toEqual([]);
  });

  it.each(dsFixtureSql())("%s — TS và bash cùng phán quyết, đúng bảng", (file) => {
    const mongDoi = PHAN_QUYET[file];
    const ts = phanQuyetTs(file);
    const sh = phanQuyetBash(file);
    // So cả 3 trong MỘT phép so: thông báo lỗi chỉ thẳng bên nào trôi.
    expect({ ts, bash: sh }).toEqual({ ts: mongDoi, bash: mongDoi });
  });
});
