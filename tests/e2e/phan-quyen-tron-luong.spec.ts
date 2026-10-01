import { expect, test } from "./fixture-cho-trang-stream-xong";

import { testPrisma } from "./ingest-raw";
import { dangNhap } from "./mobile-helpers";

/**
 * Trọn luồng nhân sự: chủ shop tạo tài khoản mẫu Kho ở /quan-tri → đọc mật khẩu tạm (hiện một lần) →
 * nhân sự đăng nhập ở phiên riêng → bị đưa tới đổi mật khẩu lần đầu → đổi → vào app chỉ thấy đúng phần
 * được cấp → chủ shop khoá ⇒ phiên nhân sự chết ngay → nhật ký ghi đủ ba sự kiện.
 *
 * Mọi bước đi qua giao diện thật (không gọi action/DB), nên spec bắt cả lỗi nối form↔action↔cổng↔menu.
 */

const EMAIL_KHO = "kho@hogikids.test";
const MAT_KHAU_MOI = "Kho-Moi-Password-456!";

test.beforeAll(async () => {
  const prisma = testPrisma();
  try {
    // Chạy lại spec trên DB cũ: tài khoản nhân sự của lượt trước phải biến mất thì form tạo mới thành công.
    await prisma.user.deleteMany({ where: { email: EMAIL_KHO } });
  } finally {
    await prisma.$disconnect();
  }
});

test.afterAll(async () => {
  const prisma = testPrisma();
  try {
    await prisma.user.deleteMany({ where: { email: EMAIL_KHO } });
  } finally {
    await prisma.$disconnect();
  }
});

test("chủ shop tạo nhân sự Kho → đổi mật khẩu → chỉ thấy 3 mục → bị khoá thì mất phiên → nhật ký đủ", async ({
  page,
  browser,
  baseURL,
}) => {
  // 1. Chủ shop tạo tài khoản mẫu Kho và đọc mật khẩu tạm.
  await dangNhap(page);
  await page.goto("/quan-tri");
  await page.getByRole("button", { name: "Tạo tài khoản" }).click();
  const hopThoaiTao = page.getByRole("dialog");
  await hopThoaiTao.getByLabel("Email").fill(EMAIL_KHO);
  await hopThoaiTao.getByLabel("Tên hiển thị").fill("Nhân viên kho");
  await hopThoaiTao.getByLabel("Áp dụng mẫu").selectOption("kho");
  await hopThoaiTao.getByRole("button", { name: "Tạo tài khoản" }).click();
  const matKhauTam = (await hopThoaiTao.getByTestId("mat-khau-tam-gia-tri").innerText()).trim();
  expect(matKhauTam.length, "mật khẩu tạm phải có nội dung").toBeGreaterThanOrEqual(12);
  await hopThoaiTao.getByRole("button", { name: "Đã lưu, đóng" }).click();
  await expect(page.getByTestId("dong-tai-khoan").filter({ hasText: EMAIL_KHO })).toContainText("Chờ đổi MK");

  // 2. Nhân sự đăng nhập ở phiên riêng ⇒ bị đưa tới đổi mật khẩu lần đầu.
  const ctxKho = await browser.newContext({ baseURL });
  try {
    const kho = await ctxKho.newPage();
    await kho.goto("/dang-nhap");
    await kho.getByLabel("Email").fill(EMAIL_KHO);
    await kho.getByLabel("Mật khẩu", { exact: true }).fill(matKhauTam);
    await kho.getByRole("button", { name: "Đăng nhập" }).click();
    await expect(kho).toHaveURL(/\/doi-mat-khau-lan-dau/, { timeout: 30_000 });

    // Chưa đổi mật khẩu thì chưa vào được app.
    await kho.goto("/don-hang");
    await expect(kho).toHaveURL(/\/doi-mat-khau-lan-dau/);

    await kho.getByLabel("Mật khẩu mới", { exact: true }).fill(MAT_KHAU_MOI);
    await kho.getByLabel("Nhập lại mật khẩu mới").fill(MAT_KHAU_MOI);
    await kho.getByRole("button", { name: "Đổi mật khẩu" }).click();
    await kho.waitForURL((u) => !u.pathname.startsWith("/doi-mat-khau-lan-dau"), { timeout: 30_000 });

    // 3. Mẫu Kho không có tong-quan:xem ⇒ "/" chuyển sang /khong-co-quyen (redirect thật, không trang trắng).
    await kho.goto("/");
    await expect(kho).toHaveURL(/\/khong-co-quyen/);
    await expect(kho.getByText("Bạn không có quyền vào")).toBeVisible();

    // Sidebar máy tính: đúng 3 mục (trừ liên kết logo về "/"), không Quản trị/Cài đặt.
    const hrefSidebar = await kho.locator("aside a[href]").evaluateAll((as) =>
      as.map((a) => a.getAttribute("href")).filter((h) => h !== "/"),
    );
    expect(hrefSidebar).toEqual(["/don-hang", "/san-pham", "/ton-kho"]);

    // Trang ngoài quyền ⇒ /khong-co-quyen; trang được cấp ⇒ vào được.
    await kho.goto("/tai-chinh");
    await expect(kho).toHaveURL(/\/khong-co-quyen/);
    const resDonHang = await kho.goto("/don-hang");
    expect(resDonHang?.status()).toBe(200);
    await expect(kho).toHaveURL(/\/don-hang$/);

    // 4. Chủ shop khoá ⇒ phiên nhân sự chết ngay ở lượt tải kế tiếp.
    await page.goto("/quan-tri");
    await page.getByRole("button", { name: `Thao tác với ${EMAIL_KHO}` }).click();
    await page.getByRole("menuitem", { name: "Khoá" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Khoá" }).click();
    await expect(page.getByText("Đã khoá tài khoản.")).toBeVisible();

    await kho.goto("/don-hang");
    await expect(kho).toHaveURL(/\/dang-nhap/);
  } finally {
    await ctxKho.close();
  }

  // 5. Nhật ký: Tạo tài khoản (chủ shop), Đăng nhập (actor kho), Khoá tài khoản.
  await page.goto("/quan-tri/nhat-ky");
  const dong = page.getByTestId("dong-nhat-ky");
  await expect(dong.filter({ hasText: "Tạo tài khoản" }).filter({ hasText: EMAIL_KHO })).not.toHaveCount(0);
  await expect(
    dong
      .filter({ has: page.getByRole("cell", { name: EMAIL_KHO, exact: true }) })
      .filter({ has: page.getByRole("cell", { name: "Đăng nhập", exact: true }) }),
  ).not.toHaveCount(0);
  await expect(dong.filter({ hasText: "Khoá tài khoản" }).filter({ hasText: EMAIL_KHO })).not.toHaveCount(0);
});
