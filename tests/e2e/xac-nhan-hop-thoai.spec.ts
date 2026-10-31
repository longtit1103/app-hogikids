import { expect, test, type Page } from "./fixture-cho-trang-stream-xong";

import { TEST_USER_EMAIL, TEST_USER_PASSWORD } from "./test-constants";

/**
 * Hộp xác nhận của app thay hộp confirm gốc của trình duyệt (bị chặn trong PWA/iOS): đóng form chi phí
 * khi còn dữ liệu chưa lưu phải hỏi bằng AlertDialog LỒNG trong form — chọn "Tiếp tục sửa" giữ nguyên
 * form + dữ liệu, chọn "Bỏ thay đổi" mới đóng. Không bao giờ bật hộp thoại gốc của trình duyệt.
 */

async function login(page: Page): Promise<void> {
  await page.goto("/dang-nhap");
  await page.getByLabel("Email").fill(TEST_USER_EMAIL);
  await page.getByLabel("Mật khẩu", { exact: true }).fill(TEST_USER_PASSWORD);
  await page.getByRole("button", { name: "Đăng nhập" }).click();
  await expect(page).toHaveURL("/");
}

test.describe("Hộp xác nhận bỏ thay đổi", () => {
  test("đóng form chi phí đang sửa dở: ở lại giữ dữ liệu, bỏ thay đổi mới đóng", async ({ page }) => {
    let hopGocCuaTrinhDuyet = 0;
    page.on("dialog", async (d) => {
      hopGocCuaTrinhDuyet += 1;
      await d.dismiss();
    });

    await login(page);
    await page.goto("/tai-chinh?tab=so-chi-phi");
    await page.getByRole("button", { name: "+ Thêm chi phí" }).first().click();
    const form = page.getByRole("dialog");
    await expect(form.getByText("Thêm chi phí")).toBeVisible();

    await form.getByPlaceholder("0").fill("12345");
    await page.keyboard.press("Escape");

    const hoi = page.getByRole("alertdialog");
    await expect(hoi).toBeVisible();
    await hoi.getByTestId("xac-nhan-huy").click();
    await expect(hoi).toBeHidden();
    // Form vẫn mở và còn nguyên số vừa gõ.
    await expect(form.getByPlaceholder("0")).toHaveValue("12.345");

    await page.keyboard.press("Escape");
    await expect(hoi).toBeVisible();
    await hoi.getByTestId("xac-nhan-dong-y").click();
    await expect(page.getByRole("dialog")).toHaveCount(0);

    expect(hopGocCuaTrinhDuyet).toBe(0);
  });

  test("bấm Esc khi hộp xác nhận đang hiện: chỉ đóng hộp, form giữ nguyên và không hỏi lại", async ({ page }) => {
    await login(page);
    await page.goto("/tai-chinh?tab=so-chi-phi");
    await page.getByRole("button", { name: "+ Thêm chi phí" }).first().click();
    const form = page.getByRole("dialog");
    await expect(form.getByText("Thêm chi phí")).toBeVisible();
    await form.getByPlaceholder("0").fill("777");

    await page.keyboard.press("Escape");
    const hoi = page.getByRole("alertdialog");
    await expect(hoi).toBeVisible();

    // Esc lần hai khi hộp đang hiện = đóng chính hộp đó (như "Tiếp tục sửa"), KHÔNG đóng form cha và
    // KHÔNG bật lại hộp (hỏi vô hạn).
    await page.keyboard.press("Escape");
    await expect(hoi).toBeHidden();
    await page.waitForTimeout(400);
    await expect(hoi).toHaveCount(0);
    await expect(form.getByPlaceholder("0")).toHaveValue("777");

    // Rồi vẫn đóng được bình thường: Esc → hỏi một lần → Bỏ thay đổi.
    await page.keyboard.press("Escape");
    await expect(hoi).toBeVisible();
    await hoi.getByTestId("xac-nhan-dong-y").click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
  });

  test("form nhập quỹ (Dòng tiền) cũng hỏi khi đóng dở và Esc trong hộp không hỏi lại", async ({ page }) => {
    let hopGocCuaTrinhDuyet = 0;
    page.on("dialog", async (d) => {
      hopGocCuaTrinhDuyet += 1;
      await d.dismiss();
    });

    await login(page);
    await page.goto("/tai-chinh?tab=dong-tien");
    await page.locator("#ghi-tay").getByRole("button", { name: "+ Nhập quỹ" }).click();
    const form = page.getByRole("dialog");
    await expect(form.getByText("Nhập quỹ / rút quỹ", { exact: true })).toBeVisible();
    await form.getByPlaceholder("0").fill("4242");

    await page.keyboard.press("Escape");
    const hoi = page.getByRole("alertdialog");
    await expect(hoi).toBeVisible();

    // "Tiếp tục sửa" giữ nguyên số đã gõ.
    await hoi.getByTestId("xac-nhan-huy").click();
    await expect(hoi).toBeHidden();
    await expect(form.getByPlaceholder("0")).toHaveValue("4.242");

    // Esc khi hộp đang hiện chỉ đóng hộp.
    await page.keyboard.press("Escape");
    await expect(hoi).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(hoi).toBeHidden();
    await page.waitForTimeout(400);
    await expect(hoi).toHaveCount(0);
    await expect(form.getByPlaceholder("0")).toHaveValue("4.242");

    await page.keyboard.press("Escape");
    await expect(hoi).toBeVisible();
    await hoi.getByTestId("xac-nhan-dong-y").click();
    await expect(page.getByRole("dialog")).toHaveCount(0);

    expect(hopGocCuaTrinhDuyet).toBe(0);
  });

  test("form chưa gõ gì thì đóng thẳng, không hỏi", async ({ page }) => {
    await login(page);
    await page.goto("/tai-chinh?tab=so-chi-phi");
    await page.getByRole("button", { name: "+ Thêm chi phí" }).first().click();
    await expect(page.getByRole("dialog")).toBeVisible();

    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(page.getByRole("alertdialog")).toHaveCount(0);
  });
});
