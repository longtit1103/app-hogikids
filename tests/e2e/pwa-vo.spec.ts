// tests/e2e/pwa-vo.spec.ts
import { expect, test, type Page } from "./fixture-cho-trang-stream-xong";

import { testPrisma } from "./ingest-raw";
import { TEST_USER_EMAIL, TEST_USER_PASSWORD } from "./test-constants";

/**
 * Vỏ PWA cho iPhone (spec docs/superpowers/specs/2026-09-26-iphone-pwa-design.md §3).
 * Chạy KHÔNG đăng nhập: iOS tải icon/manifest không qua phiên app.
 */

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

for (const size of [180, 192, 512]) {
  test(`/pwa-icon/${size} trả PNG ${size}×${size} 200, no-store`, async ({ request }) => {
    const res = await request.get(`/pwa-icon/${size}`);
    expect(res.status()).toBe(200);
    expect(res.headers()["content-type"]).toBe("image/png");
    expect(res.headers()["cache-control"]).toContain("no-store");
    const body = await res.body();
    expect([...body.subarray(0, 8)]).toEqual(PNG_SIG);
    // IHDR: rộng byte 16–19, cao byte 20–23 (big-endian).
    expect([body.readUInt32BE(16), body.readUInt32BE(20)]).toEqual([size, size]);
  });
}

for (const url of ["/pwa-icon/100", "/pwa-icon/192abc", "/pwa-icon/abc"]) {
  test(`${url} ngoài allowlist ⇒ 404`, async ({ request }) => {
    expect((await request.get(url)).status()).toBe(404);
  });
}

test("manifest đúng hợp đồng", async ({ request }) => {
  const res = await request.get("/manifest.webmanifest");
  expect(res.status()).toBe(200);
  expect(res.headers()["content-type"]).toContain("application/manifest+json");
  const m = await res.json();
  expect(m).toMatchObject({
    name: "HogiKids",
    short_name: "HogiKids",
    lang: "vi",
    start_url: "/",
    scope: "/",
    display: "standalone",
    background_color: "#faf9f5",
    theme_color: "#cc785c",
  });
  expect(m.icons).toEqual([
    { src: "/pwa-icon/192", sizes: "192x192", type: "image/png", purpose: "any" },
    { src: "/pwa-icon/512", sizes: "512x512", type: "image/png", purpose: "any" },
  ]);
});

test("head trang: đúng 1 manifest use-credentials, apple-touch-icon, viewport-fit=cover", async ({ page }) => {
  await page.goto("/dang-nhap");
  const manifest = page.locator('link[rel="manifest"]');
  await expect(manifest).toHaveCount(1);
  await expect(manifest).toHaveAttribute("href", "/manifest.webmanifest");
  await expect(manifest).toHaveAttribute("crossorigin", "use-credentials");

  const apple = page.locator('link[rel="apple-touch-icon"]');
  await expect(apple).toHaveCount(1);
  await expect(apple).toHaveAttribute("href", "/pwa-icon/180");

  await expect(page.locator('meta[name="viewport"]')).toHaveAttribute("content", /viewport-fit=cover/);
  await expect(page.locator('meta[name="apple-mobile-web-app-title"]')).toHaveAttribute("content", "HogiKids");
  await expect(page.locator('meta[name="apple-mobile-web-app-status-bar-style"]')).toHaveAttribute("content", "default");
  await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute("content", "#faf9f5");
  // `appleWebApp.capable`: Next 16.3.6 phát tên chuẩn `mobile-web-app-capable` (KHÔNG phát bản
  // `apple-…` cũ — đo trên build production 26/09). Chế độ standalone trên iOS còn dựa vào
  // `display: "standalone"` của manifest; cổng iPhone thật là trọng tài.
  const capable = page.locator('meta[name="mobile-web-app-capable"]');
  await expect(capable).toHaveCount(1);
  await expect(capable).toHaveAttribute("content", "yes");
  // favicon.ico cũ không bị metadata.icons mới đè mất.
  await expect(page.locator('link[rel="icon"]').first()).toHaveAttribute("href", /favicon\.ico/);
});

test("desktop: đệm safe-area = 0, bố cục máy tính không đổi", async ({ page }) => {
  await page.goto("/dang-nhap");
  const padding = await page.evaluate(() => {
    const s = getComputedStyle(document.body);
    return [s.paddingTop, s.paddingRight, s.paddingBottom, s.paddingLeft];
  });
  expect(padding).toEqual(["0px", "0px", "0px", "0px"]);
});

type Inset = { top: number; bottom: number; left: number; right: number };

async function datInset(page: Page, insets: Inset): Promise<void> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setSafeAreaInsetsOverride" as never, { insets } as never);
}

async function dangNhap(page: Page): Promise<void> {
  await page.goto("/dang-nhap");
  await page.getByLabel("Email").fill(TEST_USER_EMAIL);
  await page.getByLabel("Mật khẩu", { exact: true }).fill(TEST_USER_PASSWORD);
  await page.getByRole("button", { name: "Đăng nhập" }).click();
  await expect(page).toHaveURL("/");
}

/**
 * iPhone giả lập: khung 390×844 + safe-area inset THẬT qua CDP `Emulation.setSafeAreaInsetsOverride`
 * (Chromium; đo 26/09 — body nhận đúng 34px). Mọi lớp `fixed` không hưởng đệm của body phải tự bù.
 */
test.describe("iPhone: lớp fixed tự bù safe-area", () => {
  // Tự tạo 1 khoản chi trong THÁNG NÀY: trang Lãi/Lỗ và Sổ chi phí chỉ hiện bảng/nút Lọc khi kỳ có dữ
  // liệu. Trước đây test xanh nhờ chi phí RÁC spec khác để lại trong DB e2e — dọn rác là đỏ.
  const MO_TA_SEED = "E2E pwa-vo Bộ lọc — chi phí mồi";
  test.beforeAll(async () => {
    const db = testPrisma();
    await db.expense.deleteMany({ where: { description: MO_TA_SEED } });
    await db.expense.create({ data: { date: new Date(), categoryId: "fixed", amount: 1_000_000, description: MO_TA_SEED } });
  });
  test.afterAll(async () => {
    await testPrisma().expense.deleteMany({ where: { description: MO_TA_SEED } });
  });
  test.use({ viewport: { width: 390, height: 844 } });

  async function iphoneDaDangNhap(page: Page): Promise<void> {
    await datInset(page, { top: 47, bottom: 34, left: 0, right: 0 });
    await dangNhap(page);
  }

  const pad = (page: Page, selector: string) =>
    page.locator(selector).evaluate((e) => {
      const s = getComputedStyle(e);
      return { top: s.paddingTop, bottom: s.paddingBottom, left: s.paddingLeft };
    });

  test("bottom sheet Bộ lọc chi phí: đệm dưới = inset thanh home", async ({ page }) => {
    await iphoneDaDangNhap(page);
    await page.goto("/tai-chinh?tab=so-chi-phi");
    await page.getByRole("button", { name: /^Lọc/ }).click();
    await expect(page.locator('[data-slot="sheet-content"]')).toBeVisible();
    expect((await pad(page, '[data-slot="sheet-content"]')).bottom).toBe("34px");
    // Bottom sheet nằm giữa màn hình, KHÔNG chạm tai thỏ ⇒ nút đóng giữ 0.75rem, không cộng inset trên.
    const close = page.locator('[data-slot="sheet-content"] [data-slot="sheet-close"]');
    expect(await close.evaluate((e) => getComputedStyle(e).top)).toBe("12px");
  });

  test("trang ngắn không cuộn dư phần inset (đệm body + min-h)", async ({ page }) => {
    await datInset(page, { top: 47, bottom: 34, left: 0, right: 0 });
    await page.goto("/dang-nhap");
    const [cao, khung] = await page.evaluate(() => [document.scrollingElement!.scrollHeight, window.innerHeight]);
    expect(cao).toBeLessThanOrEqual(khung);
  });

  test("ngăn kéo điều hướng trái: đệm trên/dưới, nút đóng tránh tai thỏ", async ({ page }) => {
    await iphoneDaDangNhap(page);
    await page.getByRole("navigation", { name: "Điều hướng chính" }).getByRole("button", { name: "Thêm" }).click();
    const sheet = '[data-slot="sheet-content"]';
    await expect(page.locator(sheet)).toBeVisible();
    expect(await pad(page, sheet)).toMatchObject({ top: "47px", bottom: "34px" });
    const top = await page.locator(`${sheet} [data-slot="sheet-close"]`).evaluate((e) => getComputedStyle(e).top);
    expect(top).toBe("59px"); // 0.75rem + 47px
  });
});

test.describe("iPhone xoay ngang: toast tránh tai thỏ", () => {
  // > 600px ⇒ sonner dùng `offset` (desktop) chứ không `mobileOffset`.
  test.use({ viewport: { width: 844, height: 390 } });

  test("toast lỗi cách mép phải = 24px + inset phải", async ({ page }) => {
    await datInset(page, { top: 0, bottom: 21, left: 47, right: 47 });
    await dangNhap(page);
    await page.goto("/cai-dat");
    // Thêm danh mục với tên rỗng ⇒ toast.error phía client, KHÔNG ghi DB.
    await page.getByRole("button", { name: "+ Thêm danh mục" }).click();
    await page.getByPlaceholder("Tên danh mục mới").press("Enter");
    const toaster = page.locator("ol[data-sonner-toaster]");
    await expect(toaster.locator("li").first()).toBeVisible(); // ol cao 0 — toast định vị tuyệt đối
    expect(await toaster.evaluate((e) => getComputedStyle(e).right)).toBe("71px");
  });
});
