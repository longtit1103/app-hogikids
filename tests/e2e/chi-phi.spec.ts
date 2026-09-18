import { expect, test, type Page } from "@playwright/test";
import { format } from "date-fns";

import { INGEST_SECRET_TEST, TEST_USER_EMAIL, TEST_USER_PASSWORD } from "./test-constants";

/**
 * E2E màn Chi phí (Phase 4). Cố ý CHỈ dùng UI + HTTP (`/api/ingest/ads`) — không
 * ghi Prisma trực tiếp từ worker: DATABASE_URL của worker Playwright không được
 * bảo đảm trỏ về test DB (chỉ webServer nhận `webServer.env`), nên seed qua
 * endpoint ingest (đi qua webServer → test DB) là đường an toàn duy nhất.
 *
 * Cách ly: mỗi test tự đặt mô tả DUY NHẤT (timestamp) rồi lọc `?q=` để đếm đúng
 * dòng của mình — không phụ thuộc thứ tự chạy, an toàn dưới `fullyParallel`.
 */

const TODAY = format(new Date(), "yyyy-MM-dd");

async function login(page: Page): Promise<void> {
  await page.goto("/dang-nhap");
  await page.getByLabel("Email").fill(TEST_USER_EMAIL);
  await page.getByLabel("Mật khẩu", { exact: true }).fill(TEST_USER_PASSWORD);
  await page.getByRole("button", { name: "Đăng nhập" }).click();
  await expect(page).toHaveURL("/");
}

/** Chọn 1 mục trong base-ui Select đang hiển thị trong dialog (trigger hiện `placeholder`). */
async function pickSelectOption(page: Page, placeholder: string, optionName: string): Promise<void> {
  await page.getByText(placeholder, { exact: true }).click();
  await page.getByRole("option", { name: optionName, exact: true }).click();
}

test.describe("Chi phí", () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
  });

  test("Thêm khoản Đóng gói → toast + dòng mới xuất hiện", async ({ page }) => {
    const desc = `E2E đóng gói ${Date.now()}`;
    await page.goto("/tai-chinh?tab=so-chi-phi");

    await page.getByRole("button", { name: "+ Thêm chi phí" }).first().click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByText("Thêm chi phí")).toBeVisible();

    await pickSelectOption(page, "Chọn danh mục", "Đóng gói");
    await dialog.getByPlaceholder("0").fill("350000");
    await dialog.locator("textarea").fill(desc);
    await dialog.getByRole("button", { name: "Lưu" }).click();

    await expect(page.getByText(/Đã thêm chi phí/)).toBeVisible();

    // Lọc đúng dòng vừa tạo — chứng minh khoản chi đã vào sổ + hiển thị số tiền.
    await page.goto(`/tai-chinh?tab=so-chi-phi&q=${encodeURIComponent(desc)}`);
    const row = page.locator("tbody tr").filter({ hasText: desc }).first();
    await expect(row).toContainText("350.000");
  });

  test("Danh mục Quảng cáo chưa chọn nguồn → nút Lưu bị khoá", async ({ page }) => {
    await page.goto("/tai-chinh?tab=so-chi-phi");
    await page.getByRole("button", { name: "+ Thêm chi phí" }).first().click();
    const dialog = page.getByRole("dialog");

    await pickSelectOption(page, "Chọn danh mục", "Quảng cáo");
    await dialog.getByPlaceholder("0").fill("500000");

    // Field "Nguồn ads" bắt buộc hiện ra và nút Lưu bị khoá tới khi chọn nguồn.
    await expect(dialog.getByText("Nguồn ads")).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Lưu" })).toBeDisabled();
  });

  // Ô Ngày xoá trống: trước đây vẫn Lưu được, dòng chi phí rơi về 01/01/1970 mà toast vẫn xanh
  // (cùng họ lỗi đã vá ở khoản tiền khác — tien-vao-khac.spec).
  test("Xoá trống ô Ngày → nút Lưu bị khoá", async ({ page }) => {
    await page.goto("/tai-chinh?tab=so-chi-phi");
    await page.getByRole("button", { name: "+ Thêm chi phí" }).first().click();
    const dialog = page.getByRole("dialog");

    await pickSelectOption(page, "Chọn danh mục", "Đóng gói");
    await dialog.getByPlaceholder("0").fill("350000");
    await expect(dialog.getByRole("button", { name: "Lưu" })).toBeEnabled();

    await dialog.locator('input[type="date"]').fill("");
    await expect(dialog.getByRole("button", { name: "Lưu" })).toBeDisabled();
  });

  test("Bật 'Lặp lại hàng tháng' → reload không sinh dòng trùng", async ({ page }) => {
    const desc = `E2E định kỳ ${Date.now()}`;
    await page.goto("/tai-chinh?tab=so-chi-phi");

    await page.getByRole("button", { name: "+ Thêm chi phí" }).first().click();
    const dialog = page.getByRole("dialog");
    await pickSelectOption(page, "Chọn danh mục", "Mặt bằng-cố định");
    await dialog.getByPlaceholder("0").fill("1200000");
    await dialog.locator("textarea").fill(desc);
    await dialog.getByRole("switch").click();
    await dialog.getByRole("button", { name: "Lưu" }).click();
    await expect(page.getByText(/Đã thêm chi phí/)).toBeVisible();

    // Đúng 1 dòng ngay sau khi tạo…
    await page.goto(`/tai-chinh?tab=so-chi-phi&q=${encodeURIComponent(desc)}`);
    await expect(page.locator("tbody tr").filter({ hasText: desc })).toHaveCount(1);

    // …và vẫn đúng 1 dòng sau reload (ensureRecurringExpenses idempotent trong tháng).
    await page.reload();
    await expect(page.locator("tbody tr").filter({ hasText: desc })).toHaveCount(1);
  });

  test("Dòng ADS_API hiện 'Xem log' + nút xoá bị khoá", async ({ page }) => {
    const desc = `E2E ADS API ${Date.now()}`;
    // Seed dòng ADS_API qua đúng luồng ingest (đi qua webServer → test DB).
    const res = await page.request.post("/api/ingest/ads", {
      headers: { Authorization: `Bearer ${INGEST_SECRET_TEST}` },
      data: {
        source: "META",
        rows: [{ date: TODAY, campaignId: `e2e-${Date.now()}`, campaignName: desc, spendExVat: 54321, vatRate: 0.1 }],
      },
    });
    expect(res.ok()).toBe(true);

    await page.goto(`/tai-chinh?tab=so-chi-phi&q=${encodeURIComponent(desc)}`);
    const row = page.locator("tbody tr").filter({ hasText: desc }).first();
    await expect(row).toBeVisible();

    // Có "Xem log" trỏ mục Kết nối; KHÔNG có nút Sửa; nút xoá disabled.
    await expect(row.getByRole("link", { name: "Xem log" })).toHaveAttribute("href", "/cai-dat#ket-noi");
    await expect(row.getByRole("button", { name: "Sửa" })).toHaveCount(0);
    await expect(row.locator('button[title*="không xóa tay"]')).toBeDisabled();
  });
});
