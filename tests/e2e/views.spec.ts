import { readFileSync } from "node:fs";
import path from "node:path";

import { expect, test, type Page } from "@playwright/test";
import * as XLSX from "xlsx";

import { ingestPancake, resetRawPancake, testPrisma } from "./ingest-raw";
import { TEST_USER_EMAIL, TEST_USER_PASSWORD } from "./test-constants";

/**
 * E2E các view Phase 3 (Sản phẩm/Tồn kho/Đơn hàng). beforeAll ingest fixture thật qua
 * chính luồng /api/ingest/raw (Bronze → Silver, không seed tay) — Task 4 viết case Sản phẩm,
 * Task 6 bổ sung case Tồn kho + Đơn hàng.
 */

const fixture = (name: string) =>
  JSON.parse(readFileSync(path.resolve(process.cwd(), "tests/fixtures/pancake", name), "utf8")) as unknown[];

test.beforeAll(async () => {
  // Xoá Bronze trước: raw sót lại từ lần chạy trước sẽ dedupe → không transform → Silver rỗng.
  await resetRawPancake();
  await ingestPancake({ products: fixture("products-sample.json"), orders: fixture("orders-sample.json") });
});

async function login(page: Page): Promise<void> {
  await page.goto("/dang-nhap");
  await page.getByLabel("Email").fill(TEST_USER_EMAIL);
  await page.getByLabel("Mật khẩu", { exact: true }).fill(TEST_USER_PASSWORD);
  await page.getByRole("button", { name: "Đăng nhập" }).click();
  await expect(page).toHaveURL("/");
}

test.describe("Sản phẩm — giá vốn (gộp theo sản phẩm)", () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
    await page.goto("/san-pham");
  });

  test("áp giá vốn cấp sản phẩm → mọi biến thể đổi + reload còn giá trị", async ({ page }) => {
    // "Sản phẩm mẫu 1" có 5 biến thể đang cùng giá 100.000 → áp giá mới bung confirm ghi đè hàng loạt.
    page.on("dialog", (d) => d.accept());
    const row = page.getByTestId("product-row").filter({ hasText: "Sản phẩm mẫu 1" }).first();
    await row.getByTestId("gia-von-sp").click();
    const input = row.getByTestId("gia-von-sp");
    await input.fill("123456");
    await input.press("Enter");
    await expect(row.getByTestId("gia-von-sp")).toContainText("123.456");

    await page.reload();
    const reloaded = page.getByTestId("product-row").filter({ hasText: "Sản phẩm mẫu 1" }).first();
    await expect(reloaded.getByTestId("gia-von-sp")).toContainText("123.456");

    // Mở rộng → biến thể kế thừa giá vốn mới
    await reloaded.getByRole("button", { name: "Xem biến thể" }).click();
    await expect(
      page.getByTestId("variant-row").filter({ hasText: "SB0190" }).getByTestId("gia-von"),
    ).toContainText("123.456");
  });

  test("mở rộng sửa giá vốn RIÊNG 1 biến thể → reload còn", async ({ page }) => {
    const row = page.getByTestId("product-row").filter({ hasText: "Sản phẩm mẫu 1" }).first();
    await row.getByRole("button", { name: "Xem biến thể" }).click();
    const variantRow = page.getByTestId("variant-row").filter({ hasText: "SB01130" });
    await variantRow.getByTestId("gia-von").click();
    const input = variantRow.getByTestId("gia-von");
    await input.fill("77777");
    await input.press("Enter");
    await expect(variantRow.getByTestId("gia-von")).toContainText("77.777");

    await page.reload();
    const reRow = page.getByTestId("product-row").filter({ hasText: "Sản phẩm mẫu 1" }).first();
    await reRow.getByRole("button", { name: "Xem biến thể" }).click();
    await expect(
      page.getByTestId("variant-row").filter({ hasText: "SB01130" }).getByTestId("gia-von"),
    ).toContainText("77.777");
  });

  test('"?loc=thieu_gia_von" chỉ hiện sản phẩm còn thiếu giá vốn', async ({ page }) => {
    await page.goto("/san-pham?loc=thieu_gia_von");
    const rows = page.getByTestId("product-row");
    const count = await rows.count();
    expect(count).toBeGreaterThan(0);
    for (let i = 0; i < count; i++) {
      // Thiếu giá vốn: ô cấp SP là placeholder "Nhập giá vốn" (mọi biến thể 0) hoặc "Nhiều mức"
      // (một số biến thể đã có giá) — không phải một mức tiền cụ thể.
      await expect(rows.nth(i).getByTestId("gia-von-sp")).toHaveText(/Nhập giá vốn|Nhiều mức/);
    }
  });

  test('"?loc=da_ban_thieu_gia_von" rỗng → chúc mừng ĐÚNG việc, KHÔNG xui đi đồng bộ', async ({
    page,
  }) => {
    // Rỗng ở bộ lọc này là ĐÍCH CẦN ĐẠT (nhập xong giá vốn cho mọi SKU đã bán). Trước khi có nhánh
    // riêng, màn rơi xuống câu chốt "Chưa có sản phẩm — chờ đồng bộ Pancake" — sai sự thật (kho vẫn
    // đủ SKU) và xui người dùng đi đồng bộ ngay sau khi họ vừa làm xong việc cần làm.
    // Seed e2e không có đơn hàng nào ⇒ tập "đã bán" rỗng, đúng cảnh cần chốt.
    await page.goto("/san-pham?loc=da_ban_thieu_gia_von");

    await expect(page.getByText(/Mọi SKU đã bán đều đã có giá vốn/)).toBeVisible();
    await expect(page.getByText(/Chưa có sản phẩm/)).toHaveCount(0);
    await expect(page.getByRole("link", { name: "Xem cả kho" })).toBeVisible();
  });

  test("import file 3 SKU → toast + biến thể đổi giá vốn", async ({ page }) => {
    const wsData = [
      ["SKU", "Giá vốn", "Ngưỡng"],
      ["SB01100", "111000", ""],
      ["SB01110", "222000", "8"],
      ["SB01120", "333000", ""],
    ];
    const ws = XLSX.utils.aoa_to_sheet(wsData);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Sheet1");
    const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;

    await page.getByRole("button", { name: "Import giá vốn Excel" }).click();
    await page.locator('input[type="file"]').setInputFiles({
      name: "import-test.xlsx",
      mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      buffer: buf,
    });

    await expect(page.getByText("Bước 2/3")).toBeVisible();
    await page.getByRole("button", { name: "Tiếp tục" }).click();

    await expect(page.getByText("Bước 3/3")).toBeVisible();
    await expect(page.getByText(/Cập nhật 3 biến thể/)).toBeVisible();
    await page.getByRole("button", { name: "Áp giá vốn" }).click();

    await expect(page.getByText(/Đã cập nhật giá vốn 3 biến thể/)).toBeVisible();

    // Mở rộng sản phẩm chứa SB01100 → biến thể hiện giá vốn mới.
    await page.goto("/san-pham?q=SB01100");
    await page.getByTestId("product-row").first().getByRole("button", { name: "Xem biến thể" }).click();
    await expect(
      page.getByTestId("variant-row").filter({ hasText: "SB01100" }).getByTestId("gia-von"),
    ).toContainText("111.000");
  });
});

test.describe("Tồn kho", () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
    await page.goto("/ton-kho");
  });

  test('"?loc=sap_het" chỉ hiện SKU sắp hết/hết hàng', async ({ page }) => {
    await page.goto("/ton-kho?loc=sap_het");
    const rows = page.locator("tbody tr");
    const count = await rows.count();
    expect(count).toBeGreaterThan(0);
    for (let i = 0; i < count; i++) {
      await expect(rows.nth(i)).toContainText(/Sắp hết|Hết hàng/);
    }
  });

  test("bấm header Tồn → URL đổi sang sắp xếp theo tồn", async ({ page }) => {
    await page.getByRole("link", { name: "Tồn", exact: true }).click();
    await expect(page).toHaveURL(/sap_xep=ton/);
  });

  test("Xuất CSV trả về file CSV có BOM UTF-8 + header đúng cột", async ({ page }) => {
    const res = await page.request.get("/api/export/ton-kho");
    expect(res.ok()).toBe(true);
    const text = await res.text();
    expect(text.startsWith("﻿sku,ten_san_pham,bien_the,ton,nguong,gia_von,gia_tri_von")).toBe(true);
  });
});

test.describe("Đơn hàng", () => {
  // Order/SKU riêng (không trùng orders-sample/products-sample) để đảm bảo item resolve
  // được Variant thật — cần cho case "sửa giá vốn → drawer đổi lãi".
  test.beforeAll(async () => {
    await ingestPancake({
      products: [
        {
          id: "E2E-DRAWER-P1",
          name: "SP Drawer Test",
          variations: [
            {
              id: "E2E-DRAWER-V1",
              display_id: "E2E-DRAWER-SKU",
              retail_price: 100000,
              remain_quantity: 10,
              average_imported_price: 40000,
            },
          ],
        },
      ],
      orders: [
        {
          id: "E2E-DRAWER-01",
          status: 3,
          inserted_at: "2026-07-01T10:00:00.000000",
          order_sources_name: "Shopee",
          marketplace_id: "-3",
          total_price: 200000,
          total_discount: 0,
          fee_marketplace: 15000,
          items: [
            {
              quantity: 2,
              discount_each_product: 20000, // giảm giá MỖI ĐƠN VỊ → dòng giảm 2×20.000 = 40.000
              variation_info: { display_id: "E2E-DRAWER-SKU", name: "SP Drawer Test", retail_price: 100000 },
            },
          ],
        },
        // Đơn có `system_id` KHÁC `id` — để test cột "Mã sàn" không mù: mã Pancake (998877)
        // và mã sàn (id, = mã đơn Shopee) phải là HAI chuỗi khác nhau trên cùng một dòng.
        {
          id: "260800E2EMASAN1",
          system_id: 998877,
          status: 3,
          inserted_at: "2026-07-01T11:00:00.000000",
          order_sources_name: "Shopee",
          marketplace_id: "-3",
          total_price: 50000,
          total_discount: 0,
          fee_marketplace: 5000,
          items: [
            {
              quantity: 1,
              variation_info: { display_id: "E2E-DRAWER-SKU", name: "SP Drawer Test", retail_price: 50000 },
            },
          ],
        },
      ],
    });
  });

  test.beforeEach(async ({ page }) => {
    await login(page);
  });

  test("banner hiển thị thời điểm đồng bộ sau khi ingest", async ({ page }) => {
    await page.goto("/don-hang");
    await expect(page.getByText(/Đồng bộ Pancake lúc/)).toBeVisible();
  });

  /**
   * Cột "Mã sàn" + tìm theo mã sàn. Đi qua `?q=` trên URL (không gõ ô tìm) để né debounce.
   * Neo dòng theo mã Pancake (998877) rồi khẳng định mã sàn ĐẦY ĐỦ xuất hiện cùng dòng —
   * hai chuỗi khác hẳn nhau nên phép kiểm không thể xanh nhờ trùng cột (bài học e2e mù 22/08).
   */
  test('cột "Mã sàn" hiện mã đơn bên sàn, tìm được bằng mã sàn', async ({ page }) => {
    await page.goto("/don-hang?q=260800E2EMASAN1");
    await expect(page.getByRole("columnheader", { name: "Mã sàn" })).toBeVisible();
    const row = page.locator("tbody tr").filter({ hasText: "998877" });
    await expect(row).toHaveCount(1);
    await expect(row).toContainText("260800E2EMASAN1");
  });

  test('"?trang_thai=hoan_hang,huy_bom" chỉ hiện 2 trạng thái', async ({ page }) => {
    await page.goto("/don-hang?trang_thai=hoan_hang,huy_bom");
    const rows = page.locator("tbody tr");
    const count = await rows.count();
    expect(count).toBeGreaterThan(0);
    for (let i = 0; i < count; i++) {
      await expect(rows.nth(i)).toContainText(/Hoàn hàng|Hủy\/Bom/);
    }
  });

  /**
   * Bài dưới GHI vào DB e2e (sửa giá vốn 40.000 → 60.000) trong khi chính nó mở đầu bằng khẳng định
   * "lãi = 65.000" (ứng 40.000). DB e2e SỐNG QUA NHIỀU LƯỢT CHẠY, nên nếu chỉ trả lại ở cuối thân
   * bài thì hỏng giữa chừng (hoặc retry của Playwright) sẽ để lại 60.000 và MỌI lượt sau đỏ ngay
   * dòng đầu — triệu chứng trỏ thẳng vào "công thức lãi sai", đi truy nhầm hướng rất lâu.
   * Vì vậy ép baseline TRƯỚC và dọn SAU bằng hook: hook chạy kể cả khi thân bài ném giữa chừng.
   */
  const datGiaVonDrawer = async (gia: number): Promise<void> => {
    // Ghi THẲNG DB, không qua UI: baseline/cleanup phải chạy được cả khi màn hình đang hỏng.
    const prisma = testPrisma();
    try {
      await prisma.variant.updateMany({ where: { sku: "E2E-DRAWER-SKU" }, data: { costPrice: gia } });
    } finally {
      await prisma.$disconnect();
    }
  };
  test.beforeEach(async () => {
    await datGiaVonDrawer(40_000);
  });
  test.afterEach(async () => {
    await datGiaVonDrawer(40_000);
  });

  test("click đơn → drawer hiện lãi khớp công thức; sửa giá vốn → lãi đổi", async ({ page }) => {
    await page.goto("/don-hang");
    await page.getByRole("link", { name: "E2E-DRAWER-01" }).click();

    // itemsTotal = 200.000 − giảm giá dòng (2×20.000) = 160.000; − fee 15.000 − cogs (2×40.000) = 65.000
    await expect(page.getByText("65.000 ₫")).toBeVisible();
    // Lãi gộp dòng RÒNG = 200.000 − 40.000(giảm giá dòng) − 80.000(cogs) = 80.000 (khớp cơ sở itemsTotal)
    await expect(page.getByTestId("line-profit")).toHaveText("80.000 ₫");

    // Đóng drawer, sửa giá vốn ở /san-pham, mở lại → lãi đổi (COGS hiện hành, không snapshot).
    // "SP Drawer Test" 1 biến thể → áp cấp sản phẩm không bung confirm.
    await page.keyboard.press("Escape");
    await page.goto("/san-pham?q=E2E-DRAWER-SKU");
    const prodRow = page.getByTestId("product-row").filter({ hasText: "SP Drawer Test" }).first();
    await prodRow.getByTestId("gia-von-sp").click();
    const input = prodRow.getByTestId("gia-von-sp");
    await input.fill("60000");
    await input.press("Enter");
    await expect(prodRow.getByTestId("gia-von-sp")).toContainText("60.000");

    await page.goto("/don-hang");
    await page.getByRole("link", { name: "E2E-DRAWER-01" }).click();
    // cogs mới = 2×60.000=120.000 → lãi = 160.000−0−15.000−120.000 = 25.000
    await expect(page.getByText("25.000 ₫")).toBeVisible();

  });

  /**
   * Cây khoản mục "Lãi đơn" (Task cây drawer) — bảng gọn nhờ bung/thu theo nhóm +
   * chú thích nằm sau dấu "?", giống hệt quy ước bảng Lãi/Lỗ (`pnl-tab.tsx`).
   *
   * Bẫy tooltip: Playwright tự rê chuột tới phần tử TRƯỚC khi bấm — nếu khẳng định
   * "chưa mở" ngay từ đầu bài test (trước mọi thao tác chuột khác) thì phép kiểm
   * không chứng minh được gì, phải khẳng định NGAY TRƯỚC lúc rê chuột thật. Và chú
   * thích bản in luôn nằm sẵn trong DOM (chỉ ẩn bằng CSS `print:inline`) nên đếm
   * theo TEXT sẽ khớp cả bản ẩn — phải neo vào popup thật `[data-slot="popover-content"]`.
   */
  test('drawer chi tiết đơn — dòng "Lãi đơn", bung/thu gọn nhóm, dấu "?" chỉ mở khi rê chuột', async ({ page }) => {
    await page.goto("/don-hang");
    await page.getByRole("link", { name: "E2E-DRAWER-01" }).click();

    await expect(page.getByText("Lãi đơn", { exact: true })).toBeVisible();

    // Nhóm "Doanh thu đơn" mặc định BUNG HẾT — dòng con "Giá niêm yết" đang hiện.
    const listPrice = page.getByText("Giá niêm yết", { exact: true });
    await expect(listPrice).toBeVisible();

    // Thu gọn nhóm (mũi tên đổi tên/hướng) → dòng con biến mất; bung lại → hiện lại.
    await page.getByRole("button", { name: "Thu gọn chi tiết Doanh thu đơn", exact: true }).click();
    await expect(listPrice).not.toBeVisible();
    await page.getByRole("button", { name: "Xem chi tiết Doanh thu đơn", exact: true }).click();
    await expect(listPrice).toBeVisible();

    // Dấu "?" cạnh "Doanh thu đơn": popup CHƯA CÓ trong DOM (không chỉ ẩn) trước
    // khi rê chuột thật.
    const nut = page.getByRole("button", { name: /^Giải thích: Doanh thu đơn$/ });
    const popup = page.locator('[data-slot="popover-content"]', { hasText: /Tiền hàng của đơn này/ });
    await expect(nut).toBeVisible();
    await expect(popup).toHaveCount(0);

    await nut.hover();
    await expect(popup).toBeVisible();
  });
});
