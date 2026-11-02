import { expect, test } from "./fixture-cho-trang-stream-xong";

import { testPrisma } from "./ingest-raw";
import { INSET_IPHONE, KHUNG_IPHONE, dangNhap, datInset } from "./mobile-helpers";

/** Bố cục mobile đợt 2 — spec docs/superpowers/specs/2026-09-26-iphone-pwa-dot-2-design.md. */

/**
 * Tên truy cập của mục menu, chịu được huy hiệu đếm đi kèm (vd "Sản phẩm 22" khi có SKU thiếu giá
 * vốn). Huy hiệu phụ thuộc DỮ LIỆU: DB e2e mới tinh không có, DB đã chạy nhiều lượt thì có.
 */
function tenMucMenu(ten: string): RegExp {
  return new RegExp(`^${ten}(?: \\d+)?$`);
}

/** Tháng xa quá khứ, chắc chắn không có đơn/chi phí ⇒ tab Lãi/Lỗ hiện màn "Chưa có dữ liệu tháng…" kèm nút đồng bộ chữ. */
const URL_THANG_LOI_LO_TRONG = "/tai-chinh?tab=loi-lo&tu=2001-01-01&den=2001-01-31";

const TRANG_MENU: ReadonlyArray<readonly [string, string]> = [
  ["/", "Dashboard"],
  ["/don-hang", "Đơn hàng"],
  ["/san-pham", "Sản phẩm"],
  ["/ton-kho", "Tồn kho"],
  ["/tai-chinh", "Tài chính"],
  ["/kenh", "Kênh"],
  ["/marketing", "Marketing"],
  ["/cai-dat", "Cài đặt"],
];

test.describe("PageTitle", () => {
  test.describe("mobile 390", () => {
    test.use({ viewport: KHUNG_IPHONE });
    test("8 trang mục menu: tiêu đề trong nội dung ẩn, Topbar vẫn ghi tên", async ({ page }) => {
      await datInset(page, INSET_IPHONE);
      await dangNhap(page);
      for (const [url, ten] of TRANG_MENU) {
        await page.goto(url);
        await expect(page.locator('main [data-slot="page-title"]'), url).toBeHidden();
        await expect(page.locator("header h1"), url).toHaveText(ten);
      }
    });
  });

  test.describe("Sản phẩm mobile 390", () => {
    test.use({ viewport: KHUNG_IPHONE });
    test("số SKU (mất cùng tiêu đề) còn ở thẻ Tổng sản phẩm", async ({ page }) => {
      await dangNhap(page);
      await page.goto("/san-pham");
      const the = page.getByText("Tổng sản phẩm", { exact: true }).locator("xpath=..");
      await expect(the.getByText(/\d+ SKU$/)).toBeVisible();
    });

    test("bản in: KHÔNG lặp dòng SKU (PageTitle hiện lại đã có sẵn)", async ({ page }) => {
      await dangNhap(page);
      await page.goto("/san-pham");
      await page.emulateMedia({ media: "print" });
      // Bản mobile-only trong thẻ "Tổng sản phẩm" phải ẩn khi in — PageTitle (`print:flex`, Task 1)
      // đã có đúng 1 dòng "x sản phẩm · y SKU".
      const the = page.getByText("Tổng sản phẩm", { exact: true }).locator("xpath=..");
      await expect(the.getByText(/\d+ SKU$/)).toBeHidden();
      await expect(page.locator('main [data-slot="page-title"]').getByText(/\d+ SKU$/)).toBeVisible();
    });
  });

  test("máy tính 1280: tiêu đề trong nội dung hiện đủ 8 trang", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await dangNhap(page);
    for (const [url, tenMenu] of TRANG_MENU) {
      await page.goto(url);
      const tieuDe = page.locator('main [data-slot="page-title"]');
      await expect(tieuDe, url).toBeVisible();
      // Trang chủ: mục menu vẫn là "Dashboard" nhưng tiêu đề trong trang là "Tổng quan" (spec trang chủ).
      await expect(tieuDe.getByRole("heading", { level: 1 }), url).toHaveText(url === "/" ? "Tổng quan" : tenMenu);
    }
    await page.goto("/san-pham");
    // Máy tính: số SKU đã có trong dòng mô tả của tiêu đề ⇒ chú thích trong thẻ ẩn.
    await expect(page.getByText("Tổng sản phẩm", { exact: true }).locator("xpath=..").getByText(/\d+ SKU$/)).toBeHidden();
  });
});
test.describe("Nút đồng bộ", () => {
  test.use({ viewport: KHUNG_IPHONE });
  test("mobile: nút ở Topbar là icon có tên, vùng bấm ≥ 44×44; nút trong nội dung (tháng Lãi/Lỗ chưa có dữ liệu) giữ chữ", async ({
    page,
  }) => {
    await datInset(page, INSET_IPHONE);
    await dangNhap(page);
    // Trang chủ không còn thẻ "Tình trạng đồng bộ" (spec trang chủ §2) ⇒ nút CHỮ trong nội dung nay chỉ còn ở
    // màn "Chưa có dữ liệu tháng…" của tab Lãi/Lỗ. Khoanh nút Topbar vào header.
    const nut = page.locator("header").getByRole("button", { name: "Đồng bộ ngay" });
    await expect(nut).toHaveCount(1);
    await expect(nut).toBeVisible();
    const box = (await nut.boundingBox())!;
    expect(box.width).toBeGreaterThanOrEqual(44);
    expect(box.height).toBeGreaterThanOrEqual(44);
    await expect(nut).not.toContainText("Đồng bộ ngay"); // chỉ icon — tên nằm ở aria-label
    await page.goto(URL_THANG_LOI_LO_TRONG);
    await expect(page.locator("main").getByRole("button", { name: "Đồng bộ ngay" }).first()).toContainText(
      "Đồng bộ ngay",
    );
  });

  test("giảm chuyển động: icon THẬT trong nút đồng bộ Topbar mang lớp xoay có điều kiện và tắt xoay", async ({
    page,
  }) => {
    const prisma = testPrisma();
    // Seed SyncLog RUNNING ⇒ `disabled` chắc chắn true ngay lúc mount (không phụ thuộc n8n thật/độ
    // trễ mạng của `triggerSyncNow` — bấm nút rồi đợi busy là đua với worker đơn nhưng KHÔNG chắc
    // giữ được trạng thái đủ lâu để đọc computed style). Icon chỉ mang lớp xoay khi `disabled`.
    const log = await prisma.syncLog.create({ data: { kind: "PANCAKE", status: "RUNNING" } });
    try {
      await dangNhap(page);
      const icon = page.locator("header").getByRole("button", { name: "Đang đồng bộ" }).locator("svg");
      await expect(icon).toBeVisible();
      // Lớp phải là `motion-safe:animate-spin` CÓ ĐIỀU KIỆN — không phải `animate-spin` trần (luôn
      // xoay, bỏ qua "Giảm chuyển động" của hệ điều hành).
      const lop = ((await icon.getAttribute("class")) ?? "").split(/\s+/);
      expect(lop).toContain("motion-safe:animate-spin");
      expect(lop).not.toContain("animate-spin");
      await page.emulateMedia({ reducedMotion: "no-preference" });
      expect(await icon.evaluate((el) => getComputedStyle(el).animationName)).toBe("spin");
      await page.emulateMedia({ reducedMotion: "reduce" });
      expect(await icon.evaluate((el) => getComputedStyle(el).animationName)).toBe("none");
    } finally {
      await prisma.syncLog.delete({ where: { id: log.id } });
      await prisma.$disconnect();
    }
  });
});
test.describe("Thanh chọn kỳ", () => {
  test.use({ viewport: KHUNG_IPHONE });
  test("mờ mép phải khi còn cuộn, mất khi cuộn hết, không chặn chạm", async ({ page }) => {
    await dangNhap(page);
    const mo = page.locator('[data-slot="mo-cuon-phai"]');
    await expect(mo).toBeVisible();
    expect(await mo.evaluate((e) => getComputedStyle(e).pointerEvents)).toBe("none");
    await page.getByRole("group", { name: "Chọn khoảng thời gian" }).evaluate((e) => {
      e.scrollLeft = e.scrollWidth;
    });
    await expect(mo).toHaveCount(0);
  });

  test("mờ mép phải đo lại khi bề rộng phần tử đổi mà KHÔNG có resize cửa sổ (ResizeObserver)", async ({
    page,
  }) => {
    await dangNhap(page);
    const mo = page.locator('[data-slot="mo-cuon-phai"]');
    await expect(mo).toBeVisible();
    // Nới rộng TRỰC TIẾP phần tử cuộn bằng style tay — `window.innerWidth` không đổi nên KHÔNG bắn
    // sự kiện `resize` cửa sổ; chỉ `ResizeObserver` quan sát chính phần tử mới bắt được.
    await page.getByRole("group", { name: "Chọn khoảng thời gian" }).evaluate((e) => {
      (e as HTMLElement).style.width = "2000px";
    });
    await expect(mo).toHaveCount(0);
  });
});
test.describe("Bảng Lãi/Lỗ", () => {
  // Tự tạo 1 khoản chi trong THÁNG NÀY: trang Lãi/Lỗ và Sổ chi phí chỉ hiện bảng/nút Lọc khi kỳ có dữ
  // liệu. Trước đây test xanh nhờ chi phí RÁC spec khác để lại trong DB e2e — dọn rác là đỏ.
  const MO_TA_SEED = "E2E mobile-bo-cuc Lãi/Lỗ — chi phí mồi";
  test.beforeAll(async () => {
    const db = testPrisma();
    await db.expense.deleteMany({ where: { description: MO_TA_SEED } });
    await db.expense.create({ data: { date: new Date(), categoryId: "fixed", amount: 1_000_000, description: MO_TA_SEED } });
  });
  test.afterAll(async () => {
    await testPrisma().expense.deleteMany({ where: { description: MO_TA_SEED } });
  });
  // `[data-slot="table-container"]` (khung trong của <Table>) — KHÔNG `div.overflow-x-auto`: wrapper
  // ngoài cũng mang class đó ⇒ 2 phần tử, strict mode vỡ.
  const khungBang = (page: import("@playwright/test").Page) =>
    page.locator('[data-slot="table-container"]', { has: page.getByRole("columnheader", { name: /Khoản mục/ }) });

  test.describe("mobile 390", () => {
    test.use({ viewport: KHUNG_IPHONE });
    test("không tràn ngang; % và so tháng trước xuống dòng phụ có nhãn đọc màn hình", async ({ page }) => {
      await dangNhap(page);
      await page.goto("/tai-chinh?tab=loi-lo");
      const khung = khungBang(page);
      await expect(khung).toBeVisible();
      expect(await khung.evaluate((e) => e.scrollWidth <= e.clientWidth)).toBe(true);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      await expect(page.getByRole("columnheader", { name: "% / Doanh thu" })).toBeHidden();
      const phu = page.locator('[data-slot="pnl-dong-phu"]').first();
      await expect(phu).toBeVisible();
      await expect(phu).toContainText("Phần trăm doanh thu");
      await expect(phu).toContainText("So tháng trước");
    });
    test("bản in: đủ 4 cột, không dòng phụ, tiêu đề trang vẫn ẩn như cũ", async ({ page }) => {
      await dangNhap(page);
      await page.goto("/tai-chinh?tab=loi-lo");
      await page.emulateMedia({ media: "print" });
      await expect(page.getByRole("columnheader", { name: "% / Doanh thu" })).toBeVisible();
      await expect(page.getByRole("columnheader", { name: "So tháng trước" })).toBeVisible();
      await expect(page.locator('[data-slot="pnl-dong-phu"]').first()).toBeHidden();
      await expect(page.locator('main [data-slot="page-title"]')).toBeHidden();
    });
  });

  test("máy tính 1280: đủ 4 cột, không dòng phụ", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await dangNhap(page);
    await page.goto("/tai-chinh?tab=loi-lo");
    await expect(page.getByRole("columnheader", { name: "% / Doanh thu" })).toBeVisible();
    await expect(page.locator('[data-slot="pnl-dong-phu"]').first()).toBeHidden();
  });
});
test.describe("Thẻ KPI", () => {
  test.use({ viewport: KHUNG_IPHONE });
  const hop = async (l: import("@playwright/test").Locator) => (await l.boundingBox())!;

  test("Dashboard: 4 thẻ số lưới 2×2, thứ tự DOM = thứ tự nhìn", async ({ page }) => {
    await dangNhap(page);
    const the = (ten: string) => page.locator("main").getByRole("button", { name: new RegExp(`^${ten}`) });
    const [a, b, c, d] = [
      await hop(the("Doanh số")),
      await hop(the("Chi phí")),
      await hop(the("Lợi nhuận")),
      await hop(the("Đơn hợp lệ")),
    ];
    // Hàng trên: Doanh số | Chi phí; hàng dưới: Lợi nhuận | Đơn hợp lệ.
    expect(Math.abs(a.y - b.y)).toBeLessThan(2);
    expect(Math.abs(c.y - d.y)).toBeLessThan(2);
    expect(b.x).toBeGreaterThan(a.x);
    expect(d.x).toBeGreaterThan(c.x);
    expect(c.y).toBeGreaterThan(a.y + a.height - 2);
    // Hai cột đều nhau (2×2), không thẻ nào chiếm đủ hàng.
    expect(Math.abs(a.width - b.width)).toBeLessThan(2);
    expect(a.width).toBeLessThan(KHUNG_IPHONE.width * 0.6);
    // Thứ tự nhìn (trên→dưới, trái→phải) phải trùng thứ tự DOM ⇒ VoiceOver đọc đúng.
    const thuTuDom = await page.locator("main").evaluate((m) => {
      const ten = ["Doanh số", "Chi phí", "Lợi nhuận", "Đơn hợp lệ"];
      const nut = ten.map((t) => [...m.querySelectorAll("button[aria-pressed]")].find((e) => (e.textContent ?? "").trim().startsWith(t))!);
      return nut.slice(1).map((e, i) => Boolean(nut[i].compareDocumentPosition(e) & Node.DOCUMENT_POSITION_FOLLOWING));
    });
    expect(thuTuDom).toEqual([true, true, true]);
    // Điện thoại không có h1 trong nội dung nhưng vẫn phải thấy mốc của huy hiệu %: "so với <kỳ>".
    await expect(page.getByTestId("nhan-ky-so-sanh")).toBeVisible();
    await expect(page.getByTestId("nhan-ky-so-sanh")).toContainText("so với");
    // Bộ chọn kỳ nay điều khiển MỌI số trên trang — dòng chú thích cũ không còn.
    await expect(page.getByText("bộ chọn kỳ chỉ áp dụng cho biểu đồ và phân tích bên dưới")).toHaveCount(0);
  });

  test("Tồn kho: SKU | tồn cùng hàng, vốn tồn + dưới ngưỡng rộng 2 cột", async ({ page }) => {
    await dangNhap(page);
    await page.goto("/ton-kho");
    const theo = (t: string) => page.getByText(t, { exact: true }).locator("xpath=ancestor::div[contains(@class,'rounded-xl')][1]");
    const [sku, ton, von, nguong] = [
      await hop(theo("Tổng SKU")),
      await hop(theo("Tổng tồn")),
      await hop(theo("GIÁ TRỊ VỐN TỒN")),
      await hop(theo("SKU dưới ngưỡng")),
    ];
    expect(Math.abs(sku.y - ton.y)).toBeLessThan(2);
    expect(von.width).toBeGreaterThan(sku.width * 1.8);
    expect(nguong.width).toBeGreaterThan(sku.width * 1.8);
  });
});
test.describe("Thẻ SKU dài (mobile 390)", () => {
  test.use({ viewport: KHUNG_IPHONE });
  // SKU Pancake thật dài KHÔNG dấu cách (vd "AD02HAIDUONGXANHMINTMESIZES") từng đẩy thẻ Tồn kho tràn
  // ngang, nhãn "Hết hàng" văng ra ngoài mép màn (iPhone 28/09). Dữ liệu e2e mặc định không có SKU
  // như vậy nên smoke "không tràn ngang" cũ không bắt được.
  const SKU_DAI = "E2ESKUDAIKHONGDAUCACHXANHMINTMESIZELXXL";
  const PANCAKE_SP = "e2e-sku-dai-sp";

  test.beforeAll(async () => {
    const db = testPrisma();
    await db.product.deleteMany({ where: { pancakeId: PANCAKE_SP } });
    await db.product.create({
      data: {
        pancakeId: PANCAKE_SP,
        name: "[ E2E ] Áo Dài Hải Đường Chất Liệu Tơ tencel vân hoa chìm cho bé gái.",
        syncedAt: new Date(),
        variants: {
          create: {
            pancakeId: "e2e-sku-dai-bt",
            sku: SKU_DAI,
            label: "Hải Đường Xanh Mint / Mẹ Size S",
            stock: 0,
            costPrice: 240000,
            syncedAt: new Date(),
          },
        },
      },
    });
  });

  test.afterAll(async () => {
    await testPrisma().product.deleteMany({ where: { pancakeId: PANCAKE_SP } });
  });

  test("Tồn kho: trang không tràn ngang, nhãn 'Hết hàng' nằm trọn trong màn", async ({ page }) => {
    await dangNhap(page);
    await page.goto(`/ton-kho?q=${SKU_DAI}`);
    const sku = page.locator("main").getByText(SKU_DAI).last();
    await expect(sku).toBeVisible();
    const tran = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(tran).toBeLessThanOrEqual(0);
    const nhan = page.locator("main").getByText("Hết hàng", { exact: true }).last();
    const b = (await nhan.boundingBox())!;
    expect(b.x).toBeGreaterThanOrEqual(0);
    expect(b.x + b.width).toBeLessThanOrEqual(KHUNG_IPHONE.width);
  });
});

test.describe("Thanh tab dưới", () => {
  test.describe("mobile 390", () => {
    test.use({ viewport: KHUNG_IPHONE });
    test("5 tab, aria-current, chuyển trang, vùng bấm ≥ 44", async ({ page }) => {
      await datInset(page, INSET_IPHONE);
      await dangNhap(page);
      const thanh = page.getByRole("navigation", { name: "Điều hướng chính" });
      await expect(thanh).toBeVisible();
      await expect(page.getByRole("button", { name: "Mở menu điều hướng" })).toHaveCount(0);
      const tabs = thanh.locator("a, button");
      await expect(tabs).toHaveCount(5);
      for (const t of await tabs.all()) {
        const b = (await t.boundingBox())!;
        expect(b.height).toBeGreaterThanOrEqual(44);
        expect(b.width).toBeGreaterThanOrEqual(44);
      }
      await expect(thanh.getByRole("link", { name: "Dashboard" })).toHaveAttribute("aria-current", "page");
      await thanh.getByRole("link", { name: "Tài chính" }).click();
      await expect(page).toHaveURL(/\/tai-chinh/);
      await expect(thanh.getByRole("link", { name: "Tài chính" })).toHaveAttribute("aria-current", "page");
      // Tab bar TỰ đệm thanh home (fixed ⇒ không hưởng đệm body): bỏ lớp đệm inset đáy là đỏ.
      expect(await thanh.evaluate((e) => getComputedStyle(e).paddingBottom)).toBe(`${INSET_IPHONE.bottom}px`);
    });

    test("chạm tab: đổi màu NGAY dù server trả chậm; aria-current chỉ đổi khi tới nơi", async ({ page }) => {
      await dangNhap(page);
      // Làm chậm 3s đúng lượt tải trang Tồn kho khi điều hướng (RSC, không phải tải trước).
      await page.route("**/ton-kho**", async (route) => {
        const h = route.request().headers();
        if (h["rsc"] === "1" && h["next-router-prefetch"] !== "1") await new Promise((r) => setTimeout(r, 3000));
        await route.continue();
      });
      const thanh = page.getByRole("navigation", { name: "Điều hướng chính" });
      const tonKho = thanh.getByRole("link", { name: /^Tồn kho/ });
      const dashboard = thanh.getByRole("link", { name: "Dashboard" });
      await tonKho.click();
      // Trước khi server kịp trả (3s): tab chạm đã tô màu, tab cũ đã nhả màu.
      await expect(tonKho).toHaveClass(/text-primary/, { timeout: 1000 });
      await expect(dashboard).not.toHaveClass(/text-primary/, { timeout: 1000 });
      await expect(dashboard).toHaveAttribute("aria-current", "page");
      const vach = page.getByRole("progressbar", { name: "Đang chuyển trang" });
      await expect(vach).toBeVisible({ timeout: 1000 });
      await expect(page).toHaveURL(/\/ton-kho/, { timeout: 15000 });
      await expect(tonKho).toHaveAttribute("aria-current", "page");
      await expect(vach).toHaveCount(0);
    });

    test("chạm lại tab đang đứng (khác query): vạch chờ KHÔNG kẹt", async ({ page }) => {
      await dangNhap(page);
      await page.goto("/tai-chinh?tab=so-quy");
      const thanh = page.getByRole("navigation", { name: "Điều hướng chính" });
      await thanh.getByRole("link", { name: "Tài chính" }).click();
      await expect(page).toHaveURL(/\/tai-chinh$/);
      await expect(page.getByRole("progressbar", { name: "Đang chuyển trang" })).toHaveCount(0);
    });

    test("'Thêm' mở ngăn kéo chỉ có mục phụ; chọn Sản phẩm ⇒ 'Thêm' active", async ({ page }) => {
      await dangNhap(page);
      const thanh = page.getByRole("navigation", { name: "Điều hướng chính" });
      const them = thanh.getByRole("button", { name: "Thêm" });
      await expect(them).toHaveAttribute("aria-expanded", "false");
      await them.click();
      const ngan = page.getByRole("dialog");
      await expect(ngan).toBeVisible();
      for (const ten of ["Sản phẩm", "Kênh", "Marketing", "Báo cáo", "Cài đặt"]) {
        await expect(ngan.getByRole("link", { name: tenMucMenu(ten) })).toBeVisible();
      }
      for (const ten of ["Dashboard", "Tài chính", "Đơn hàng", "Tồn kho"]) {
        await expect(ngan.getByRole("link", { name: tenMucMenu(ten) })).toHaveCount(0);
      }
      await ngan.getByRole("link", { name: tenMucMenu("Sản phẩm") }).click();
      await expect(page).toHaveURL(/\/san-pham/);
      await expect(ngan).toBeHidden();
      // "Thêm" là NÚT mở ngăn kéo, không phải trang ⇒ KHÔNG aria-current (VoiceOver sẽ đọc "Thêm,
      // trang hiện tại" trong khi đang ở Sản phẩm); trạng thái mở/đóng đã có aria-expanded. Vẫn tô
      // màu nhấn để mắt thấy mình đang ở nhóm mục phụ.
      await expect(them).not.toHaveAttribute("aria-current");
      // So với token nhấn `--primary` đọc lúc chạy (không ghi cứng mã màu: token đổi theo chuẩn tương phản).
      const mauNhan = await page.evaluate(() => {
        const d = document.createElement("span");
        d.style.color = "var(--primary)";
        document.body.appendChild(d);
        const c = getComputedStyle(d).color;
        d.remove();
        return c;
      });
      expect(await them.evaluate((e) => getComputedStyle(e).color)).toBe(mauNhan);
    });

    test("dòng cuối trang không bị tab bar che", async ({ page }) => {
      await datInset(page, INSET_IPHONE);
      await dangNhap(page);
      await page.goto("/ton-kho");
      // Kiểm THẲNG bất biến, không phụ thuộc trang có đủ dài để cuộn hay không: đệm đáy của `main`
      // cộng đệm inset của `body` phải ≥ chiều cao tab bar (gồm cả đệm inset của chính nó).
      const [dayMain, dayBody, caoThanh] = await page.evaluate(() => {
        const px = (e: Element) => parseFloat(getComputedStyle(e).paddingBottom);
        const nav = document.querySelector('[data-slot="bottom-tab-bar"]') as HTMLElement;
        return [px(document.querySelector("main")!), px(document.body), nav.offsetHeight];
      });
      expect(dayMain + dayBody).toBeGreaterThanOrEqual(caoThanh);
    });
  });

  test("máy tính 1280: không tab bar, sidebar đủ 8 mục + Cài đặt", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await dangNhap(page);
    await expect(page.getByRole("navigation", { name: "Điều hướng chính" })).toBeHidden();
    const aside = page.locator("aside");
    for (const ten of ["Dashboard", "Đơn hàng", "Sản phẩm", "Tồn kho", "Tài chính", "Kênh", "Marketing", "Báo cáo", "Cài đặt"]) {
      await expect(aside.getByRole("link", { name: tenMucMenu(ten) })).toBeVisible();
    }
  });
});

const TRANG_SMOKE = ["/", "/tai-chinh?tab=loi-lo", "/don-hang", "/ton-kho"];
for (const [ten, khung, inset] of [
  ["màn nhỏ 375×667", { width: 375, height: 667 }, { top: 20, bottom: 0, left: 0, right: 0 }],
  ["xoay ngang 844×390", { width: 844, height: 390 }, { top: 0, bottom: 21, left: 47, right: 47 }],
  // Máy tính bảng / cửa sổ hẹp: có sidebar mà hàng Topbar từng ép một dòng ⇒ tràn ngang (26/09).
  ["máy tính hẹp 1024×768", { width: 1024, height: 768 }, { top: 0, bottom: 0, left: 0, right: 0 }],
] as const) {
  test.describe(`Smoke ${ten}`, () => {
    test.use({ viewport: khung });
    test("không tràn ngang trang", async ({ page }) => {
      await datInset(page, inset);
      await dangNhap(page);
      for (const url of TRANG_SMOKE) {
        await page.goto(url);
        const [rong, khungNhin] = await page.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]);
        expect(rong, url).toBeLessThanOrEqual(khungNhin);
      }
      if (khung.width >= 768) {
        // Quyết định đã chấp nhận: xoay ngang ≥ md dùng bố cục máy tính.
        await expect(page.locator("aside")).toBeVisible();
        await expect(page.getByRole("navigation", { name: "Điều hướng chính" })).toBeHidden();
      }
    });
  });
}

test.describe("Máy tính hẹp / xoay ngang (sau khi Topbar xuống dòng dưới xl)", () => {
  test("1024: nút đồng bộ trong nội dung vẫn hiện dòng trạng thái (màn tháng Lãi/Lỗ chưa có dữ liệu)", async ({ page }) => {
    await page.setViewportSize({ width: 1024, height: 768 });
    await dangNhap(page);
    await page.goto(URL_THANG_LOI_LO_TRONG);
    // Chỉ Topbar ẩn dòng "Đồng bộ lúc…" ở md–xl (hàng chật); nút trong nội dung KHÔNG được mất nó.
    await expect(page.locator("main").getByText(/^(Đồng bộ lúc|Chưa đồng bộ)/).first()).toBeVisible();
    await expect(page.locator("header").getByText(/^(Đồng bộ lúc|Chưa đồng bộ)/)).toBeHidden();
  });

  test("1024: Dashboard KHÔNG tràn ngang sau khi biểu đồ và các khối đã vẽ", async ({ page }) => {
    // Smoke "không tràn ngang" đo ngay sau goto có thể xanh giả khi phần nội dung đến muộn (client component
    // vẽ sau hydrate). Ở đây CHỜ biểu đồ theo ngày hiện rồi mới đo.
    await page.setViewportSize({ width: 1024, height: 768 });
    await dangNhap(page);
    await expect(page.getByTestId("khoi-bieu-do-theo-ngay")).toBeVisible();
    await expect(page.getByTestId("khoi-tinh-trang-don")).toBeVisible();
    const [rong, khungNhin] = await page.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]);
    expect(rong).toBeLessThanOrEqual(khungNhin);
  });

  test.describe("xoay ngang 844×390", () => {
    test.use({ viewport: { width: 844, height: 390 } });
    test("thanh chọn kỳ còn cuộn ⇒ vẫn có mép mờ", async ({ page }) => {
      await datInset(page, { top: 0, bottom: 21, left: 47, right: 47 });
      await dangNhap(page);
      const nhom = page.getByRole("group", { name: "Chọn khoảng thời gian" });
      expect(await nhom.evaluate((e) => e.scrollWidth > e.clientWidth)).toBe(true);
      await expect(page.locator('[data-slot="mo-cuon-phai"]')).toBeVisible();
    });
  });
});
