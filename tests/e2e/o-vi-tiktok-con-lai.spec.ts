import { expect, test, type Page } from "@playwright/test";

import { testPrisma } from "./ingest-raw";
import { TEST_USER_EMAIL, TEST_USER_PASSWORD } from "./test-constants";

/**
 * E2E ô "Còn ở ví TikTok" trong thẻ Quỹ (tab Dòng tiền): có statement TikTok + sổ đã mở ⇒ ô hiện,
 * mang nhãn "≈ tối thiểu" và câu "Không cộng vào quỹ".
 *
 * CHỈ kiểm nhánh HIỆN. Nhánh ẩn (0 statement) cần xoá TẠM cả bảng `TiktokSettlement` của DB e2e dùng
 * chung — tiến trình chết giữa chừng thì không khôi phục được; nhánh đó do test tích hợp phủ
 * (`tests/vi-tiktok-con-lai-toi-thieu.integration.test.ts`, ca "chưa có statement ⇒ null"). Không
 * giả định số tuyệt đối: DB e2e local có thể tích luỹ statement từ lượt khác.
 */

async function login(page: Page): Promise<void> {
  await page.goto("/dang-nhap");
  await page.getByLabel("Email").fill(TEST_USER_EMAIL);
  await page.getByLabel("Mật khẩu", { exact: true }).fill(TEST_USER_PASSWORD);
  await page.getByRole("button", { name: "Đăng nhập" }).click();
  await expect(page).toHaveURL("/");
}

test.describe("Ô Còn ở ví TikTok — tab Dòng tiền", () => {
  const STATEMENT_ID = `e2e-vi-tiktok-${Date.now()}`;
  const DESC_MO_SO = `E2E vi tiktok mo so ${Date.now()}`;

  test.beforeAll(async () => {
    const prisma = testPrisma();
    // Thẻ Quỹ chỉ render ô ở nhánh ĐÃ MỞ SỔ — DB e2e mới tinh (CI) có thể chưa có dòng ghi tay nào.
    await prisma.cashMovement.create({
      data: { date: new Date(), kind: "CAPITAL_IN", amount: 1, description: DESC_MO_SO },
    });
    await prisma.tiktokSettlement.create({
      data: {
        statementId: STATEMENT_ID,
        shopId: "100975192",
        statementTime: new Date(),
        paymentTime: new Date(),
        paymentStatus: "SETTLED",
        settlementAmount: 1_234_567,
        revenueAmount: 1_234_567,
        feeAmount: 0,
        adjustmentAmount: 0,
        netSalesAmount: 1_234_567,
        shippingCostAmount: 0,
      },
    });
    await prisma.$disconnect();
  });

  test.afterAll(async () => {
    const prisma = testPrisma();
    await prisma.tiktokSettlement.deleteMany({ where: { statementId: STATEMENT_ID } });
    await prisma.cashMovement.deleteMany({ where: { description: DESC_MO_SO } });
    await prisma.$disconnect();
  });

  test("có statement ⇒ ô hiện, nhãn ≈ tối thiểu, nói rõ không cộng vào quỹ", async ({ page }) => {
    await login(page);
    await page.goto("/tai-chinh?tab=dong-tien");

    const o = page.getByTestId("o-vi-tiktok-con-lai");
    await expect(o).toBeVisible();
    await expect(o).toContainText("Còn ở ví TikTok");
    await expect(o).toContainText("≈ tối thiểu");
    await expect(o).toContainText("Không cộng vào quỹ");
    await expect(o).toContainText("từ ngày mở sổ (đã chốt, chưa rút về quỹ)");
    await expect(o).not.toContainText("dữ liệu ví không khớp");
  });
});
