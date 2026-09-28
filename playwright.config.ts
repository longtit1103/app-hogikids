import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { defineConfig, devices } from "@playwright/test";
import { INGEST_SECRET_TEST, SESSION_SECRET_TEST } from "./tests/e2e/test-constants";
import { resolveE2eDatabaseUrl } from "./tests/e2e/test-database-url";

// Load `.env` into process.env for the Playwright RUNNER process itself
// (globalSetup, and this config file) — no "dotenv" dependency needed, Node
// has a built-in loader since v20.6. Must happen before the fail-fast check
// and the `webServer.env` object below are evaluated.
const envPath = path.resolve(process.cwd(), ".env");
if (existsSync(envPath)) {
  process.loadEnvFile(envPath);
}

// Fail fast: dev's Postgres is shared with prod (one real DB, reached over
// Tailscale). Nếu URL DB test không hợp lệ ở ĐÂY thì `webServer.env.DATABASE_URL`
// bên dưới thành `undefined` và Next.js âm thầm tự đọc `.env` (DATABASE_URL prod)
// trong dev server vừa spawn — đúng ca mất dữ liệu mà guard này tồn tại để chặn.
// Guard đầy đủ (đuôi `_test`, khác DATABASE_URL) nằm trong `resolveE2eDatabaseUrl()`,
// dùng CHUNG với global setup — trước đây chỗ này chỉ kiểm biến có tồn tại.
const E2E_DATABASE_URL = resolveE2eDatabaseUrl();

/** Thư mục backup cho dev server của e2e — xem ghi chú ở `webServer.env.BACKUP_DIR`. */
const THU_MUC_BACKUP_E2E = mkdtempSync(path.join(tmpdir(), "hogikids-e2e-backups-"));

export default defineConfig({
  testDir: "./tests/e2e",
  globalSetup: "./tests/e2e/global-setup.ts",
  // Mọi spec dùng CHUNG một DB test (DB test của e2e) và nhiều spec ghi dữ liệu
  // tiền vào CÙNG bucket "tháng này" (đơn/chi phí ngày hôm nay). `acceptance.spec.ts`
  // assert số P&L tuyệt đối của bucket đó, nên spec chạy song song ở worker khác sẽ
  // chèn dữ liệu lạ vào giữa 2 lần đọc → sai lệch giả. Chạy tuần tự 1 worker (cùng lý do
  // vitest đặt `fileParallelism: false`).
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: "html",
  use: {
    baseURL: "http://localhost:3000",
    trace: "on-first-retry",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  // Always spawns a fresh dev server pointed at the test DB — never reuses
  // a dev server that may be running against the real (prod) database.
  webServer: {
    command: "npm run dev",
    url: "http://localhost:3000",
    reuseExistingServer: false,
    // Next 16 turbopack cold-start + biên dịch route đầu tiên trên CI có thể vượt
    // mặc định 60s → nới lên 120s để webServer không bị coi là "không khởi động".
    // ⚠️ PHẢI DỪNG `npm run preview` trước khi chạy E2E. Hai lượt `next dev` cùng
    // project vốn đã phải chết vì tranh cổng 3000; Next 16 thêm lockfile nên nó chết
    // SỚM HƠN với thông báo khác. Đây là hành vi ĐÚNG — `reuseExistingServer: false`
    // ở trên là hàng rào cố ý, chặn việc tái dùng dev server đang trỏ DB prod.
    timeout: 120_000,
    env: {
      DATABASE_URL: E2E_DATABASE_URL,
      INGEST_SECRET: INGEST_SECRET_TEST,
      SESSION_SECRET: SESSION_SECRET_TEST,
      // E2E kiểm luồng đầy đủ (raw → Silver → UI). `.env` của máy dev có thể đang bật chế độ
      // chỉ-land → Silver rỗng → e2e đỏ nhầm. Ép tắt.
      BRONZE_ONLY: "",
      // Nút "Áp giá vốn Pancake" chụp backup giá cũ TRƯỚC khi ghi và TỪ CHỐI ghi nếu chụp hỏng.
      // Mặc định là `/backups` — đúng cho container prod (có mount), nhưng KHÔNG tồn tại trên máy
      // dev nên e2e sẽ đỏ ở đúng cổng chặn đó. Trỏ sang thư mục tạm để kiểm được luồng thật.
      BACKUP_DIR: THU_MUC_BACKUP_E2E,
    },
  },
});
