import { expect, test, type Page } from "./fixture-cho-trang-stream-xong";

import { dangNhapVoi } from "./dang-nhap-voi-tai-khoan";
import { ingestPancake, testPrisma } from "./ingest-raw";
import { dangNhap } from "./mobile-helpers";
import { taoTaiKhoanStaff } from "./tao-tai-khoan-staff";

/**
 * Hành vi trang Đơn hàng: kỳ mặc định Tháng này ↔ tất cả thời gian, tab trạng thái, chip lọc, sắp theo
 * lãi, mở drawer bằng bấm dòng + chuyển đơn kề bên, số cột theo khổ màn/quyền, sheet lọc điện thoại và
 * tải Excel. Đơn fixture mang mã riêng (`DHMOI-`), đặt trong vài giờ qua để luôn thuộc Tháng này; các
 * bài lọc thêm `q=DHMOI` vì DB e2e sống qua nhiều lượt và nhiều spec ghi đơn hôm nay.
 */

test.describe.configure({ mode: "serial" });

const MA = "DHMOI";
const SKU = "DHMOI-SKU";
const EMAIL_XEM = "xem-don-hang-moi@hogikids.test";
const MAT_KHAU = "Xem-Don-Hang-123!";

/** Mốc dạng Pancake (chuỗi naive = UTC) cách bây giờ `gio` giờ. */
const truoc = (gio: number) => new Date(Date.now() - gio * 3_600_000).toISOString().replace("Z", "000");

/**
 * Giá vốn 50.000/cái. Đơn lỗ: phí sàn vượt tiền hàng − giá vốn. Đủ 25 đơn (> 20 dòng/trang) để có
 * trang 2 khi xem cả nhóm.
 */
function donFixture(seq: number, status: number, tienHang: number, phiSan: number, returnedFee = 0) {
  return {
    id: `${MA}-${String(seq).padStart(2, "0")}`,
    status,
    inserted_at: truoc(1 + seq * 0.25),
    order_sources_name: "Shopee",
    marketplace_id: "-3",
    total_price: tienHang,
    total_discount: 0,
    fee_marketplace: phiSan,
    ...(returnedFee > 0 ? { advanced_platform_fee: { returned_fee: returnedFee } } : {}),
    items: [{ quantity: 1, discount_each_product: 0, variation_info: { display_id: SKU, name: "SP đơn hàng mới", retail_price: tienHang } }],
  };
}

const DON = [
  donFixture(1, 3, 200_000, 20_000),
  donFixture(2, 3, 100_000, 90_000), // lỗ 40.000
  donFixture(3, 2, 100_000, 70_000), // lỗ 20.000
  donFixture(4, 4, 150_000, 15_000, 12_000), // hoàn có phí sàn giữ
  donFixture(5, 6, 120_000, 0),
  ...Array.from({ length: 20 }, (_, i) => donFixture(10 + i, 3, 180_000 + i * 1_000, 18_000)),
];

async function dangNhapChuShop(page: Page) {
  await dangNhap(page);
}

test.beforeAll(async () => {
  await ingestPancake({
    products: [
      {
        id: `${MA}-P`,
        name: "SP đơn hàng mới",
        variations: [{ id: `${MA}-V`, display_id: SKU, retail_price: 200_000, remain_quantity: 99, average_imported_price: 50_000 }],
      },
    ],
    orders: DON,
  });
  const prisma = testPrisma();
  try {
    // Giá vốn app-owned: ép lại mỗi lượt (ingest không ghi đè khi biến thể đã có).
    await prisma.variant.updateMany({ where: { sku: SKU }, data: { costPrice: 50_000 } });
    await taoTaiKhoanStaff(prisma, { email: EMAIL_XEM, matKhau: MAT_KHAU, quyen: ["tong-quan:xem", "don-hang:xem"] });
  } finally {
    await prisma.$disconnect();
  }
});

test.afterAll(async () => {
  const prisma = testPrisma();
  try {
    await prisma.user.deleteMany({ where: { email: EMAIL_XEM } });
  } finally {
    await prisma.$disconnect();
  }
});

const nhomKy = (page: Page) => page.getByRole("group", { name: "Chọn khoảng thời gian" });
const dongBang = (page: Page) => page.getByTestId("bang-don-hang").getByTestId("dong-don-hang");

/** "−40.000 ₫" → -40000 (dấu trừ U+2212); "—" → 0. */
function docTien(chu: string): number {
  const so = chu.replace(/[^\d]/g, "");
  if (so === "") return 0;
  return (chu.includes("−") || chu.includes("-") ? -1 : 1) * Number(so);
}

test.describe("chủ shop", () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await dangNhapChuShop(page);
  });

  test("mặc định Tháng này; tab Hoàn lọc đúng; bấm lại Tháng này ⇒ tất cả thời gian", async ({ page }) => {
    await page.goto(`/don-hang?q=${MA}`);
    await expect(nhomKy(page).getByRole("button", { name: "Tháng này" })).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByTestId("the-so-don")).toBeVisible();

    await page.getByTestId("tab-hoan_hang").click();
    await expect(page).toHaveURL(/trang_thai=hoan_hang/);
    const vien = page.getByTestId("bang-don-hang").getByTestId("trang-thai-don");
    await expect(vien.first()).toBeVisible();
    const n = await vien.count();
    expect(n).toBeGreaterThan(0);
    for (let i = 0; i < n; i++) await expect(vien.nth(i)).toHaveText(/^Hoàn$/);

    await nhomKy(page).getByRole("button", { name: "Tháng này" }).click();
    await expect(page).toHaveURL(/ky=tat_ca/);
    await expect(page.getByTestId("dong-phu-don-hang")).toContainText("Tất cả thời gian");
    await expect(nhomKy(page).getByRole("button", { name: "Tháng này" })).toHaveAttribute("aria-pressed", "false");
  });

  test("chip Đơn lỗ chỉ còn đơn lỗ; sắp Lãi thấp nhất tăng dần", async ({ page }) => {
    await page.goto(`/don-hang?q=${MA}`);
    await page.getByTestId("chip-loc-lo").click();
    await expect(page).toHaveURL(/loc=lo/);
    const dong = dongBang(page);
    await expect(dong).toHaveCount(2);
    for (let i = 0; i < 2; i++) await expect(dong.nth(i)).toHaveAttribute("data-dong-lo", "true");

    await page.getByTestId("o-sap-xep").selectOption("lai_thap");
    await expect(page).toHaveURL(/sx=lai_thap/);
    const lai = page.getByTestId("bang-don-hang").getByTestId("lai-don");
    await expect(lai).toHaveCount(2);
    const a = docTien(await lai.nth(0).innerText());
    const b = docTien(await lai.nth(1).innerText());
    expect(a).toBe(-40_000);
    expect(b).toBe(-20_000);
    expect(a).toBeLessThanOrEqual(b);
  });

  test("bấm vào ô Sản phẩm mở drawer; ‹ › đổi đơn; ✕ đóng", async ({ page }) => {
    await page.goto(`/don-hang?q=${MA}`);
    // Ô thứ 4 ở 1440 = Sản phẩm (không phải mã đơn — mã đơn là link riêng).
    await dongBang(page).nth(1).locator("td").nth(3).click();
    await expect(page).toHaveURL(/don=/);
    const hop = page.getByRole("dialog");
    await expect(hop).toBeVisible();
    const donDau = new URL(page.url()).searchParams.get("don");

    await hop.getByRole("link", { name: "Đơn sau" }).click();
    await expect.poll(() => new URL(page.url()).searchParams.get("don")).not.toBe(donDau);
    await expect(hop.getByText(/^3 \/ \d+$/)).toBeVisible();

    await hop.getByRole("button", { name: "Đóng" }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    expect(new URL(page.url()).searchParams.get("don")).toBeNull();
  });

  test("số cột: 1280 ⇒ 7, 1440 ⇒ 8", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(`/don-hang?q=${MA}`);
    await expect(page.getByTestId("bang-don-hang").locator("thead th:visible")).toHaveCount(7);
    await page.setViewportSize({ width: 1440, height: 900 });
    await expect(page.getByTestId("bang-don-hang").locator("thead th:visible")).toHaveCount(8);
  });

  test("390px: không tràn ngang; sheet Lọc chỉ ghi URL khi Áp dụng", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`/don-hang?q=${MA}`);
    const tran = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(tran).toBeLessThanOrEqual(0);

    await page.getByTestId("nut-loc-sheet").click();
    const sheet = page.getByRole("dialog");
    await sheet.getByRole("button", { name: /Phí tạm tính/ }).click();
    expect(new URL(page.url()).searchParams.get("loc")).toBeNull();
    await sheet.getByTestId("ap-dung-loc").click();
    await expect(page).toHaveURL(/loc=phi_tam/);
  });

  test("Xuất Excel trả file xlsx", async ({ page }) => {
    const res = await page.request.get(`/api/export/don-hang?q=${MA}`);
    expect(res.status()).toBe(200);
    expect(res.headers()["content-type"]).toContain("spreadsheetml");
  });
});

test("người không quyền giá vốn: 1440 còn 7 cột, không cột Lãi đơn", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await dangNhapVoi(page, EMAIL_XEM, MAT_KHAU);
  await page.goto(`/don-hang?q=${MA}`);
  const tieuDe = page.getByTestId("bang-don-hang").locator("thead th:visible");
  await expect(tieuDe).toHaveCount(7);
  await expect(page.getByTestId("bang-don-hang").locator("thead")).not.toContainText("Lãi đơn");
  await expect(page.getByTestId("the-so-lai")).toHaveCount(0);
});
