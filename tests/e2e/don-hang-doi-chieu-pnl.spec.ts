import { expect, test, type Page } from "@playwright/test";
import { format } from "date-fns";

import { ingestPancake, resetRawPancake } from "./ingest-raw";
import { TEST_USER_EMAIL, TEST_USER_PASSWORD } from "./test-constants";

/**
 * NGHIỆM THU tính năng "Đơn hàng — cột Phí sàn/Voucher + dải tổng đối chiếu P&L".
 *
 * Kịch bản người dùng thật: ở `/tai-chinh?tab=loi-lo` bấm dòng "Doanh thu gộp"
 * (hoặc "Phí sàn"/"Voucher") → sang `/don-hang` đã lọc sẵn kỳ + trạng thái →
 * số ở DẢI TỔNG phải BẰNG ĐÚNG số ở dòng P&L vừa bấm. Đây là bằng chứng duy
 * nhất chứng minh tính năng làm được việc user cần: đối chiếu được.
 *
 * Nguyên tắc của file này:
 *  - Cả hai vế đều ĐỌC TỪ DOM (P&L đọc ở màn Lãi/Lỗ, dải tổng đọc ở màn Đơn
 *    hàng) rồi so với nhau. TUYỆT ĐỐI KHÔNG hardcode số kỳ vọng cho phép so
 *    này — hardcode thì lệch định nghĩa "đơn hợp lệ" (thiếu/thừa 1 slug trạng
 *    thái) vẫn xanh, mất sạch mục đích test.
 *  - Riêng test 1 có hand-compute từ fixture, nhưng theo kiểu ĐỘ LỆCH so với
 *    baseline đọc trước khi seed (DB test tích lũy qua các lần chạy) — mục đích
 *    là chốt ĐỊNH NGHĨA: PENDING + SHIPPING + COMPLETED tính vào P&L, RETURNED
 *    và CANCELLED thì không.
 */

test.describe.configure({ mode: "serial" });

const TODAY = format(new Date(), "yyyy-MM-dd");
const STAMP = Date.now();
const SKU = `DOICHIEU-SKU-${STAMP}`;

/**
 * Đơn HỢP LỆ (P&L tính): phủ đủ 3 trạng thái PENDING(1) / SHIPPING(2) /
 * COMPLETED(3). Số lượng CỐ TÌNH > 1 trang (PAGE_SIZE = 20) để test "tổng theo
 * bộ lọc, không theo trang" luôn có trang 2 thật mà chạy — nếu chỉ seed vài đơn
 * thì test đó sẽ bị skip và rủi ro nguy hiểm nhất (tổng cộng theo trang đang
 * xem) không được kiểm.
 */
const VALID_ORDER_STATUS_CODES = [1, 2, 3];
const VALID_ORDERS = Array.from({ length: 21 }, (_, i) => ({
  seq: i,
  code: VALID_ORDER_STATUS_CODES[i % VALID_ORDER_STATUS_CODES.length],
  itemsTotal: 100_000 + i * 1_000,
  fee: 7_000 + i * 100,
  voucher: i % 2 === 0 ? 0 : 5_000 + i * 10,
}));

/**
 * Đơn BỊ LOẠI (RETURNED=4, CANCELLED=6) với số RẤT lệch: nếu lọt vào một trong
 * hai vế (P&L hoặc dải tổng) thì assertion vỡ to và rõ, không âm thầm.
 */
const EXCLUDED_ORDERS = [
  { seq: 100, code: 4, itemsTotal: 9_000_000, fee: 900_000, voucher: 800_000 },
  { seq: 101, code: 6, itemsTotal: 7_000_000, fee: 700_000, voucher: 600_000 },
];

const SUM_VALID = {
  itemsTotal: VALID_ORDERS.reduce((s, o) => s + o.itemsTotal, 0),
  fee: VALID_ORDERS.reduce((s, o) => s + o.fee, 0),
  voucher: VALID_ORDERS.reduce((s, o) => s + o.voucher, 0),
};

async function login(page: Page): Promise<void> {
  await page.goto("/dang-nhap");
  await page.getByLabel("Email").fill(TEST_USER_EMAIL);
  await page.getByLabel("Mật khẩu", { exact: true }).fill(TEST_USER_PASSWORD);
  await page.getByRole("button", { name: "Đăng nhập" }).click();
  await expect(page).toHaveURL("/");
}

/** "−35.000 ₫" → -35000. Đảo ngược `formatVnd()` (dấu trừ là U+2212 MINUS SIGN). */
function parseVndText(text: string): number {
  // Một số ô phí sàn nay có hậu tố tỉ lệ "· 27%" — CHỈ lấy phần TIỀN trước "·"
  // (nếu lấy cả thì digits của % sẽ dính vào số tiền). Ô tiền thường không có "·".
  const moneyPart = text.split("·")[0];
  const negative = moneyPart.includes("−");
  const digits = moneyPart.replace(/[^\d]/g, "");
  return digits === "" ? 0 : (negative ? -1 : 1) * Number(digits);
}

/**
 * Cột "Số tiền" của 1 dòng bảng P&L theo nhãn. Tháng trống → empty-state → 0.
 *
 * Nhãn nay KHÔNG còn tiền tố "− "/"= " (dấu trừ chỉ nằm ở cột Số tiền) — regex
 * vẫn nhận tiền tố cho tương thích ngược, nhưng phải neo trên
 * PHẦN TỬ Link/span chứa đúng nhãn (phần tử con nhỏ nhất), KHÔNG
 * phải cả `<td>`: dòng "LN ròng" còn có Badge "tạm tính" nằm cùng ô (sibling),
 * dòng "COGS" còn có icon cảnh báo — accessible name của cả ô sẽ dính thêm
 * text đó nên neo cuối chuỗi trên cả ô KHÔNG BAO GIỜ khớp. `getByText` với
 * regex neo chỉ khớp phần tử có text NGUYÊN VẸN bằng đúng chuỗi, nên tự động
 * chọn đúng Link/span lá thay vì `<td>`/`<tr>` cha (có thêm số tiền/badge).
 * Cách này cũng tách "Phí sàn" khỏi "Phí sàn đơn hoàn/hủy" (label dài hơn,
 * cùng tiền tố) — substring match kiểu cũ (`hasText` cả dòng) chỉ PASS nhờ
 * `.first()` bắt đúng thứ tự DOM, mong manh khi thêm dòng mới.
 */
async function readPnlAmount(page: Page, label: string): Promise<number> {
  if ((await page.getByText(/Chưa có dữ liệu tháng/).count()) > 0) return 0;
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const labelEl = page.getByText(new RegExp(`^(?:− |= )?${escaped}$`));
  const row = page.locator("table tbody tr").filter({ has: labelEl }).first();
  return parseVndText((await row.locator("td").nth(1).textContent()) ?? "");
}

/**
 * Số của 1 ô trong dải tổng `/don-hang` — lấy span kề ngay sau span nhãn.
 * Nhãn dùng ĐÚNG chuỗi hiển thị (có tiền tố "− "/"= ") nên không đụng header
 * bảng ("Phí sàn"/"Voucher" trơn).
 */
async function readStripAmount(page: Page, label: string): Promise<number> {
  const value = page.getByText(label, { exact: true }).locator("xpath=following-sibling::span[1]");
  return parseVndText((await value.textContent()) ?? "");
}

/**
 * Dòng P&L bấm được ↔ ô tương ứng trên dải tổng `/don-hang`. `stripLabels` là
 * DANH SÁCH vì hai màn nhóm số khác nhau: bảng P&L gộp "Doanh thu" = doanh thu
 * gộp đã trừ voucher, còn dải tổng vẫn tách làm hai ô (số ở ô voucher mang dấu
 * âm sẵn nên chỉ việc cộng). Đối chiếu vẫn là đối chiếu thật, không nới lỏng.
 *
 * Không đối chiếu dòng "Giảm giá do người bán": nó gộp cả phần giảm giá trên
 * từng sản phẩm (đã nằm trong `itemsTotal`) nên dải tổng `/don-hang` chưa có ô
 * tương ứng — thêm ô đó là việc của màn Đơn hàng, không phải test này.
 */
const DRILL_LINES = [
  { pnlLabel: "Doanh thu", linkName: "Doanh thu", stripLabels: ["Doanh thu gộp", "− Voucher"] },
  { pnlLabel: "Phí sàn", linkName: "Phí sàn", stripLabels: ["− Phí sàn"] },
];

test.describe("Đơn hàng ↔ P&L — đối chiếu số", () => {
  test.beforeAll(async () => {
    // Bronze dedupe theo hash payload: raw sót lần trước ⇒ land 0 ⇒ transform không chạy.
    await resetRawPancake();
  });

  test.beforeEach(async ({ page }) => {
    await login(page);
  });

  test("seed đơn 5 trạng thái → P&L chỉ cộng PENDING/SHIPPING/COMPLETED", async ({ page }) => {
    await page.goto("/tai-chinh?tab=loi-lo");
    const before = {
      revenue: await readPnlAmount(page, "Giá niêm yết"),
      platformFee: await readPnlAmount(page, "Phí sàn"),
      voucher: await readPnlAmount(page, "Giảm giá do người bán"),
      netRevenue: await readPnlAmount(page, "Thực nhận từ sàn"),
    };

    await ingestPancake({
      products: [
        {
          id: `DOICHIEU-P-${STAMP}`,
          name: "SP Đối Chiếu",
          variations: [
            {
              id: `DOICHIEU-V-${STAMP}`,
              display_id: SKU,
              retail_price: 150_000,
              remain_quantity: 100,
              average_imported_price: 50_000,
            },
          ],
        },
      ],
      orders: [...VALID_ORDERS, ...EXCLUDED_ORDERS].map((o) => ({
        id: `DOICHIEU-ORD-${o.seq}-${STAMP}`,
        status: o.code,
        inserted_at: `${TODAY}T08:00:00.000000`,
        order_sources_name: "Shopee",
        marketplace_id: "-3",
        total_price: o.itemsTotal,
        total_discount: o.voucher,
        fee_marketplace: o.fee,
        customer: { name: `Khách Đối Chiếu ${o.seq}` },
        items: [
          {
            quantity: 1,
            discount_each_product: 0,
            variation_info: { display_id: SKU, name: "SP Đối Chiếu", retail_price: 150_000 },
          },
        ],
      })),
    });

    await page.goto("/tai-chinh?tab=loi-lo");
    // Dòng bị trừ hiện số ÂM trên bảng → đóng góp mang dấu trừ.
    expect(await readPnlAmount(page, "Giá niêm yết")).toBe(before.revenue + SUM_VALID.itemsTotal);
    expect(await readPnlAmount(page, "Phí sàn")).toBe(before.platformFee - SUM_VALID.fee);
    expect(await readPnlAmount(page, "Giảm giá do người bán")).toBe(before.voucher - SUM_VALID.voucher);
    expect(await readPnlAmount(page, "Thực nhận từ sàn")).toBe(
      before.netRevenue + SUM_VALID.itemsTotal - SUM_VALID.fee - SUM_VALID.voucher,
    );
  });

  test("bấm dòng P&L → /don-hang lọc sẵn kỳ + trạng thái hợp lệ", async ({ page }) => {
    await page.goto("/tai-chinh?tab=loi-lo");
    await page.getByRole("link", { name: "Doanh thu", exact: true }).click();

    await expect(page).toHaveURL(/\/don-hang\?/);
    const url = new URL(page.url());
    const monthStart = format(new Date(new Date().getFullYear(), new Date().getMonth(), 1), "yyyy-MM-dd");
    expect(url.searchParams.get("ngay_tu")).toBe(monthStart);
    expect(url.searchParams.get("ngay_den")).not.toBeNull();
    // 3 slug "đơn hợp lệ" — thiếu 1 cái là số hai màn lệch ngay.
    expect(url.searchParams.get("trang_thai")?.split(",").sort()).toEqual(
      ["cho_xu_ly", "dang_giao", "hoan_thanh"].sort(),
    );

    // Caption phải NÓI RA rằng bộ lọc này khớp tập "đơn hợp lệ" của P&L.
    await expect(page.getByText(/số dưới đây khớp bảng Lỗ lãi cùng kỳ/)).toBeVisible();
  });

  test("dải tổng /don-hang BẰNG ĐÚNG dòng P&L vừa bấm", async ({ page }) => {
    for (const line of DRILL_LINES) {
      await page.goto("/tai-chinh?tab=loi-lo");
      const pnlAmount = await readPnlAmount(page, line.pnlLabel);
      // Non-vacuity: seed ở test 1 đảm bảo tháng này có số, không phải so 0 với 0.
      expect(pnlAmount, `dòng P&L "${line.pnlLabel}" không được bằng 0 sau khi seed`).not.toBe(0);

      await page.getByRole("link", { name: line.linkName, exact: true }).click();
      await expect(page).toHaveURL(/\/don-hang\?/);

      let stripAmount = 0;
      for (const label of line.stripLabels) stripAmount += await readStripAmount(page, label);
      expect(
        stripAmount,
        `dải tổng ${line.stripLabels.join(" + ")} phải bằng dòng P&L "${line.pnlLabel}"`
      ).toBe(pnlAmount);
    }
  });

  test('ô "= Thực nhận từ sàn" bằng dòng subtotal cùng tên ở P&L', async ({ page }) => {
    await page.goto("/tai-chinh?tab=loi-lo");
    const pnlNetRevenue = await readPnlAmount(page, "Thực nhận từ sàn");
    expect(pnlNetRevenue).not.toBe(0);

    await page.getByRole("link", { name: "Doanh thu", exact: true }).click();
    expect(await readStripAmount(page, "= Thực nhận từ sàn")).toBe(pnlNetRevenue);
  });

  test("tổng theo BỘ LỌC chứ không theo trang: sang trang 2 số dải tổng không đổi", async ({ page }) => {
    await page.goto("/tai-chinh?tab=loi-lo");
    await page.getByRole("link", { name: "Doanh thu", exact: true }).click();
    const page1 = {
      revenue: await readStripAmount(page, "Doanh thu gộp"),
      fee: await readStripAmount(page, "− Phí sàn"),
      voucher: await readStripAmount(page, "− Voucher"),
    };

    const url = new URL(page.url());
    url.searchParams.set("trang", "2");
    await page.goto(`${url.pathname}${url.search}`);

    // Fixture seed 21 đơn hợp lệ (> PAGE_SIZE 20) nên trang 2 LUÔN có dòng —
    // không có nhánh skip ở đây, skip là để lọt đúng rủi ro cần chặn.
    await expect(page.getByText("Doanh thu gộp", { exact: true })).toBeVisible();

    expect(await readStripAmount(page, "Doanh thu gộp")).toBe(page1.revenue);
    expect(await readStripAmount(page, "− Phí sàn")).toBe(page1.fee);
    expect(await readStripAmount(page, "− Voucher")).toBe(page1.voucher);
  });
});
