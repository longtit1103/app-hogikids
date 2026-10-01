import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Form đổi mật khẩu lần đầu là Client Component và import `mat-khau-moi-schema.ts`. Hai file dưới đây
 * chạy cả trong trình duyệt nên KHÔNG được import (trực tiếp) `password.ts` hay bất kỳ `node:*` nào —
 * `promisify(scrypt)` ở `password.ts` ném ngay khi tải bundle client và trang đổi mật khẩu sập.
 */
const FILE_CHAY_TRONG_TRINH_DUYET = ["src/lib/mat-khau-moi-schema.ts", "src/lib/do-dai-mat-khau.ts"];

describe("schema mật khẩu mới dùng được trong bundle client", () => {
  for (const f of FILE_CHAY_TRONG_TRINH_DUYET) {
    it(`${f} không import password.ts hay node:*`, () => {
      const nguon = readFileSync(path.join(process.cwd(), f), "utf8");
      const importDong = nguon.split("\n").filter((d) => /^\s*(import|export)\b.*\bfrom\b/.test(d));
      for (const d of importDong) {
        expect(d, `${f}: ${d}`).not.toMatch(/["']node:/);
        expect(d, `${f}: ${d}`).not.toMatch(/lib\/password["']|\.\/password["']/);
      }
    });
  }
});
