import { expect, test } from "@playwright/test";

import { TEST_USER_EMAIL, TEST_USER_PASSWORD } from "./test-constants";

test.describe("Đăng nhập", () => {
  test("sai email/mật khẩu hiện lỗi chung và ở lại /dang-nhap", async ({ page }) => {
    await page.goto("/dang-nhap");

    await page.getByLabel("Email").fill("khong-ton-tai@hogikids.test");
    await page.getByLabel("Mật khẩu", { exact: true }).fill("mat-khau-sai-bet");
    await page.getByRole("button", { name: "Đăng nhập" }).click();

    await expect(page.getByText("Email hoặc mật khẩu không đúng")).toBeVisible();
    await expect(page).toHaveURL(/\/dang-nhap/);
  });

  test("đúng thông tin đăng nhập chuyển hướng khỏi /dang-nhap và set session cookie", async ({
    page,
  }) => {
    await page.goto("/dang-nhap");

    await page.getByLabel("Email").fill(TEST_USER_EMAIL);
    await page.getByLabel("Mật khẩu", { exact: true }).fill(TEST_USER_PASSWORD);
    await page.getByRole("button", { name: "Đăng nhập" }).click();

    await expect(page).toHaveURL("/");

    const cookies = await page.context().cookies();
    expect(cookies.some((cookie) => cookie.name === "hogikids_session")).toBe(true);

    // App shell (sidebar nav) is rendered post-login — confirms the (app)
    // route group's requireUser() guard let the authenticated session through.
    await expect(page.getByRole("link", { name: "Đơn hàng" }).first()).toBeVisible();
  });
});
