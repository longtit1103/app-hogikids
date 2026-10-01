import { expect, test, type Page } from "./fixture-cho-trang-stream-xong";

import { testPrisma } from "./ingest-raw";
import { taoTaiKhoanStaff } from "./tao-tai-khoan-staff";

/**
 * `/tai-chinh` và khung menu theo quyền tài khoản phụ (spec §1.4, §4.4). Tài khoản STAFF tạo thẳng
 * trong DB e2e qua `taoTaiKhoanStaff` (cùng bộ chuẩn hoá quyền với form quản trị).
 *
 * Bắt thêm lỗi tuần tự hoá RSC: khung menu nhận `hrefDuocPhep: string[]` từ server; truyền nhầm
 * `NavItem` (mang icon là component) chỉ nổ ở bản build production — nên spec này cũng nằm trong bộ
 * `playwright.prod.config.ts` và soi console trình duyệt.
 */

const MAT_KHAU = "Staff-Password-123!";
const EMAIL_DONG_TIEN = "staff-dong-tien@hogikids.test";
const EMAIL_SO_QUY = "staff-so-quy@hogikids.test";

const LOI_TUAN_TU_HOA = [/Functions cannot be passed directly to Client Components/, /Only plain objects/];

test.beforeAll(async () => {
  const prisma = testPrisma();
  try {
    await taoTaiKhoanStaff(prisma, {
      email: EMAIL_DONG_TIEN,
      matKhau: MAT_KHAU,
      quyen: ["tai-chinh-dong-tien:xem"],
    });
    await taoTaiKhoanStaff(prisma, {
      email: EMAIL_SO_QUY,
      matKhau: MAT_KHAU,
      quyen: ["tai-chinh-so-quy:xem"],
    });
  } finally {
    await prisma.$disconnect();
  }
});

test.afterAll(async () => {
  const prisma = testPrisma();
  try {
    await prisma.user.deleteMany({ where: { email: { in: [EMAIL_DONG_TIEN, EMAIL_SO_QUY] } } });
  } finally {
    await prisma.$disconnect();
  }
});

/** Ghi lại mọi console.error của trang để khẳng định không có lỗi tuần tự hoá. */
function theoDoiConsole(page: Page): string[] {
  const loi: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") loi.push(m.text());
  });
  page.on("pageerror", (e) => loi.push(e.message));
  return loi;
}

async function dangNhap(page: Page, email: string): Promise<void> {
  await page.goto("/dang-nhap");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Mật khẩu", { exact: true }).fill(MAT_KHAU);
  await page.getByRole("button", { name: "Đăng nhập" }).click();
  // Nơi hạ cánh sau đăng nhập tuỳ quyền — chỉ cần đã rời trang đăng nhập.
  await page.waitForURL((u) => !u.pathname.startsWith("/dang-nhap"));
}

const thanhTab = (page: Page) => page.getByRole("navigation", { name: "Lăng kính tài chính" });

test.describe("/tai-chinh theo quyền", () => {
  test("chỉ Dòng tiền: tab mặc định Dòng tiền, không có thẻ Quỹ / khoản vay / sổ tiết kiệm", async ({ page }) => {
    const loiConsole = theoDoiConsole(page);
    await dangNhap(page, EMAIL_DONG_TIEN);

    await page.goto("/tai-chinh");
    await expect(page).toHaveURL(/\/tai-chinh(\?|$)/);
    // Thanh tab chỉ liệt kê tab có quyền riêng.
    await expect(thanhTab(page).getByRole("link")).toHaveCount(1);
    await expect(thanhTab(page).getByRole("link", { name: "Dòng tiền" })).toBeVisible();

    // Khối Dòng tiền có; khối Sổ quỹ KHÔNG có trong DOM (không query, không render).
    await expect(page.getByText("Tiền đã về (thật)")).toBeVisible();
    await expect(page.getByText("Quỹ còn lại")).toHaveCount(0);
    await expect(page.locator("#khoan-vay")).toHaveCount(0);
    await expect(page.locator("#tiet-kiem")).toHaveCount(0);

    expect(loiConsole.filter((l) => LOI_TUAN_TU_HOA.some((re) => re.test(l)))).toEqual([]);
  });

  test("chỉ Dòng tiền: ?tab=loi-lo ⇒ /khong-co-quyen, không rơi về tab mặc định", async ({ page }) => {
    await dangNhap(page, EMAIL_DONG_TIEN);
    await page.goto("/tai-chinh?tab=loi-lo");
    await expect(page).toHaveURL(/\/khong-co-quyen/);
    await expect(page.getByText("Tiền đã về (thật)")).toHaveCount(0);
  });

  test("chỉ Sổ quỹ: tab Sổ quỹ mặc định + tab Dòng tiền (đường vào khoản vay); Dòng tiền chỉ có thẻ Quỹ, không có bảng dòng tiền", async ({ page }) => {
    const loiConsole = theoDoiConsole(page);
    await dangNhap(page, EMAIL_SO_QUY);

    await page.goto("/tai-chinh");
    // "Dòng tiền" vẫn nằm trên thanh tab: khối Khoản vay / Tiết kiệm chỉ ở tab đó.
    await expect(thanhTab(page).getByRole("link")).toHaveCount(2);
    await expect(thanhTab(page).getByRole("link", { name: "Sổ quỹ" })).toBeVisible();

    await thanhTab(page).getByRole("link", { name: "Dòng tiền" }).click();
    await expect(page).toHaveURL(/tab=dong-tien/);
    await expect(page.getByText("Quỹ còn lại").first()).toBeVisible();
    await expect(page.locator("#khoan-vay")).toBeVisible();
    await expect(page.locator("#ghi-tay")).toHaveCount(0);
    await expect(page.getByText("Tiền đã về (thật)")).toHaveCount(0);

    expect(loiConsole.filter((l) => LOI_TUAN_TU_HOA.some((re) => re.test(l)))).toEqual([]);
  });

  test("menu chỉ liệt kê mục có quyền: có Tài chính, không có Đơn hàng / Cài đặt / Quản trị", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await dangNhap(page, EMAIL_SO_QUY);
    await page.goto("/tai-chinh");

    const menu = page.locator("aside");
    await expect(menu.getByRole("link", { name: "Tài chính" })).toBeVisible();
    await expect(menu.getByRole("link", { name: "Đơn hàng" })).toHaveCount(0);
    await expect(menu.getByRole("link", { name: "Cài đặt" })).toHaveCount(0);
    await expect(menu.getByRole("link", { name: "Quản trị" })).toHaveCount(0);
  });
});
