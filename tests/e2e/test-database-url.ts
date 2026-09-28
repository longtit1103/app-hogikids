/**
 * URL database mà bộ e2e được phép đụng.
 *
 * Playwright và Vitest ghi vào CÙNG các bảng nghiệp vụ và đều dùng `deleteMany()` không phạm vi
 * (vd `Expense`), nên chạy chồng hai bộ trên MỘT database làm bộ này xoá/chèn dữ liệu giữa hai lần
 * đọc của bộ kia. `TEST_DATABASE_URL_E2E` cho e2e một database riêng. Không set biến ⇒ rơi về
 * `TEST_DATABASE_URL` (hành vi cũ; CI dựng Postgres riêng cho từng job nên không cần biến này).
 *
 * Biến ĐỂ TRỐNG cũng phải rơi về `TEST_DATABASE_URL`: `.env.example` khai sẵn dòng mẫu nên máy nào
 * copy về mà chưa dựng DB riêng sẽ có `TEST_DATABASE_URL_E2E=""` — chuỗi rỗng KHÔNG phải "đã set".
 */
export function e2eDatabaseUrlFromEnv(): string | undefined {
  const rieng = process.env.TEST_DATABASE_URL_E2E?.trim();
  return rieng ? rieng : process.env.TEST_DATABASE_URL;
}

/**
 * Cờ ghi lại "DATABASE_URL đã bị ép sang DB e2e", do `forceE2eDatabaseUrl()` bật.
 *
 * Worker của Playwright được fork từ runner (thừa kế nguyên `process.env`) và NẠP LẠI
 * `playwright.config.ts` — tới lúc đó `DATABASE_URL` đã là URL e2e, nên phép "khác DATABASE_URL"
 * dưới đây sẽ so URL với chính nó và từ chối chạy oan. Cờ mang đúng URL đã ép để phân biệt trạng
 * thái đó với ca thật sự nguy hiểm (URL e2e trỏ đúng database mà app dev đang dùng).
 */
const BIEN_CO_DA_EP = "E2E_DATABASE_URL_FORCED";

/**
 * URL đã qua guard, dùng ở process RUNNER (playwright config + global setup).
 *
 * Postgres dev nối chung DB THẬT của shop qua Tailscale, và global setup chạy
 * `user.deleteMany({})` → "biến có tồn tại" chưa đủ: tên database PHẢI kết thúc `_test` và PHẢI khác
 * `DATABASE_URL`.
 */
export function resolveE2eDatabaseUrl(): string {
  const url = e2eDatabaseUrlFromEnv();
  if (!url) {
    throw new Error(
      "Chưa set TEST_DATABASE_URL_E2E hoặc TEST_DATABASE_URL. Từ chối chạy e2e — Postgres dev nối chung DB thật."
    );
  }
  const { pathname } = new URL(url);
  if (!pathname.endsWith("_test")) {
    throw new Error(
      `URL DB e2e trỏ "${pathname}" — không phải DB test (phải kết thúc bằng "_test").`
    );
  }
  const daEpChinhUrlNay =
    process.env[BIEN_CO_DA_EP] === url && process.env.DATABASE_URL === url;
  if (
    !daEpChinhUrlNay &&
    process.env.DATABASE_URL &&
    new URL(process.env.DATABASE_URL).pathname === pathname
  ) {
    throw new Error("URL DB e2e trùng DATABASE_URL — từ chối chạy (nguy cơ xoá DB thật).");
  }
  return url;
}

/**
 * Chốt URL rồi ép `DATABASE_URL` sang đó — global setup gọi ĐÚNG hàm này thay vì tự gán, để guard
 * luôn chạy TRƯỚC lúc ghi đè (gọi ngược thứ tự thì phép "khác DATABASE_URL" báo oan URL vừa gán).
 */
export function forceE2eDatabaseUrl(): string {
  const url = resolveE2eDatabaseUrl();
  process.env.DATABASE_URL = url;
  process.env[BIEN_CO_DA_EP] = url;
  return url;
}
