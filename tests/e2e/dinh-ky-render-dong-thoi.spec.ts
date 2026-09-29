import type { Page } from "@playwright/test";

import { expect, test } from "./fixture-cho-trang-stream-xong";
import { format, startOfMonth } from "date-fns";

import { testPrisma } from "./ingest-raw";
import { TEST_USER_EMAIL, TEST_USER_PASSWORD } from "./test-constants";

/**
 * Dashboard (`/`) và Tài chính (`/tai-chinh`) mỗi lượt render đều gọi bộ sinh chi phí định kỳ; thanh
 * tab dưới còn tải sẵn cả hai. Nhiều lượt render ĐỒNG THỜI khi tháng còn thiếu khoản định kỳ phải
 * ra ĐÚNG 1 dòng/mẫu/tháng (UNIQUE `(recurringId, recurringMonth)` + câu chèn ON CONFLICT), không
 * trang nào 500. Chạy được cả `next dev` lẫn bản build.
 */
async function login(page: Page): Promise<void> {
  await page.goto("/dang-nhap");
  await page.getByLabel("Email").fill(TEST_USER_EMAIL);
  await page.getByLabel("Mật khẩu", { exact: true }).fill(TEST_USER_PASSWORD);
  await page.getByRole("button", { name: "Đăng nhập" }).click();
  await expect(page).toHaveURL("/", { timeout: 15_000 });
}

test("render đồng thời Dashboard + Tài chính khi tháng thiếu khoản định kỳ ⇒ đúng 1 dòng, không 500", async ({
  page,
}) => {
  const db = testPrisma();
  const mau = await db.recurringExpense.create({
    // Ngày 1 ⇒ luôn đã tới hạn trong tháng hiện tại; mốc = tháng này ⇒ bộ sinh ghi đúng tháng này.
    data: {
      categoryId: "fixed",
      amount: 1_234_000,
      dayOfMonth: 1,
      description: `E2E đồng thời ${Date.now()}`,
      // Không mốc ⇒ Dashboard/Tài chính sinh cả THÁNG TRƯỚC (2 dòng) — mốc tháng này để kỳ vọng 1 dòng.
      activeFrom: startOfMonth(new Date()),
    },
  });
  try {
    await login(page);
    // `login` đã render `/` một lần ⇒ có thể đã sinh; xoá để tháng THIẾU lại trước lượt đua.
    await db.expense.deleteMany({ where: { recurringId: mau.id } });

    const duong = ["/", "/tai-chinh", "/", "/tai-chinh", "/", "/tai-chinh"];
    const phanHoi = await Promise.all(duong.map((d) => page.request.get(d)));
    for (const [i, r] of phanHoi.entries()) expect(r.status(), duong[i]).toBe(200);

    const dong = await db.expense.findMany({ where: { recurringId: mau.id } });
    expect(dong).toHaveLength(1);
    expect(dong[0].recurringMonth).toBe(format(new Date(), "yyyy-MM"));
    expect(dong[0].amount).toBe(1_234_000);
  } finally {
    await db.expense.deleteMany({ where: { recurringId: mau.id } });
    await db.recurringExpense.delete({ where: { id: mau.id } });
  }
});
