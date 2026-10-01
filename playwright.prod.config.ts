import { defineConfig, type PlaywrightTestConfig } from "@playwright/test";

import base from "./playwright.config";

// Helper gọi API trong test (`tests/e2e/ingest-raw.ts`) đọc biến này thay vì cứng cổng 3000.
process.env.E2E_BASE_URL = "http://localhost:3100";

/**
 * Smoke bằng BẢN BUILD PRODUCTION (`next build && next start`) — kế thừa trọn `playwright.config.ts`
 * (cùng DB e2e, cùng secret test, cùng global setup), chỉ khác server + cổng.
 *
 * Vì sao cần: lỗi tuần tự hoá Server → Client Component ("Functions cannot be passed directly to
 * Client Components", "Only plain objects…") KHÔNG bắt được bằng unit test và chỉ nổ rõ ở bản build;
 * khung menu nhận `hrefDuocPhep: string[]` từ server nên đây là lưới cho đúng ranh giới đó.
 *
 * KHÔNG dùng `scripts/preview-local.sh` (chạy `next dev`) và KHÔNG `npm run build && npm run start`
 * tay: hai cách đó đọc `.env` ⇒ có thể trỏ DB THẬT. `webServer.env` của config gốc ép `DATABASE_URL`
 * sang DB e2e cho CẢ `next build` lẫn `next start` (cùng process env), và Next không đè biến đã có.
 *
 * Chạy: `npm run test:e2e:prod`. Cổng 3100 để không đụng server dev ở 3000; `reuseExistingServer:
 * false` giữ hàng rào "không bao giờ tái dùng server đang trỏ DB khác".
 */

const CONG_PROD = 3100;
const URL_PROD = `http://localhost:${CONG_PROD}`;

const webServerGoc = base.webServer;
if (!webServerGoc || Array.isArray(webServerGoc)) {
  throw new Error("playwright.config.ts phải khai ĐÚNG MỘT webServer — cấu hình prod kế thừa từ đó.");
}

// Hàng rào DB: tên database (pathname) phải đuôi `_test` — `resolveE2eDatabaseUrl()` đã kiểm ở config
// gốc, đây là lớp thứ hai vì `next build` CHẠY với env này. Chỉ log TÊN DB, KHÔNG BAO GIỜ log URL
// (chứa mật khẩu).
const dbUrl = webServerGoc.env?.DATABASE_URL;
if (!dbUrl) {
  throw new Error("webServer.env.DATABASE_URL trống — `next build` sẽ đọc DB từ .env (có thể là DB thật).");
}
const tenDb = new URL(dbUrl).pathname.replace(/^\//, "");
if (!tenDb.endsWith("_test")) {
  throw new Error(`Từ chối build prod: tên DB "${tenDb}" không kết thúc "_test".`);
}
console.log(`[e2e:prod] DB = ${tenDb}`);

const cauHinh: PlaywrightTestConfig = {
  ...base,
  use: { ...base.use, baseURL: URL_PROD },
  webServer: {
    ...webServerGoc,
    command: `npx next build && npx next start -p ${CONG_PROD}`,
    url: URL_PROD,
    reuseExistingServer: false,
    // Build đầy đủ + khởi động: rộng hơn hẳn mốc 120s của `next dev`.
    timeout: 300_000,
  },
  // Chỉ các spec chạm khung menu/ranh giới server→client; không chạy cả bộ e2e trên bản build.
  testMatch: [
    "**/views.spec.ts",
    "**/mobile-bo-cuc.spec.ts",
    "**/quan-tri-ui.spec.ts",
    "**/tai-chinh-theo-quyen.spec.ts",
    "**/che-gia-von-payload.spec.ts",
    "**/phan-quyen-tron-luong.spec.ts",
    "**/xuat-ton-kho-theo-quyen.spec.ts",
  ],
};

export default defineConfig(cauHinh);
