import { expect, test, type Page } from "@playwright/test";
import * as XLSX from "xlsx";

import { testPrisma } from "./ingest-raw";
import { TEST_USER_EMAIL, TEST_USER_PASSWORD } from "./test-constants";

/**
 * E2E nút "Xuất Excel" tab "Sổ quỹ" (dòng chạy) — `/tai-chinh?tab=so-quy`: bấm nút ⇒ tải file
 * `.xlsx` đúng tên, sheet có dòng "Đầu kỳ"/"Cuối kỳ", "Cuối kỳ" khớp đúng số hiện trên màn
 * (`data-testid="so-quy-dong-chay-cuoi-ky"`).
 *
 * DB e2e trên CI có thể CHƯA mở sổ (mới tinh) — tự ghi 1 khoản Thu khác qua UI TRƯỚC để chắc chắn sổ
 * đã mở (cùng bước ① của `so-quy-dong-chay.spec.ts`), dọn đúng khoản mình tạo ở `afterAll`. Nút bấm
 * được thì dữ liệu chắc chắn ở nhánh `CO_SO` — không cần kiểm hai nhánh còn lại ở đây (đã có ở lõi/
 * `dong-chay-so-quy.integration.test.ts`).
 */

async function login(page: Page): Promise<void> {
  await page.goto("/dang-nhap");
  await page.getByLabel("Email").fill(TEST_USER_EMAIL);
  await page.getByLabel("Mật khẩu", { exact: true }).fill(TEST_USER_PASSWORD);
  await page.getByRole("button", { name: "Đăng nhập" }).click();
  await expect(page).toHaveURL("/");
}

async function pickSelectOption(page: Page, placeholder: string, optionName: string): Promise<void> {
  await page.getByText(placeholder, { exact: true }).click();
  await page.getByRole("option", { name: optionName, exact: true }).click();
}

/** "1.234.567 ₫" / "−1.234.567 ₫" ⇒ số — cùng helper với `so-quy-dong-chay.spec.ts`. */
function docTien(text: string): number {
  const am = /[-−]/.test(text);
  const n = Number(text.replace(/\D/g, ""));
  return am ? -n : n;
}

test.describe("Sổ quỹ — nút Xuất Excel", () => {
  const descThu = `E2E so quy xuat excel ${Date.now()}`;

  test.beforeAll(async () => {
    const prisma = testPrisma();
    await prisma.cashMovement.deleteMany({ where: { description: descThu } });
    await prisma.$disconnect();
  });

  test.afterAll(async () => {
    const prisma = testPrisma();
    await prisma.cashMovement.deleteMany({ where: { description: descThu } });
    await prisma.$disconnect();
  });

  test.beforeEach(async ({ page }) => {
    await login(page);
  });

  test("bấm Xuất Excel ⇒ tải đúng tên file, sheet có Đầu/Cuối kỳ, Cuối kỳ khớp số trên màn", async ({
    page,
  }) => {
    // ① Đảm bảo sổ đã mở — trên DB mới tinh (CI), dòng ghi tay đầu tiên mở sổ với ngày mở = hôm nay.
    await page.goto("/tai-chinh?tab=dong-tien");
    await page.locator("#ghi-tay").getByRole("button", { name: "+ Nhập quỹ" }).click();
    const dialog = page.getByRole("dialog");
    await pickSelectOption(page, "Chọn loại khoản", "Thu khác");
    await dialog.getByPlaceholder("0").fill("500000");
    await dialog.locator("textarea").fill(descThu);
    await dialog.getByRole("button", { name: "Lưu" }).click();
    await expect(page.getByText(/Đã ghi Thu khác/)).toBeVisible();

    // ② Tab Sổ quỹ — đọc "Cuối kỳ" hiện trên màn TRƯỚC khi bấm xuất (mốc so sánh với file).
    await page.goto("/tai-chinh?tab=so-quy");
    const cuoiKyTrenMan = docTien(
      (await page.getByTestId("so-quy-dong-chay-cuoi-ky").innerText()).trim()
    );

    // ③ Bấm Xuất Excel ⇒ bắt sự kiện tải file.
    const downloadPromise = page.waitForEvent("download");
    await page.getByRole("button", { name: "Xuất Excel" }).click();
    const download = await downloadPromise;

    // ④ Tên file đúng khuôn `hogikids-so-quy-<yyyy-MM>.xlsx`.
    expect(download.suggestedFilename()).toMatch(/^hogikids-so-quy-\d{4}-\d{2}\.xlsx$/);

    // ⑤ Đọc file vừa tải, kiểm sheet "Sổ quỹ" có Đầu kỳ/Cuối kỳ, Cuối kỳ khớp số trên màn ở bước ②.
    const filePath = await download.path();
    expect(filePath).not.toBeNull();
    const wb = XLSX.readFile(filePath!);
    const ws = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json<Record<string, string | number>>(ws);

    expect(rows.some((r) => r["Diễn giải"] === "Đầu kỳ")).toBe(true);
    // Nhãn có thể là "Cuối kỳ" trơn hoặc "Cuối kỳ (dự kiến hết tháng)" (tháng hiện tại còn khoản ghi
    // ngày sau hôm nay, `nhanCuoiKySoQuy`) — sheet phải khớp ĐÚNG nhãn màn hình chứ không tự cố định
    // một chuỗi, nên so bằng tiền tố thay vì so bằng đúng "Cuối kỳ".
    const dongCuoiKy = rows.find((r) => String(r["Diễn giải"]).startsWith("Cuối kỳ"));
    expect(dongCuoiKy).toBeDefined();
    expect(dongCuoiKy?.["Số dư"]).toBe(cuoiKyTrenMan);
  });
});
