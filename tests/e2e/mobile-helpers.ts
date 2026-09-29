import { expect, type Page } from "./fixture-cho-trang-stream-xong";

import { TEST_USER_EMAIL, TEST_USER_PASSWORD } from "./test-constants";

export type Inset = { top: number; bottom: number; left: number; right: number };

/** Khung + tai thỏ/thanh home iPhone 15/16 dọc. */
export const KHUNG_IPHONE = { width: 390, height: 844 };
export const INSET_IPHONE: Inset = { top: 47, bottom: 34, left: 0, right: 0 };

/** Safe-area THẬT trên Chromium qua CDP (đo 26/09: body nhận đúng inset). Gọi TRƯỚC `goto`. */
export async function datInset(page: Page, insets: Inset): Promise<void> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setSafeAreaInsetsOverride" as never, { insets } as never);
}

export async function dangNhap(page: Page): Promise<void> {
  await page.goto("/dang-nhap");
  await page.getByLabel("Email").fill(TEST_USER_EMAIL);
  await page.getByLabel("Mật khẩu", { exact: true }).fill(TEST_USER_PASSWORD);
  await page.getByRole("button", { name: "Đăng nhập" }).click();
  // 20s thay mặc định 5s: đăng nhập local đo 2,8–9,6s khi DB e2e qua Tailscale chậm/mất gói — đây
  // là ngân sách hạ tầng cho bước chuẩn bị, không phải nới assertion của tính năng đang kiểm.
  await expect(page).toHaveURL("/", { timeout: 20_000 });
}
