import path from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

const dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(dirname, "src"),
    },
  },
  test: {
    environment: "node",
    setupFiles: ["tests/setup.ts"],
    // Giành khoá độc quyền trên database test cho cả lượt: `fileParallelism: false` dưới đây chỉ
    // điều phối được TRONG MỘT tiến trình, còn hai lượt `npm test` cùng lúc thì giẫm lên nhau
    // (đo 18/08: 6/6 tiến trình đỏ, 96–115 test hỏng mỗi lượt). Xem file được trỏ tới.
    globalSetup: ["tests/global-setup-khoa-chay-chong.ts"],
    // tests/e2e/** are Playwright specs (`test.describe` from
    // @playwright/test), not vitest — exclude them from unit test discovery.
    exclude: ["tests/e2e/**", "**/node_modules/**"],
    // Integration test files share ONE real Postgres test DB and several do
    // unscoped `deleteMany()` on shared tables (Variant/Product…) in
    // `beforeAll` — running files in parallel (vitest's default) lets one
    // file's cleanup wipe another file's fixtures mid-run. Force file-level
    // sequencing so DB-touching suites never race each other.
    fileParallelism: false,
    // 15s thay mặc định 5s: đa số suite là test TÍCH HỢP chạy trên DB test THẬT qua Tailscale —
    // nhiều test land+transform vốn ăn 4–5s, mặc định 5s làm chúng đỏ/xanh theo biên độ mạng
    // từng đêm (đo 21/08: 4 file lần lượt trượt trần ở các lượt chạy khác nhau, không lượt nào
    // trùng lượt nào). Đây là ngân sách hạ tầng, không phải nới assertion; test TREO thật vẫn
    // chết ở 15s.
    testTimeout: 15_000,
  },
});
