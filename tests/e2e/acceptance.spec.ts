import { expect, test, type Page } from "@playwright/test";
import { format } from "date-fns";

import { ingestPancake, resetRawPancake, type IngestInput } from "./ingest-raw";
import { TEST_USER_EMAIL, TEST_USER_PASSWORD } from "./test-constants";

/**
 * Phase 6 acceptance e2e — 3 tiêu chí chấp nhận của plan.md (AC1/AC2/AC4).
 *
 * Test DB TÍCH LŨY dữ liệu qua nhiều lần chạy suite (chỉ User bị reset ở
 * `global-setup.ts`) — số P&L tháng này KHÔNG cô lập theo file. Thay vì assert
 * số tuyệt đối (dễ vỡ khi chạy chung `chi-phi.spec.ts`/`dashboard-bao-cao-kenh.spec.ts`),
 * mỗi test đọc số NGAY TRƯỚC khi seed (baseline), rồi assert ĐỘ LỆCH sau khi
 * seed khớp CHÍNH XÁC số hand-compute từ fixture của chính nó — vẫn là assert
 * "số chính xác" theo công thức `pnl.ts` (cộng dồn tuyến tính theo đơn/khoản
 * chi), chỉ khác là chính xác trên PHẦN ĐÓNG GÓP của fixture thay vì tổng toàn
 * DB. Chạy SERIAL trong file này (`mode: "serial"`) vì AC2/AC4 dùng chung 1
 * bucket "tháng này" — chạy song song sẽ đọc chéo baseline của nhau.
 */
test.describe.configure({ mode: "serial" });

const TODAY = format(new Date(), "yyyy-MM-dd");

async function login(page: Page): Promise<void> {
  await page.goto("/dang-nhap");
  await page.getByLabel("Email").fill(TEST_USER_EMAIL);
  await page.getByLabel("Mật khẩu", { exact: true }).fill(TEST_USER_PASSWORD);
  await page.getByRole("button", { name: "Đăng nhập" }).click();
  await expect(page).toHaveURL("/");
}

/** Seed qua luồng Bronze thật: products (shop kho) rồi orders (shop bán). */
async function postIngest(data: IngestInput): Promise<void> {
  await ingestPancake(data);
}

/** "−35.000 ₫" → -35000; "480.000 ₫" → 480000. Đảo ngược `formatVnd()` (U+2212 MINUS SIGN). */
function parseVndText(text: string): number {
  const negative = text.includes("−");
  const digits = text.replace(/[^\d]/g, "");
  const n = digits === "" ? 0 : Number(digits);
  return negative ? -n : n;
}

/**
 * Đọc "Số tiền" (cột 2) của 1 dòng bảng P&L theo nhãn (vd "Doanh thu gộp", "COGS").
 * Tháng trống (chưa từng có đơn/chi phí nào) → PnlTab hiện empty-state thay vì
 * bảng — trả 0 cho mọi nhãn (baseline hợp lệ cho lần chạy đầu trên DB sạch).
 *
 * Ô nhãn (td đầu) có thể mang tiền tố "− "/"= " (quy ước `pnl-tab.tsx`
 * `displayValue()`) NÊN match theo regex neo `^...$` — nhưng phải neo trên
 * PHẦN TỬ Link/span chứa đúng `prefix+label` (phần tử con nhỏ nhất), KHÔNG
 * phải cả `<td>`: dòng "LN ròng" còn có Badge "tạm tính" nằm cùng ô (sibling),
 * dòng "COGS" còn có icon cảnh báo — neo cuối chuỗi trên CẢ Ô sẽ không bao
 * giờ khớp vì dính thêm text đó. `getByText` với regex neo chỉ khớp phần tử
 * có text NGUYÊN VẸN đúng chuỗi nên tự chọn đúng Link/span lá thay vì
 * `<td>`/`<tr>` cha. Cách này cũng tách "Phí sàn" khỏi "Phí sàn đơn hoàn/hủy"
 * (label dài hơn, cùng tiền tố) — substring match (`hasText` cả dòng) kiểu cũ
 * chỉ PASS nhờ `.first()` bắt đúng thứ tự DOM, mong manh khi thêm dòng mới.
 */
async function readPnlAmount(page: Page, label: string): Promise<number> {
  if ((await page.getByText(/Chưa có dữ liệu tháng/).count()) > 0) return 0;
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const labelEl = page.getByText(new RegExp(`^(?:− |= )?${escaped}$`));
  const row = page.locator("table tbody tr").filter({ has: labelEl }).first();
  const amountText = await row.locator("td").nth(1).textContent();
  return parseVndText(amountText ?? "");
}

/** Chọn 1 mục trong base-ui Select đang hiển thị trong dialog (trigger hiện `placeholder`) — khớp chi-phi.spec.ts. */
async function pickSelectOption(page: Page, placeholder: string, optionName: string): Promise<void> {
  await page.getByText(placeholder, { exact: true }).click();
  await page.getByRole("option", { name: optionName, exact: true }).click();
}

test.describe("Acceptance", () => {
  // Bronze dedupe theo hash payload: raw sót từ lần chạy trước ⇒ land 0 ⇒ transform không chạy.
  test.beforeAll(async () => {
    await resetRawPancake();
  });

  test.beforeEach(async ({ page }) => {
    await login(page);
  });

  test("AC1 — ingest idempotent theo pancakeId: POST trùng không nhân đôi đơn", async ({ page }) => {
    const stamp = Date.now();
    const orderId = `AC1-ORD-${stamp}`;
    const sku = `AC1-SKU-${stamp}`;

    const payload = {
      products: [
        {
          id: `AC1-P-${stamp}`,
          name: "AC1 Product",
          variations: [
            {
              id: `AC1-V-${stamp}`,
              display_id: sku,
              retail_price: 100000,
              remain_quantity: 20,
              average_imported_price: 40000,
            },
          ],
        },
      ],
      orders: [
        {
          id: orderId,
          status: 3, // delivered → COMPLETED
          inserted_at: `${TODAY}T09:00:00.000000`,
          order_sources_name: "Shopee",
          marketplace_id: "-3",
          total_price: 100000,
          total_discount: 0,
          fee_marketplace: 5000,
          items: [
            {
              quantity: 1,
              discount_each_product: 0,
              variation_info: { display_id: sku, name: "AC1 Product", retail_price: 100000 },
            },
          ],
        },
      ],
    };

    await postIngest(payload);
    await page.goto(`/don-hang?q=${orderId}`);
    await expect(page.locator("tbody tr").filter({ hasText: orderId })).toHaveCount(1);

    // POST Y NGUYÊN payload lần 2 — Bronze dedupe theo (shop, id, hash) + Silver upsert theo
    // `pancakeId` (= raw.id) → KHÔNG nhân đôi.
    await postIngest(payload);
    await page.goto(`/don-hang?q=${orderId}`);
    await expect(page.locator("tbody tr").filter({ hasText: orderId })).toHaveCount(1);
  });

  test("AC2 — giá vốn HIỆN HÀNH: sửa giá vốn ở /san-pham → COGS + LN gộp /bao-cao đổi ngay", async ({ page }) => {
    const stamp = Date.now();
    const sku = `AC2-SKU-${stamp}`;
    const qty = 2;
    const sellPrice = 100000;
    const fee = 5000;
    const initialCost = 40000;

    await page.goto("/tai-chinh?tab=loi-lo");
    const cogsBefore = await readPnlAmount(page, "COGS");
    const grossBefore = await readPnlAmount(page, "LN gộp");

    await postIngest({
      products: [
        {
          id: `AC2-P-${stamp}`,
          name: "AC2 Product",
          variations: [
            {
              id: `AC2-V-${stamp}`,
              display_id: sku,
              retail_price: sellPrice,
              remain_quantity: 20,
              average_imported_price: initialCost, // → prefill Variant.costPrice lúc CREATE
            },
          ],
        },
      ],
      orders: [
        {
          id: `AC2-ORD-${stamp}`,
          status: 3, // COMPLETED — tính vào P&L
          inserted_at: `${TODAY}T09:30:00.000000`,
          order_sources_name: "Shopee",
          marketplace_id: "-3",
          total_price: qty * sellPrice,
          total_discount: 0,
          fee_marketplace: fee,
          items: [
            {
              quantity: qty,
              discount_each_product: 0,
              variation_info: { display_id: sku, name: "AC2 Product", retail_price: sellPrice },
            },
          ],
        },
      ],
    });

    const itemsTotal = qty * sellPrice; // 200.000
    const netRevenueContribution = itemsTotal - fee; // discount=0 → 195.000
    const cogsContribution1 = qty * initialCost; // 80.000
    const grossContribution1 = netRevenueContribution - cogsContribution1; // 115.000

    await page.goto("/tai-chinh?tab=loi-lo");
    expect(await readPnlAmount(page, "COGS")).toBe(cogsBefore - cogsContribution1);
    expect(await readPnlAmount(page, "LN gộp")).toBe(grossBefore + grossContribution1);

    // Sửa giá vốn ở /san-pham (COGS = giá vốn HIỆN HÀNH, không snapshot).
    // "AC2 Product" 1 biến thể → áp cấp sản phẩm không bung confirm.
    await page.goto(`/san-pham?q=${sku}`);
    const row = page.getByTestId("product-row").filter({ hasText: "AC2 Product" }).first();
    await row.getByTestId("gia-von-sp").click();
    const input = row.getByTestId("gia-von-sp");
    const newCost = 60000;
    await input.fill(String(newCost));
    await input.press("Enter");
    await expect(row.getByTestId("gia-von-sp")).toContainText("60.000");

    const cogsContribution2 = qty * newCost; // 120.000
    const grossContribution2 = netRevenueContribution - cogsContribution2; // 75.000

    await page.goto("/tai-chinh?tab=loi-lo");
    expect(await readPnlAmount(page, "COGS")).toBe(cogsBefore - cogsContribution2);
    expect(await readPnlAmount(page, "LN gộp")).toBe(grossBefore + grossContribution2);
  });

  test("AC4 — công thức P&L khớp tay tính; RETURNED loại khỏi P&L; Nhập hàng KHÔNG vào P&L", async ({ page }) => {
    const stamp = Date.now();
    const skuOk = `AC4-OK-${stamp}`;
    const skuRet = `AC4-RET-${stamp}`;
    const qtyOk = 3;
    const sellOk = 90000;
    const feeOk = 8000;
    const voucherOk = 10000;
    const costOk = 30000;
    // Số RẤT lệch cho đơn RETURNED — nếu (lỡ) bị tính vào P&L, assertion dưới sẽ vỡ rõ ràng (chứng minh loại trừ).
    const qtyRet = 1;
    const sellRet = 500000;
    const feeRet = 999999;
    const voucherRet = 999999;
    const costRet = 999999;

    await page.goto("/tai-chinh?tab=loi-lo");
    const before = {
      revenue: await readPnlAmount(page, "Giá niêm yết"),
      platformFee: await readPnlAmount(page, "Phí sàn"),
      voucher: await readPnlAmount(page, "Giảm giá do người bán"),
      netRevenue: await readPnlAmount(page, "Thực nhận từ sàn"),
      cogs: await readPnlAmount(page, "COGS"),
      grossProfit: await readPnlAmount(page, "LN gộp"),
      netProfit: await readPnlAmount(page, "LN ròng"),
    };

    await postIngest({
      products: [
        {
          id: `AC4-P-OK-${stamp}`,
          name: "AC4 OK",
          variations: [
            { id: `AC4-V-OK-${stamp}`, display_id: skuOk, retail_price: sellOk, remain_quantity: 20, average_imported_price: costOk },
          ],
        },
        {
          id: `AC4-P-RET-${stamp}`,
          name: "AC4 RET",
          variations: [
            { id: `AC4-V-RET-${stamp}`, display_id: skuRet, retail_price: sellRet, remain_quantity: 20, average_imported_price: costRet },
          ],
        },
      ],
      orders: [
        {
          id: `AC4-ORD-OK-${stamp}`,
          status: 3, // delivered → COMPLETED — hợp lệ, TÍNH
          inserted_at: `${TODAY}T10:00:00.000000`,
          order_sources_name: "Shopee",
          marketplace_id: "-3",
          total_price: qtyOk * sellOk,
          total_discount: voucherOk,
          fee_marketplace: feeOk,
          items: [
            { quantity: qtyOk, discount_each_product: 0, variation_info: { display_id: skuOk, name: "AC4 OK", retail_price: sellOk } },
          ],
        },
        {
          id: `AC4-ORD-RET-${stamp}`,
          status: 4, // returning → RETURNED — PHẢI loại khỏi P&L
          inserted_at: `${TODAY}T10:05:00.000000`,
          order_sources_name: "Shopee",
          marketplace_id: "-3",
          total_price: qtyRet * sellRet,
          total_discount: voucherRet,
          fee_marketplace: feeRet,
          items: [
            { quantity: qtyRet, discount_each_product: 0, variation_info: { display_id: skuRet, name: "AC4 RET", retail_price: sellRet } },
          ],
        },
      ],
    });

    // Hand-compute CHỈ từ đơn OK (đơn RETURNED không đóng góp gì).
    const itemsTotal = qtyOk * sellOk; // 270.000
    const netRevenueContribution = itemsTotal - feeOk - voucherOk; // 270.000−8.000−10.000=252.000
    const cogsContribution = qtyOk * costOk; // 90.000
    const grossContribution = netRevenueContribution - cogsContribution; // 162.000

    await page.goto("/tai-chinh?tab=loi-lo");
    expect(await readPnlAmount(page, "Giá niêm yết")).toBe(before.revenue + itemsTotal);
    expect(await readPnlAmount(page, "Phí sàn")).toBe(before.platformFee - feeOk);
    expect(await readPnlAmount(page, "Giảm giá do người bán")).toBe(before.voucher - voucherOk);
    expect(await readPnlAmount(page, "Thực nhận từ sàn")).toBe(before.netRevenue + netRevenueContribution);
    expect(await readPnlAmount(page, "COGS")).toBe(before.cogs - cogsContribution);
    expect(await readPnlAmount(page, "LN gộp")).toBe(before.grossProfit + grossContribution);
    // Chưa có chi phí sổ nào từ fixture này → LN ròng đóng góp = LN gộp đóng góp.
    const netProfitAfterOrders = before.netProfit + grossContribution;
    expect(await readPnlAmount(page, "LN ròng")).toBe(netProfitAfterOrders);

    // Thêm Expense danh mục "purchase" (Nhập hàng) qua UI → LN ròng KHÔNG đổi (dòng tiền, không phải P&L).
    await page.goto("/tai-chinh?tab=so-chi-phi");
    await page.getByRole("button", { name: "+ Thêm chi phí" }).first().click();
    const dialog = page.getByRole("dialog");
    await pickSelectOption(page, "Chọn danh mục", "Nhập hàng");
    await dialog.getByPlaceholder("0").fill("500000");
    await dialog.locator("textarea").fill(`AC4 purchase excluded ${stamp}`);
    await dialog.getByRole("button", { name: "Lưu" }).click();
    await expect(page.getByText(/Đã thêm chi phí/)).toBeVisible();

    await page.goto("/tai-chinh?tab=loi-lo");
    expect(await readPnlAmount(page, "LN ròng")).toBe(netProfitAfterOrders);
  });
});
