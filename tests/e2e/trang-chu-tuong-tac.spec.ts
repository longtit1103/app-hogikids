import { mkdirSync } from "node:fs";
import path from "node:path";

import { isSameMonth, subDays } from "date-fns";

import { expect, test, type Page } from "./fixture-cho-trang-stream-xong";
import { dangNhapVoi } from "./dang-nhap-voi-tai-khoan";
import { testPrisma } from "./ingest-raw";
import { dangNhap } from "./mobile-helpers";
import { taoTaiKhoanStaff } from "./tao-tai-khoan-staff";

/**
 * Trang chủ mới — TƯƠNG TÁC THẬT trên trình duyệt (bấm thẻ số đổi biểu đồ + tooltip theo thẻ đang chọn)
 * và nhánh che giá vốn. Test đơn vị chỉ soi markup tĩnh nên không bắt được lỗi "bấm thẻ mà biểu đồ/tooltip
 * không đổi" — chỉ trình duyệt thật chứng minh được.
 *
 * Dữ liệu: vài đơn Shopee COMPLETED + chi phí trong THÁNG NÀY (hôm nay và 2 ngày trước nếu còn cùng tháng),
 * ghi thẳng DB e2e; dọn ở afterAll. Kỳ mặc định của trang là "Tháng này" kẹp tới hôm nay nên điểm cuối
 * biểu đồ (hôm nay) luôn có số liệu.
 */

const TIEN_TO = "E2E-TRANGCHU-";
const MO_TA_CHI_PHI = "E2E trang chủ — chi phí mồi";
const EMAIL_NHAN_VIEN = "trang-chu-che@hogikids.test";
const MAT_KHAU = "Che-Trang-Chu-123!";

/** Thư mục lưu ảnh chụp — CHỈ ghi khi bật `CHUP_ANH_TRANG_CHU=1` (CI không ghi file). */
const THU_MUC_ANH = path.resolve(process.cwd(), "plans/261101-1411-trang-chu-moi/reports");

async function donDuLieu(): Promise<void> {
  const prisma = testPrisma();
  try {
    await prisma.order.deleteMany({ where: { pancakeId: { startsWith: TIEN_TO } } });
    await prisma.product.deleteMany({ where: { pancakeId: { startsWith: TIEN_TO } } });
    await prisma.expense.deleteMany({ where: { description: MO_TA_CHI_PHI } });
    await prisma.user.deleteMany({ where: { email: EMAIL_NHAN_VIEN } });
  } finally {
    await prisma.$disconnect();
  }
}

test.beforeAll(async () => {
  await donDuLieu();
  const prisma = testPrisma();
  try {
    const bayGio = new Date();
    const ngay = [0, 1, 2].map((n) => subDays(bayGio, n)).filter((d) => isSameMonth(d, bayGio));
    const sp = await prisma.product.create({
      data: { pancakeId: `${TIEN_TO}SP`, name: "SP trang chủ tương tác", syncedAt: bayGio },
    });
    const bienThe = await prisma.variant.create({
      data: {
        pancakeId: `${TIEN_TO}BT`,
        productId: sp.id,
        sku: `${TIEN_TO}SKU`,
        label: "Mặc định",
        sellPrice: 150_000,
        stock: 40,
        costPrice: 60_000,
        syncedAt: bayGio,
      },
    });
    for (const [i, d] of ngay.entries()) {
      await prisma.order.create({
        data: {
          pancakeId: `${TIEN_TO}DON-${i}`,
          code: `TRANGCHU-${i}`,
          channelId: "shopee",
          status: "COMPLETED",
          orderedAt: d,
          itemsTotal: 300_000 * (i + 1),
          syncedAt: bayGio,
          items: {
            create: { variantId: bienThe.id, sku: `${TIEN_TO}SKU`, productName: sp.name, quantity: 2 * (i + 1), unitPrice: 150_000 },
          },
        },
      });
      await prisma.expense.create({
        data: { date: d, categoryId: "fixed", amount: 100_000 * (i + 1), description: MO_TA_CHI_PHI },
      });
    }
    // 12 mã hết hàng (tồn 0 ≤ mọi ngưỡng) ⇒ khối Sắp hết hàng đủ 10 dòng, dài hơn vùng cuộn cố định.
    const spHet = await prisma.product.create({
      data: { pancakeId: `${TIEN_TO}SP-HET`, name: "SP hết hàng cuộn", syncedAt: bayGio },
    });
    for (let i = 0; i < 12; i++) {
      await prisma.variant.create({
        data: {
          pancakeId: `${TIEN_TO}HET-${i}`,
          productId: spHet.id,
          sku: `${TIEN_TO}HET-${i}`,
          label: `Size ${i}`,
          sellPrice: 100_000,
          stock: 0,
          costPrice: 40_000,
          syncedAt: bayGio,
        },
      });
    }
    await taoTaiKhoanStaff(prisma, { email: EMAIL_NHAN_VIEN, matKhau: MAT_KHAU, quyen: ["tong-quan:xem"] });
  } finally {
    await prisma.$disconnect();
  }
});

test.afterAll(donDuLieu);

const nutThe = (page: Page, ten: string) => page.getByRole("button", { name: new RegExp(`^${ten}`) });

/** Rê chuột vào sát mép phải vùng biểu đồ ⇒ điểm cuối (hôm nay) — điểm chắc chắn có dữ liệu. */
async function reChuotDiemCuoi(page: Page): Promise<void> {
  const vung = page.getByTestId("bieu-do-theo-ngay");
  await expect(vung).toBeVisible();
  const hop = (await vung.boundingBox())!;
  await page.mouse.move(hop.x + 10, hop.y + hop.height / 2); // ra ngoài trước để tooltip dựng lại sạch
  await page.mouse.move(hop.x + hop.width - 18, hop.y + hop.height / 2, { steps: 6 });
}

test.describe("chủ shop — bấm thẻ đổi biểu đồ và tooltip", () => {
  const CA: ReadonlyArray<{ ten: string; giaTri: RegExp }> = [
    { ten: "Doanh số", giaTri: /₫/ },
    { ten: "Chi phí", giaTri: /₫/ },
    { ten: "Lợi nhuận", giaTri: /₫/ },
    { ten: "Đơn hợp lệ", giaTri: /\d+ đơn/ },
  ];

  test("mỗi thẻ: tiêu đề biểu đồ, aria-pressed và tooltip đúng chỉ số", async ({ page }) => {
    await dangNhap(page);
    for (const the of CA) await expect(nutThe(page, the.ten)).toBeVisible();

    for (const { ten, giaTri } of CA) {
      await nutThe(page, ten).click();
      await expect(page.getByTestId("tieu-de-bieu-do")).toHaveText(`${ten} theo ngày`);
      for (const khac of CA) {
        await expect(nutThe(page, khac.ten)).toHaveAttribute("aria-pressed", khac.ten === ten ? "true" : "false");
      }

      await reChuotDiemCuoi(page);
      const tooltip = page.getByTestId("tooltip-bieu-do");
      await expect(tooltip).toBeVisible();
      await expect(tooltip).toContainText(`${ten} kỳ này`);
      await expect(tooltip).toContainText(giaTri);
    }
  });
});

test.describe("chữ tiêu đề không chân (spec trang chủ §6)", () => {
  test("h1 Tổng quan và tiêu đề khối Tình trạng đơn dùng font-sans của app, không phải serif", async ({ page }) => {
    await page.setViewportSize({ width: 1400, height: 900 });
    await dangNhap(page);
    const h1 = page.getByRole("heading", { level: 1, name: "Tổng quan" });
    const h2 = page.getByTestId("khoi-tinh-trang-don").getByRole("heading", { level: 2, name: "Tình trạng đơn" });
    await expect(h1).toBeVisible();
    await expect(h2).toBeVisible();

    const hoChu = (el: import("@playwright/test").Locator) => el.evaluate((e) => getComputedStyle(e).fontFamily);
    // Mốc so: font-sans THẬT và font-serif THẬT của app — phần tử thử mang đúng class tiện ích `font-sans` / `font-serif`
    // (lấy từ `html`/`body` không được: ở Playwright chúng ra "Times" vì font gốc chưa áp tới thẻ đó).
    const hoChuMau = (lop: string) =>
      page.evaluate((l) => {
        const t = document.createElement("div");
        t.className = l;
        document.body.appendChild(t);
        const f = getComputedStyle(t).fontFamily;
        t.remove();
        return f;
      }, lop);
    const sans = await hoChuMau("font-sans");
    const serif = await hoChuMau("font-serif");
    expect(serif, "mốc serif phải khác mốc sans, nếu không phép so vô nghĩa").not.toBe(sans);

    for (const [ten, el] of [["h1 Tổng quan", h1], ["h2 Tình trạng đơn", h2]] as const) {
      const f = await hoChu(el);
      expect(f, `${ten} không được dùng font-serif`).not.toBe(serif);
      expect(f, `${ten} phải dùng font-sans của app`).toBe(sans);
      expect(f.split(",")[0].toLowerCase(), ten).not.toMatch(/garamond|serif/);
    }
  });
});

test.describe("nhân viên thiếu quyền giá vốn — nhánh che", () => {
  test("chỉ 2 thẻ Doanh số, Đơn hợp lệ; không khối tiền đi đâu / lãi nhiều", async ({ page }) => {
    await dangNhapVoi(page, EMAIL_NHAN_VIEN, MAT_KHAU);
    await expect(page).toHaveURL("/");

    await expect(nutThe(page, "Doanh số")).toBeVisible();
    await expect(nutThe(page, "Đơn hợp lệ")).toBeVisible();
    await expect(page.getByRole("button", { name: /^Chi phí|^Lợi nhuận/ })).toHaveCount(0);
    await expect(page.getByText("Tiền bán hàng đi đâu")).toHaveCount(0);
    await expect(page.getByText("Lãi nhiều – nên đẩy")).toHaveCount(0);

    await nutThe(page, "Đơn hợp lệ").click();
    await expect(page.getByTestId("tieu-de-bieu-do")).toHaveText("Đơn hợp lệ theo ngày");
    await reChuotDiemCuoi(page);
    await expect(page.getByTestId("tooltip-bieu-do")).toContainText("Đơn hợp lệ kỳ này");
  });
});

test("máy tính: các khối cùng một hàng cao bằng nhau, đáy thẳng hàng", async ({ page }) => {
  // Chủ shop chốt 01/11: khối cạnh nhau lệch chiều cao nhìn lộn xộn. Ô lưới tự giãn theo khối cao nhất
  // hàng; thẻ trắng PHẢI giãn theo (`TheKhoi` h-full) — nếu không, viền thẻ thấp hơn kết thúc giữa chừng.
  await page.setViewportSize({ width: 1400, height: 900 });
  await dangNhap(page);
  await expect(page.getByTestId("khoi-tinh-trang-don")).toBeVisible();

  const hang = [
    ["khoi-bieu-do-theo-ngay", "khoi-tinh-trang-don"],
    ["khoi-tien-di-dau", "khoi-theo-kenh"],
    ["khoi-ban-chay", "khoi-lai-nhieu-nen-day", "khoi-sap-het-hang"],
  ];
  for (const ids of hang) {
    const hop = await Promise.all(ids.map((id) => page.getByTestId(id).boundingBox()));
    const caoNhat = Math.max(...hop.map((h) => h?.height ?? 0));
    for (const [i, h] of hop.entries()) {
      expect(h, `${ids[i]} phải hiện`).not.toBeNull();
      // Cùng hàng ⇒ cùng đỉnh và cùng chiều cao (sai số 1px do làm tròn subpixel).
      expect(Math.abs(h!.y - hop[0]!.y), `${ids[i]} lệch đỉnh với ${ids[0]}`).toBeLessThanOrEqual(1);
      expect(Math.abs(h!.height - caoNhat), `${ids[i]} thấp hơn khối cao nhất hàng`).toBeLessThanOrEqual(1);
    }
  }
});

test("khối dưới cao cố định: danh sách dài cuộn trong khối, chú thích vẫn hiện", async ({ page }) => {
  // Chủ shop chốt 02/11: Bán chạy / Lãi nhiều / Sắp hết hàng dài bất thường ⇒ cố định chiều cao, cuộn bên trong.
  await page.setViewportSize({ width: 1400, height: 900 });
  await dangNhap(page);
  const ds = page.getByTestId("danh-sach-sap-het");
  await expect(ds).toBeVisible();
  const kt = await ds.evaluate((el) => ({ cao: el.clientHeight, noiDung: el.scrollHeight, tran: getComputedStyle(el).overflowY }));
  expect(kt.cao, "vùng danh sách không cao quá 300px").toBeLessThanOrEqual(300);
  expect(kt.noiDung, "10 dòng phải dài hơn vùng hiển thị (có gì để cuộn)").toBeGreaterThan(kt.cao);
  expect(kt.tran).toBe("auto");
  await expect(ds.getByRole("listitem")).toHaveCount(10);

  // Đưa khối vào màn trước (toBeInViewport đo theo khung nhìn TRANG, có tính phần bị vùng cuộn cắt), rồi cuộn
  // trong khối tới đáy ⇒ dòng cuối từ bị cắt khuất chuyển thành lọt vào khung nhìn.
  await ds.scrollIntoViewIfNeeded();
  const dongCuoi = ds.getByRole("listitem").last();
  await expect(dongCuoi).not.toBeInViewport();
  await ds.evaluate((el) => el.scrollTo({ top: el.scrollHeight }));
  await expect(dongCuoi).toBeInViewport();

  // Chú thích nằm ngoài vùng cuộn ⇒ luôn hiện.
  await expect(page.getByTestId("khoi-lai-nhieu-nen-day").getByText(/Lãi tính trước phí sàn/)).toBeVisible();
});

test("nhắc việc vàng: một dải gọn, KHÔNG bám theo khi cuộn trang", async ({ page }) => {
  // Chủ shop chốt 02/11: hộp vàng 2 dòng sticky che nội dung khi cuộn ⇒ dải gọn, mỗi việc một dòng, trôi theo trang.
  await page.setViewportSize({ width: 1400, height: 900 });
  await dangNhap(page);
  const dai = page.getByTestId("dai-nhac-viec");
  await expect(dai).toBeVisible();
  const soDong = await dai.locator(":scope > *").count();
  expect(soDong).toBeGreaterThan(0);
  for (let i = 0; i < soDong; i++) {
    const hop = (await dai.locator(":scope > *").nth(i).boundingBox())!;
    expect(hop.height, `dòng nhắc việc ${i} phải gọn (≤ 40px)`).toBeLessThanOrEqual(40);
  }
  expect(await dai.evaluate((el) => getComputedStyle(el).position)).not.toBe("sticky");

  // Cuộn TRANG xuống khối cuối (không dùng mouse.wheel: chuột ở (0,0) nằm trên thanh bên, cuộn nhầm vùng).
  await page.getByTestId("khoi-ban-chay").scrollIntoViewIfNeeded();
  await expect(page.getByTestId("khoi-ban-chay")).toBeInViewport();
  await expect(dai).not.toBeInViewport();
});

test.describe("ảnh chụp trang chủ (chỉ khi CHUP_ANH_TRANG_CHU=1)", () => {
  test.skip(process.env.CHUP_ANH_TRANG_CHU !== "1", "bật CHUP_ANH_TRANG_CHU=1 để chụp ảnh vào plans/…/reports");

  for (const [ten, rong, cao] of [
    ["trang-chu-1400.png", 1400, 900],
    ["trang-chu-390.png", 390, 844],
  ] as const) {
    test(`chụp ${ten}`, async ({ page }) => {
      mkdirSync(THU_MUC_ANH, { recursive: true });
      await page.setViewportSize({ width: rong, height: cao });
      await dangNhap(page);
      await expect(page.getByTestId("bieu-do-theo-ngay")).toBeVisible();
      await expect(page.getByTestId("khoi-tinh-trang-don")).toBeVisible();
      await page.screenshot({ path: path.join(THU_MUC_ANH, ten), fullPage: true });
    });
  }
});
