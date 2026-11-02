import { defineConfig, type PlaywrightTestConfig } from "@playwright/test";

import base from "./playwright.config";

/**
 * E2E CỔNG GHI TOÀN CỤC trên BẢN BUILD (`next build && next start`, Turbopack) — `tests/e2e/cong-ghi-prod.spec.ts`.
 * Chạy: `npm run test:e2e:prod:cong-ghi`. KHÔNG đổi `test:e2e:prod` (khuôn `playwright.prod.config.ts`).
 *
 * Khác bản build thường đúng hai biến:
 *  - `E2E_CONG_GHI_BUILD=1` lúc `next build` ⇒ `pageExtensions` nhận `*.e2e.ts(x)` (route/trang/action
 *    chỉ-test dưới `src/app`). Đặt NGAY trước lệnh build, không nằm trong env chung của server.
 *  - `E2E_CONG_GHI=1` lúc chạy ⇒ lớp phòng thủ thứ hai của các file đó (thiếu ⇒ 404) và seam restore khô
 *    của `/api/restore`.
 * Kế thừa DB e2e + secret test của `playwright.config.ts`; cổng 3200 để không đụng 3000 (dev) / 3100
 * (`test:e2e:prod`). ⚠️ Lượt này ghi đè `.next` của checkout bằng bản build CÓ route chỉ-test — chạy
 * `next build` thường lại trước khi `next start` tay (route vẫn 404 khi thiếu `E2E_CONG_GHI=1`).
 *
 * Dùng `globalSetup` CHUẨN: khoá độc quyền DB e2e giữ bằng `pg.Client` thuần (`tests/helpers/khoa-doc-quyen-db-test.ts`),
 * KHÔNG qua client Prisma chế độ CLI ⇒ runner không giữ khoá ghi chung, restore khô giành được X.
 */
const CONG = 3200;
const URL_CONG_GHI = `http://localhost:${CONG}`;
process.env.E2E_BASE_URL = URL_CONG_GHI;
// Spec cổng ghi chỉ chạy dưới config này: `playwright.config.ts` (testMatch mọi `*.spec.ts`, server
// `next dev` không có route chỉ-test) cũng quét thấy nó — spec tự `skip` khi thiếu cờ này.
process.env.E2E_CONG_GHI_SPEC = "1";

const webServerGoc = base.webServer;
if (!webServerGoc || Array.isArray(webServerGoc)) {
  throw new Error("playwright.config.ts phải khai ĐÚNG MỘT webServer — cấu hình cổng ghi kế thừa từ đó.");
}
// Hàng rào DB lớp hai (lớp một: `resolveE2eDatabaseUrl()` ở config gốc) — `next build` CHẠY với env này.
// Chỉ log TÊN DB, không bao giờ log URL (chứa mật khẩu).
const dbUrl = webServerGoc.env?.DATABASE_URL;
if (!dbUrl) {
  throw new Error("webServer.env.DATABASE_URL trống — `next build` sẽ đọc DB từ .env (có thể là DB thật).");
}
const tenDb = new URL(dbUrl).pathname.replace(/^\//, "");
if (!tenDb.endsWith("_test")) {
  throw new Error(`Từ chối build: tên DB "${tenDb}" không kết thúc "_test".`);
}
console.log(`[e2e:prod:cong-ghi] DB = ${tenDb}`);

const cauHinh: PlaywrightTestConfig = {
  ...base,
  globalSetup: "./tests/e2e/global-setup.ts",
  reporter: "list",
  use: { ...base.use, baseURL: URL_CONG_GHI },
  webServer: {
    ...webServerGoc,
    env: { ...webServerGoc.env, E2E_CONG_GHI: "1" },
    command: `E2E_CONG_GHI_BUILD=1 npx next build && npx next start -p ${CONG}`,
    url: URL_CONG_GHI,
    reuseExistingServer: false,
    timeout: 600_000,
  },
  testMatch: ["**/cong-ghi-prod.spec.ts"],
};

export default defineConfig(cauHinh);
