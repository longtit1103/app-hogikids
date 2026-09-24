import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  MOC_SQL_CON_SONG_DO_DUOC_BYTES,
  TRAN_BUNG_NEN_BYTES,
} from "@/lib/backup/run-restore";

/**
 * Trần bung nén của đường `.sql.gz` KHÔNG phải con số chọn cho đẹp — nó là số đo.
 *
 * Đo 22/09/2026: `assertPlainSqlOnlySchema` dùng RAM gấp ~42–66 lần kích thước SQL phẳng (giữ 4–5
 * bản soi phái sinh cùng lúc). Ở heap 1536 MiB — mô phỏng container `mem_limit: 3g`, nơi Node tự
 * chọn old-space theo cgroup — file 41 MiB còn sống, file 45 MiB CHẾT
 * (`FATAL ERROR: … JavaScript heap out of memory`).
 *
 * Trần CŨ là 2GiB: cao hơn trần THẬT khoảng 50 lần, tức nó hứa "còn 2GiB nữa mới chặn" trong khi
 * tiến trình app đã bị giết từ 45 MiB — GIỮA LÚC PHỤC HỒI. Test này giữ cho ai đó không nới lại.
 */
describe("trần bung nén .sql.gz phải nằm dưới mốc đo được", () => {
  it("trần < mốc file lớn nhất còn sống, và có biên ít nhất 1,5×", () => {
    expect(TRAN_BUNG_NEN_BYTES).toBeLessThan(MOC_SQL_CON_SONG_DO_DUOC_BYTES);
    expect(MOC_SQL_CON_SONG_DO_DUOC_BYTES / TRAN_BUNG_NEN_BYTES).toBeGreaterThanOrEqual(1.5);
  });

  it("trần KHÔNG còn ở mức 2GiB cũ (trần giả)", () => {
    expect(TRAN_BUNG_NEN_BYTES).toBeLessThan(2 * 1024 * 1024 * 1024);
  });

  it("đỉnh RAM dự kiến (trần × 43) vẫn nằm trong mem_limit của container", () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const compose = readFileSync(path.join(here, "../../..", "docker-compose.yml"), "utf8");
    const m = compose.match(/^\s*mem_limit:\s*(\d+)g\s*$/m);
    if (!m) {
      throw new Error(
        "Không đọc được `mem_limit: <n>g` trong docker-compose.yml — quan hệ giữa trần bung nén và " +
          "RAM container đã đổi hình dạng. Sửa test này CÙNG LÚC, đừng xoá nó.",
      );
    }
    const memLimitByte = Number(m[1]) * 1024 * 1024 * 1024;
    // Hệ số 43 = số đo; chừa một nửa trần RAM cho Next.js + Postgres client + đệm hệ điều hành.
    expect(TRAN_BUNG_NEN_BYTES * 43).toBeLessThan(memLimitByte / 2);
  });
});
