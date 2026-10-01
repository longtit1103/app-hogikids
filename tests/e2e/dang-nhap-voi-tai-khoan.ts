import type { Page } from "./fixture-cho-trang-stream-xong";

/**
 * Đăng nhập bằng tài khoản bất kỳ (nhân sự tạo trong spec) và chờ rời `/dang-nhap`. Không khẳng định
 * nơi hạ cánh: tuỳ quyền và cờ đổi mật khẩu lần đầu, người dùng có thể rơi ở `/`, `/khong-co-quyen` hay
 * `/doi-mat-khau-lan-dau` — từng spec tự kiểm đích của nó.
 */
export async function dangNhapVoi(page: Page, email: string, matKhau: string): Promise<void> {
  await page.goto("/dang-nhap");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Mật khẩu", { exact: true }).fill(matKhau);
  await page.getByRole("button", { name: "Đăng nhập" }).click();
  await page.waitForURL((u) => !u.pathname.startsWith("/dang-nhap"), { timeout: 30_000 });
}
