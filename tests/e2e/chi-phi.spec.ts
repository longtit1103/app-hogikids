import { expect, test, type Page } from "@playwright/test";
import { format } from "date-fns";

import { testPrisma } from "./ingest-raw";
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

    // Đếm trong BẢNG SỔ CHI PHÍ thôi — khối "Khoản chi định kỳ" (bảng trong `<details>`) cũng in mô tả
    // của MẪU, đếm lẫn thì ra 2 dù Expense vẫn đúng 1.
    const dongSo = () => page.locator("table:not(details table) tbody tr").filter({ hasText: desc });

    // Đúng 1 dòng ngay sau khi tạo…
    await page.goto(`/tai-chinh?tab=so-chi-phi&q=${encodeURIComponent(desc)}`);
    await expect(dongSo()).toHaveCount(1);

    // …và vẫn đúng 1 dòng sau reload (ensureRecurringExpenses idempotent trong tháng).
    await page.reload();
    await expect(dongSo()).toHaveCount(1);
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

  test.describe("Khối 'Khoản chi định kỳ'", () => {
    const prefix = `E2E dinh ky ${Date.now()}`;
    const tenActive = `${prefix} — đang chạy`;
    const tenInactive = `${prefix} — đã dừng`;

    test.beforeAll(async () => {
      const prisma = testPrisma();
      await prisma.recurringExpense.createMany({
        data: [
          { categoryId: "packaging", amount: 250_000, dayOfMonth: 12, description: tenActive, active: true },
          { categoryId: "fixed", amount: 800_000, dayOfMonth: 3, description: tenInactive, active: false },
        ],
      });
      await prisma.$disconnect();
    });

    test.afterAll(async () => {
      const prisma = testPrisma();
      // Mở tab là `ensureRecurringExpensesForMonths` SINH Expense từ mẫu đang chạy — `recurringId` không
      // có FK nên xoá mẫu không kéo theo; dọn cả hai kẻo spec sau thấy khoản chi lạ trong Lãi/Lỗ.
      const mau = await prisma.recurringExpense.findMany({
        where: { description: { startsWith: prefix } },
        select: { id: true },
      });
      await prisma.expense.deleteMany({ where: { recurringId: { in: mau.map((m) => m.id) } } });
      await prisma.recurringExpense.deleteMany({ where: { description: { startsWith: prefix } } });
      await prisma.$disconnect();
    });

    test("mở khối → thấy cả mẫu đang chạy lẫn đã dừng, đúng badge; nút Bật lại CHỈ ở mẫu đã dừng", async ({ page }) => {
      await page.goto("/tai-chinh?tab=so-chi-phi");

      const khoi = page.locator("details", { hasText: "Khoản chi định kỳ" });
      await expect(khoi).toBeVisible();
      // Mặc định GẤP — mở bằng bấm summary trước khi tìm dòng bên trong.
      await khoi.locator("summary").click();

      const rowActive = khoi.locator("tr", { hasText: tenActive });
      await expect(rowActive).toBeVisible();
      await expect(rowActive.getByText("Đang chạy", { exact: true })).toBeVisible();
      await expect(rowActive).toContainText("250.000");
      await expect(rowActive).toContainText("ngày 12 hằng tháng");

      const rowInactive = khoi.locator("tr", { hasText: tenInactive });
      await expect(rowInactive).toBeVisible();
      await expect(rowInactive.getByText("Đã dừng", { exact: true })).toBeVisible();

      // Bật lại chỉ dành cho mẫu đã dừng (server đặt mốc `activeFrom` = tháng hiện tại ⇒ không ghi bù
      // các tháng đã dừng). Không bấm ở đây: bấm là đổi dữ liệu dùng chung của các spec khác trong file.
      await expect(rowInactive.getByRole("button", { name: "Bật lại" })).toHaveCount(1);
      await expect(rowActive.getByRole("button", { name: /bật lại/i })).toHaveCount(0);
    });
  });
});
