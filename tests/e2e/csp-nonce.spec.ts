import { expect, test, type Page } from "@playwright/test";

import { TEST_USER_EMAIL, TEST_USER_PASSWORD } from "./test-constants";

/**
 * Lưới Content-Security-Policy (`src/proxy.ts` + `src/lib/content-security-policy.ts`).
 *
 * CSP sai KHÔNG làm test chức năng nào đỏ theo cách dễ đọc — nó làm TRẮNG TRANG hoặc âm thầm tắt
 * một thư viện (biểu đồ, toast, xuất Excel). Spec này đi qua mọi route trang thật của app và đòi
 * ĐÚNG 0 vi phạm, bắt bằng hai đường độc lập:
 *  - sự kiện `securitypolicyviolation` của trình duyệt (đẩy về test qua binding, sống qua mọi lượt
 *    điều hướng);
 *  - console của trình duyệt (Chrome in "Refused to ... Content Security Policy") — lưới dự phòng
 *    khi vi phạm xảy ra trước lúc listener kịp gắn.
 *
 * Chạy được cả ở dev (`npm run dev`, CSP có `'unsafe-eval'`) lẫn production (`next start`, KHÔNG có
 * `'unsafe-eval'`) — spec chỉ dùng đường dẫn tương đối. NHƯNG CI chỉ chạy `next dev` (chính sách
 * dev, có `'unsafe-eval'`) — spec này KHÔNG tự chạy trên build production nào cả. Chính sách
 * production (không `'unsafe-eval'`, có thể lộ khác biệt spec dev không thấy) PHẢI được smoke
 * THỦ CÔNG sau mỗi lần build production — xem bước smoke CSP trong checklist deploy ở
 * `docs/huong-dan-trien-khai.md`.
 */

type ViPham = { directive: string; blocked: string; url: string };

/** Danh sách route TRANG thật (mọi file `page.tsx` dưới `src/app`), gồm các tab chọn qua `?tab=`. */
const CAC_TRANG = [
  "/",
  "/don-hang",
  "/san-pham",
  "/san-pham/dong-bo-gia-von",
  "/ton-kho",
  "/tai-chinh",
  "/tai-chinh?tab=dong-tien",
  "/tai-chinh?tab=so-quy",
  "/tai-chinh?tab=so-chi-phi",
  "/tai-chinh/chi-phi-nhap-hang",
  "/tai-chinh/thung-rac",
  "/bao-cao",
  "/bao-cao?tab=xu-huong",
  "/chi-phi",
  "/cai-dat",
  "/kenh",
  "/marketing",
  // Trang 404 — trước đây Next prerender tĩnh (HTML không có nonce); root layout giờ ép động.
  "/duong-dan-khong-ton-tai-de-thu-csp",
];

async function login(page: Page): Promise<void> {
  await page.goto("/dang-nhap");
  await page.getByLabel("Email").fill(TEST_USER_EMAIL);
  await page.getByLabel("Mật khẩu", { exact: true }).fill(TEST_USER_PASSWORD);
  await page.getByRole("button", { name: "Đăng nhập" }).click();
  await expect(page).toHaveURL("/");
}

/** Gắn hai lưới bắt vi phạm vào `page`; trả mảng tích luỹ để assert cuối. */
async function batViPham(page: Page): Promise<ViPham[]> {
  const viPham: ViPham[] = [];
  await page.exposeBinding("__baoViPhamCsp", (_src, v: ViPham) => {
    viPham.push(v);
  });
  await page.addInitScript(() => {
    document.addEventListener("securitypolicyviolation", (e) => {
      const bao = (window as unknown as { __baoViPhamCsp?: (v: unknown) => void }).__baoViPhamCsp;
      bao?.({ directive: e.violatedDirective, blocked: e.blockedURI, url: e.documentURI });
    });
  });
  page.on("console", (msg) => {
    const text = msg.text();
    if (/Content Security Policy/i.test(text)) {
      viPham.push({ directive: "console", blocked: text, url: page.url() });
    }
  });
  return viPham;
}

/** Nonce trong header CSP của response, hoặc `null` khi header vắng. */
function docNonce(csp: string | undefined): string | null {
  return csp?.match(/'nonce-([^']+)'/)?.[1] ?? null;
}

/**
 * Chứng minh script của Next THỰC SỰ chạy dưới CSP (không chỉ HTML hiện ra): script bootstrap có
 * mang đúng nonce của header, và runtime client của Next đã khởi động.
 */
async function kiemScriptNextDaChay(page: Page, nonceHeader: string | null): Promise<void> {
  expect(nonceHeader, "response trang phải có CSP mang nonce").not.toBeNull();
  const nonceTrongTrang = await page.evaluate(() =>
    Array.from(document.querySelectorAll("script")).map((s) => s.nonce)
  );
  expect(nonceTrongTrang).toContain(nonceHeader);
  await expect
    .poll(() => page.evaluate(() => Boolean((window as unknown as { next?: { version?: string } }).next?.version)))
    .toBe(true);
}

test.describe("Content-Security-Policy có nonce", () => {
  test("header CSP mang nonce KHÁC NHAU giữa hai request; /api/* không bị gắn CSP", async ({ request }) => {
    const r1 = await request.get("/dang-nhap");
    const r2 = await request.get("/dang-nhap");
    const csp1 = r1.headers()["content-security-policy"];
    const csp2 = r2.headers()["content-security-policy"];

    expect(csp1).toContain("'strict-dynamic'");
    expect(csp1).toContain("frame-ancestors 'none'");
    const n1 = docNonce(csp1);
    const n2 = docNonce(csp2);
    expect(n1).not.toBeNull();
    expect(n2).not.toBeNull();
    expect(n1).not.toBe(n2);

    // Header bảo mật tĩnh ở `next.config.ts` vẫn còn nguyên.
    expect(r1.headers()["x-frame-options"]).toBe("DENY");
    expect(r1.headers()["x-content-type-options"]).toBe("nosniff");

    // Route API (vd ảnh logo `/api/uploads`) nằm ngoài matcher của proxy.
    const api = await request.get("/api/uploads/khong-ton-tai.png");
    expect(api.headers()["content-security-policy"]).toBeUndefined();
  });

  test("trang đăng nhập + mọi trang chính: 0 vi phạm CSP, script Next chạy bằng nonce", async ({ page }) => {
    test.setTimeout(240_000);
    const viPham = await batViPham(page);

    // Trang đăng nhập (chưa có phiên) — đo trước khi login vì có phiên thì nó chuyển về "/".
    const resDangNhap = await page.goto("/dang-nhap");
    await kiemScriptNextDaChay(page, docNonce(resDangNhap?.headers()["content-security-policy"]));

    await login(page);

    for (const duong of CAC_TRANG) {
      const res = await page.goto(duong, { waitUntil: "networkidle" });
      await kiemScriptNextDaChay(page, docNonce(res?.headers()["content-security-policy"]));
    }

    // Trang chi tiết kênh: id kênh tuỳ DB e2e ⇒ đi theo thẻ đầu tiên trên /kenh (nếu có).
    await page.goto("/kenh", { waitUntil: "networkidle" });
    const theKenh = page.locator('a[href^="/kenh/"]').first();
    if ((await theKenh.count()) > 0) {
      const href = await theKenh.getAttribute("href");
      const res = await page.goto(href!, { waitUntil: "networkidle" });
      await kiemScriptNextDaChay(page, docNonce(res?.headers()["content-security-policy"]));
    }

    expect(viPham, JSON.stringify(viPham, null, 2)).toEqual([]);
  });

  test("tương tác chạy JS phía client dưới CSP: điều hướng client, mở modal, xuất Excel — 0 vi phạm", async ({
    page,
  }) => {
    const viPham = await batViPham(page);
    await login(page);

    // Điều hướng phía client (chunk nạp động qua 'strict-dynamic').
    await page.getByRole("link", { name: "Đơn hàng" }).first().click();
    await expect(page).toHaveURL(/\/don-hang/);

    // Modal (portal + định vị inline style).
    await page.goto("/tai-chinh?tab=dong-tien");
    await page.locator("#ghi-tay").getByRole("button", { name: "+ Nhập quỹ" }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toBeHidden();

    // Xuất Excel (nạp thư viện xlsx động + tải file qua blob) — nút chỉ bật khi kỳ có dữ liệu;
    // DB e2e tích luỹ từ spec khác nên có thể trống ⇒ chỉ kiểm khi bấm được.
    await page.goto("/tai-chinh");
    const nutExcel = page.getByRole("button", { name: "Xuất Excel" });
    if ((await nutExcel.count()) > 0 && (await nutExcel.first().isEnabled())) {
      const taiVe = page.waitForEvent("download");
      await nutExcel.first().click();
      expect((await taiVe).suggestedFilename()).toMatch(/\.xlsx$/);
    }

    expect(viPham, JSON.stringify(viPham, null, 2)).toEqual([]);
  });
});
