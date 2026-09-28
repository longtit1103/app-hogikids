import { expect, test, type Page } from "@playwright/test";

import { testPrisma } from "./ingest-raw";
import { TEST_USER_EMAIL, TEST_USER_PASSWORD } from "./test-constants";

/**
 * E2E "Nhập quỹ / rút quỹ (ghi tay)" — tab Dòng tiền. Đi CẢ luồng qua UI: mở modal → chọn loại → nhập
 * tiền → Lưu (server action qua webServer → DB e2e) → dòng hiện với số đã format + ô "Vào khác" hiện →
 * xoá qua dialog → dòng biến mất.
 *
 * Dùng loại "Thu khác" chứ KHÔNG phải "Vay vốn": từ 09/2026 hai loại gốc vay bắt buộc gắn `loanId`
 * (zod + CHECK ở DB), luồng đó có spec riêng `so-quy-khoan-vay.spec.ts`.
 *
 * Cách ly: ngày mặc định = hôm nay (lọt view mặc định tab dong-tien = tháng hiện tại); ghi chú mang tiền
 * tố "E2E" + timestamp; `beforeAll` dọn dòng E2E cũ bằng `testPrisma()` (guard chỉ cho đụng DB e2e).
 * KHÔNG assert số dư tuyệt đối — dữ liệu e2e tích luỹ từ spec khác.
 */

async function login(page: Page): Promise<void> {
  await page.goto("/dang-nhap");
  await page.getByLabel("Email").fill(TEST_USER_EMAIL);
  await page.getByLabel("Mật khẩu", { exact: true }).fill(TEST_USER_PASSWORD);
  await page.getByRole("button", { name: "Đăng nhập" }).click();
  await expect(page).toHaveURL("/");
}

/** Chọn 1 mục trong base-ui Select trong dialog (trigger hiện `placeholder`) — cùng helper với chi-phi.spec. */
async function pickSelectOption(page: Page, placeholder: string, optionName: string): Promise<void> {
  await page.getByText(placeholder, { exact: true }).click();
  await page.getByRole("option", { name: optionName, exact: true }).click();
}

test.describe("Nhập quỹ / rút quỹ — tab Dòng tiền", () => {
  test.beforeAll(async () => {
    const prisma = testPrisma();
    await prisma.cashMovement.deleteMany({
      where: { description: { startsWith: "E2E" }, loanId: null },
    });
    await prisma.$disconnect();
  });

  test.beforeEach(async ({ page }) => {
    await login(page);
  });

  test("Thêm Thu khác qua UI → toast + dòng hiện + ô Vào khác; xoá qua dialog → dòng mất", async ({ page }) => {
    const desc = `E2E thu khac ${Date.now()}`;
    await page.goto("/tai-chinh?tab=dong-tien");

    await expect(page.getByText("Nhập quỹ / rút quỹ (ghi tay)")).toBeVisible();
    await page.locator("#ghi-tay").getByRole("button", { name: "+ Nhập quỹ" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByText("Nhập quỹ / rút quỹ", { exact: true })).toBeVisible();

    await pickSelectOption(page, "Chọn loại khoản", "Thu khác");
    // Gợi ý theo loại hiện dưới ô chọn.
    await expect(dialog.getByText(/Khoản thu không thuộc loại nào ở trên/)).toBeVisible();
    await dialog.getByPlaceholder("0").fill("1234567");
    await dialog.locator("textarea").fill(desc);
    await dialog.getByRole("button", { name: "Lưu" }).click();

    await expect(page.getByText(/Đã ghi Thu khác/)).toBeVisible();

    const row = page.locator("tbody tr").filter({ hasText: desc }).first();
    await expect(row).toContainText("1.234.567");
    await expect(row).toContainText("Thu khác");
    await expect(page.getByText("Vào khác", { exact: true })).toBeVisible();
    // Card Số dư nói rõ phần vào khác.
    await expect(page.getByText(/trong đó vào khác/)).toBeVisible();

    // Xoá qua dialog.
    await row.getByRole("button", { name: "Xóa" }).click();
    const xoa = page.getByRole("dialog");
    await expect(xoa.getByText("Xóa khoản tiền")).toBeVisible();
    await xoa.getByRole("button", { name: "Xóa", exact: true }).click();
    await expect(page.getByText("Đã xóa")).toBeVisible();
    await expect(page.locator("tbody tr").filter({ hasText: desc })).toHaveCount(0);
  });

  test("Chưa chọn loại → nút Lưu bị khoá", async ({ page }) => {
    await page.goto("/tai-chinh?tab=dong-tien");
    await page.locator("#ghi-tay").getByRole("button", { name: "+ Nhập quỹ" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByPlaceholder("0").fill("500000");
    await expect(dialog.getByRole("button", { name: "Lưu" })).toBeDisabled();
  });

  // Ô Ngày xoá trống: trước đây vẫn Lưu được, dòng rơi về 01/01/1970 mà toast vẫn xanh.
  test("Xoá trống ô Ngày → nút Lưu bị khoá", async ({ page }) => {
    await page.goto("/tai-chinh?tab=dong-tien");
    await page.locator("#ghi-tay").getByRole("button", { name: "+ Nhập quỹ" }).click();
    const dialog = page.getByRole("dialog");

    await pickSelectOption(page, "Chọn loại khoản", "Thu khác");
    await dialog.getByPlaceholder("0").fill("500000");
    await expect(dialog.getByRole("button", { name: "Lưu" })).toBeEnabled();

    await dialog.locator('input[type="date"]').fill("");
    await expect(dialog.getByRole("button", { name: "Lưu" })).toBeDisabled();
  });
});
