import { expect, test } from "./fixture-cho-trang-stream-xong";

import { dangNhap } from "./mobile-helpers";

/**
 * Smoke UI quản trị (chủ shop seed). KHÔNG tạo tài khoản thật — chỉ mở trang/modal và kiểm hành vi ô
 * tick. Luồng tạo → đăng nhập nhân sự → đổi mật khẩu thuộc spec tích hợp riêng.
 */
test.describe("Quản trị — giao diện", () => {
  test.beforeEach(async ({ page }) => {
    await dangNhap(page);
  });

  test("/quan-tri hiện bảng, banner Cloudflare và nút Tạo tài khoản", async ({ page }) => {
    const res = await page.goto("/quan-tri");
    expect(res?.status()).toBe(200);
    await expect(page.getByRole("main").getByRole("heading", { name: "Quản trị" })).toBeVisible();
    await expect(page.getByText("policy Cloudflare Access")).toBeVisible();
    await expect(page.getByRole("button", { name: "Tạo tài khoản" })).toBeVisible();
    // Dòng chủ shop: có huy hiệu, không có menu thao tác.
    await expect(page.getByText("Chủ shop", { exact: true }).first()).toBeVisible();
  });

  test("modal tạo: chọn mẫu Kho ⇒ 3 ô; tick Sửa Chi phí ⇒ Xem tự tick; Lãi/Lỗ thiếu giá vốn ⇒ lỗi", async ({
    page,
  }) => {
    await page.goto("/quan-tri");
    await page.getByRole("button", { name: "Tạo tài khoản" }).click();
    const hopThoai = page.getByRole("dialog");
    await expect(hopThoai).toBeVisible();

    await hopThoai.getByLabel("Áp dụng mẫu").selectOption("kho");
    await expect(hopThoai.getByRole("checkbox", { checked: true })).toHaveCount(3);
    await expect(hopThoai.getByRole("checkbox", { name: "Đơn hàng — Xem" })).toBeChecked();
    await expect(hopThoai.getByRole("checkbox", { name: "Sản phẩm — Xem" })).toBeChecked();
    await expect(hopThoai.getByRole("checkbox", { name: "Tồn kho — Xem" })).toBeChecked();

    await hopThoai.getByRole("checkbox", { name: "Sổ chi phí — Sửa" }).click();
    await expect(hopThoai.getByRole("checkbox", { name: "Sổ chi phí — Xem" })).toBeChecked();

    await expect(hopThoai.getByTestId("loi-to-hop-quyen")).toHaveCount(0);
    await hopThoai.getByRole("checkbox", { name: "Tài chính — Lãi/Lỗ — Xem" }).click();
    await expect(hopThoai.getByTestId("loi-to-hop-quyen")).toContainText("giá vốn");
    // Không tự tick giá vốn.
    await expect(hopThoai.getByRole("checkbox", { name: "Xem giá vốn & lợi nhuận" })).not.toBeChecked();
  });

  test("/quan-tri/nhat-ky trả 200 và có bộ lọc", async ({ page }) => {
    const res = await page.goto("/quan-tri/nhat-ky");
    expect(res?.status()).toBe(200);
    await expect(page.getByRole("main").getByRole("heading", { name: "Nhật ký thao tác" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Lọc" })).toBeVisible();
  });

  test("/khong-co-quyen hiện đường dẫn an toàn và bỏ đường dẫn ngoài miền", async ({ page }) => {
    await page.goto("/khong-co-quyen?tu=/tai-chinh");
    await expect(page.getByText("Bạn không có quyền vào")).toBeVisible();
    await expect(page.getByText("/tai-chinh", { exact: true })).toBeVisible();

    await page.goto("/khong-co-quyen?tu=//evil.example");
    await expect(page.getByText("evil.example")).toHaveCount(0);
    await expect(page.getByRole("link", { name: "Về trang chủ" })).toBeVisible();
  });

  test("/doi-mat-khau-lan-dau: chủ shop không còn cờ ⇒ về /", async ({ page }) => {
    await page.goto("/doi-mat-khau-lan-dau");
    await expect(page).toHaveURL("/");
  });
});
