import { expect, test, type Page } from "@playwright/test";
import { startOfMonth } from "date-fns";

import { testPrisma } from "./ingest-raw";
import { TEST_USER_EMAIL, TEST_USER_PASSWORD } from "./test-constants";

/**
 * E2E "Chốt số dư cuối tháng" — tab Dòng tiền. Đi trọn luồng qua UI: chốt → thẻ hiện chênh lệch có
 * CHỮ đúng dấu → sửa cho khớp → "Khớp sổ" → sửa thêm 2tr tiền mặt → "Tiền thật NHIỀU HƠN sổ" → xoá.
 *
 * DB e2e tích luỹ dữ liệu từ spec khác nên KHÔNG giả định số cuối kỳ: đọc "Cuối kỳ (sổ quỹ)" từ chính
 * thẻ rồi suy số cần gõ. `beforeAll` đảm bảo có sổ (một dòng CAPITAL_IN mang tiền tố E2E, dọn sau).
 */
const MO_TA = "E2E chot so du — mo so";

async function login(page: Page): Promise<void> {
  await page.goto("/dang-nhap");
  await page.getByLabel("Email").fill(TEST_USER_EMAIL);
  await page.getByLabel("Mật khẩu", { exact: true }).fill(TEST_USER_PASSWORD);
  await page.getByRole("button", { name: "Đăng nhập" }).click();
  await expect(page).toHaveURL("/");
}

/** "1.234.567 ₫" / "−1.234.567 ₫" ⇒ số. */
function docTien(text: string): number {
  const am = /[-−]/.test(text);
  const n = Number(text.replace(/\D/g, ""));
  return am ? -n : n;
}

test.describe("Chốt số dư cuối tháng — tab Dòng tiền", () => {
  test.beforeAll(async () => {
    const prisma = testPrisma();
    await prisma.soDuChotThang.deleteMany({ where: { thang: startOfMonth(new Date()) } });
    await prisma.cashMovement.deleteMany({ where: { description: MO_TA } });
    await prisma.cashMovement.create({
      // 100tr chứ không phải 1tr: DB e2e tích luỹ Expense từ spec khác, seed mỏng là `cuoiKy` có thể âm
      // và assert "cuối kỳ dương" đỏ ồn ào vì lý do không liên quan.
      data: { date: new Date(), kind: "CAPITAL_IN", amount: 100_000_000, description: MO_TA },
    });
    await prisma.$disconnect();
  });

  test.afterAll(async () => {
    const prisma = testPrisma();
    await prisma.soDuChotThang.deleteMany({ where: { thang: startOfMonth(new Date()) } });
    await prisma.cashMovement.deleteMany({ where: { description: MO_TA } });
    await prisma.$disconnect();
  });

  test.beforeEach(async ({ page }) => {
    await login(page);
  });

  test("chốt → chênh lệch đúng chữ → sửa khớp → thêm tiền mặt → xoá", async ({ page }) => {
    await page.goto("/tai-chinh?tab=dong-tien");
    const card = page.getByTestId("so-du-chot-card");
    await expect(card).toBeVisible();
    await expect(card.getByText(/Chưa chốt tháng/)).toBeVisible();

    // ① Chốt với 0/0 ⇒ sổ NHIỀU HƠN tiền thật đúng bằng cuối kỳ.
    await card.getByRole("button", { name: "Chốt số dư" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByText(/Chốt số dư cuối tháng/)).toBeVisible();
    await dialog.getByLabel("Tiền mặt", { exact: true }).fill("0");
    await dialog.getByRole("button", { name: "Lưu", exact: true }).click();
    // Cả hai ô = 0 ⇒ form hỏi lại một nhịp, CHƯA gửi (hàng rào "quên gõ ô bank"); bấm lần hai mới lưu.
    await expect(dialog.getByTestId("so-du-chot-hoi-ca-hai-khong")).toBeVisible();
    await dialog.getByRole("button", { name: "Lưu (xác nhận 0)" }).click();
    await expect(page.getByText(/Đã chốt số dư tháng/)).toBeVisible();

    const cuoiKy = docTien((await card.getByTestId("so-du-chot-cuoi-ky").innerText()).trim());
    expect(cuoiKy).toBeGreaterThan(0); // seed mở sổ 100tr ⇒ cuối kỳ dương dù spec khác để lại chi phí
    await expect(card.getByTestId("so-du-chot-chenh-lech")).toContainText("Sổ NHIỀU HƠN tiền thật");

    // ② Sửa bank = cuối kỳ ⇒ khớp.
    await card.getByRole("button", { name: "Sửa" }).click();
    await dialog.getByLabel("Số dư ngân hàng", { exact: true }).fill(String(cuoiKy));
    await dialog.getByRole("button", { name: "Lưu" }).click();
    // Toast lượt này trùng chữ với lượt ① (còn hiện vài giây) ⇒ không assert toast; modal chỉ đóng khi
    // action trả ok nên "dialog ẩn" là mốc đã-lưu chắc chắn, rồi thẻ tự cập nhật sau router.refresh().
    await expect(dialog).toBeHidden();
    await expect(card.getByTestId("so-du-chot-chenh-lech")).toHaveText("Khớp sổ");

    // ③ Thêm 2tr tiền mặt ⇒ tiền thật NHIỀU HƠN sổ đúng 2.000.000.
    await card.getByRole("button", { name: "Sửa" }).click();
    await dialog.getByLabel("Tiền mặt", { exact: true }).fill("2000000");
    await dialog.getByRole("button", { name: "Lưu" }).click();
    await expect(dialog).toBeHidden();
    await expect(card.getByTestId("so-du-chot-chenh-lech")).toContainText("Tiền thật NHIỀU HƠN sổ");
    await expect(card.getByTestId("so-du-chot-chenh-lech")).toContainText("2.000.000");
    // Câu chỉ hướng đi tìm phải ra tới mặt chủ shop, không chỉ nhãn.
    await expect(card.getByTestId("so-du-chot-giai-thich")).toContainText("thu chưa ghi");

    // ④ Xoá qua dialog ⇒ về trạng thái chưa chốt.
    await card.getByRole("button", { name: "Xoá" }).click();
    const xoa = page.getByRole("dialog");
    await expect(xoa.getByText(/Xoá bản chốt tháng/)).toBeVisible();
    await xoa.getByRole("button", { name: "Xoá", exact: true }).click();
    await expect(page.getByText(/Đã xoá bản chốt tháng/)).toBeVisible();
    await expect(card.getByText(/Chưa chốt tháng/)).toBeVisible();
  });
});
