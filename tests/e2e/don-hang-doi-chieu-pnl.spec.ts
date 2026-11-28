import { expect, test, type Page } from "./fixture-cho-trang-stream-xong";
import { format } from "date-fns";

import { ingestPancake, resetRawPancake } from "./ingest-raw";
import { TEST_USER_EMAIL, TEST_USER_PASSWORD } from "./test-constants";

/**
 * NGHIỆM THU "Đơn hàng — thẻ số đối chiếu P&L".
 *
 * Kịch bản người dùng thật: ở `/tai-chinh?tab=loi-lo` bấm dòng "Doanh thu"
 * (hoặc "Phí sàn") → sang `/don-hang` đã lọc sẵn kỳ + trạng thái →
 * số trên THẺ phải BẰNG ĐÚNG số ở dòng P&L vừa bấm. Đây là bằng chứng duy
 * nhất chứng minh tính năng làm được việc user cần: đối chiếu được.
 *
 * Nguyên tắc của file này:
 *  - Cả hai vế đều ĐỌC TỪ DOM (P&L đọc ở màn Lãi/Lỗ, thẻ số đọc ở màn Đơn
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
 * hai vế (P&L hoặc thẻ số) thì assertion vỡ to và rõ, không âm thầm. Có phí sàn
 * sàn giữ (`returned_fee`) để dòng "Phí sàn đơn hoàn/hủy" của P&L khác 0 — đối
 * chiếu đường bấm dòng đó không được là so 0 với 0.
 */
const EXCLUDED_ORDERS = [
  { seq: 100, code: 4, itemsTotal: 9_000_000, fee: 900_000, voucher: 800_000, returnedFee: 33_000 },
  { seq: 101, code: 6, itemsTotal: 7_000_000, fee: 700_000, voucher: 600_000, returnedFee: 11_000 },
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

/** 44000 → "44.000 ₫" (cùng cách `formatVnd` viết số dương) — để so chữ trong câu chú thích. */
function formatVndE2e(n: number): string {
  return `${String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ".")} ₫`;
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
  // `innerText`: ô "Số tiền" còn chứa dòng phụ mobile `md:hidden` (% · so tháng trước) — xem
  // `readPnlAmount` ở acceptance.spec.ts.
  return parseVndText(await row.locator("td").nth(1).innerText());
}

/**
 * Số trên thẻ của `/don-hang`. Tiền hàng / Tiền sau voucher và phí sàn / Lãi đọc ô số lớn của thẻ; phí sàn và voucher đọc
 * thuộc tính `title` của phần "phí sàn x% · voucher y%" ("Phí sàn −1.234 ₫") — chữ hiển thị chỉ là %.
 * Phí sàn đơn hoàn/hủy đọc CHỮ HIỂN THỊ ("phí sàn đơn hoàn/hủy −44.000 ₫") — người dùng thấy trực tiếp; vắng
 * (tổng = 0) ⇒ 0.
 */
type OThe = "tien-hang" | "thuc-nhan" | "lai" | "phi-san" | "voucher" | "phi-san-hoan-huy";
async function readCard(page: Page, o: OThe): Promise<number> {
  if (o === "phi-san-hoan-huy") {
    const el = page.getByTestId("phi-san-hoan-huy-tong");
    return (await el.count()) === 0 ? 0 : parseVndText(await el.innerText());
  }
  if (o === "phi-san" || o === "voucher") {
    const el = page.getByTestId(o === "phi-san" ? "phi-san-tong" : "voucher-tong");
    return parseVndText((await el.getAttribute("title")) ?? "");
  }
  return parseVndText(await page.getByTestId(`the-so-${o}`).getByTestId("gia-tri").innerText());
}

/**
 * Dòng P&L bấm được ↔ ô tương ứng trên thẻ `/don-hang`. `cardParts` là DANH SÁCH vì hai màn nhóm số
 * khác nhau: bảng P&L gộp "Doanh thu" = tiền hàng đã trừ voucher, còn thẻ tách Tiền hàng với voucher
 * (title voucher mang dấu âm sẵn nên chỉ việc cộng). Đối chiếu vẫn là đối chiếu thật, không nới lỏng.
 *
 * Không đối chiếu dòng "Giảm giá do người bán": nó gộp cả phần giảm giá trên từng sản phẩm (đã nằm
 * trong `itemsTotal`) nên trang Đơn hàng chưa có ô tương ứng.
 */
const DRILL_LINES: { pnlLabel: string; linkName: string; cardParts: OThe[] }[] = [
  { pnlLabel: "Doanh thu", linkName: "Doanh thu", cardParts: ["tien-hang", "voucher"] },
  { pnlLabel: "Phí sàn", linkName: "Phí sàn", cardParts: ["phi-san"] },
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
        ...("returnedFee" in o ? { advanced_platform_fee: { returned_fee: o.returnedFee } } : {}),
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

    // Chú thích dưới thẻ phải NÓI RA rằng bộ lọc này khớp tập "đơn hợp lệ" của P&L — không phải bản
    // cảnh báo "Đang lọc".
    const ghiChu = page.getByTestId("ghi-chu-the");
    await expect(ghiChu).toContainText(/khớp bảng Lãi\/Lỗ/);
    await expect(ghiChu).not.toContainText("Đang lọc");
  });

  test("thẻ số /don-hang BẰNG ĐÚNG dòng P&L vừa bấm", async ({ page }) => {
    for (const line of DRILL_LINES) {
      await page.goto("/tai-chinh?tab=loi-lo");
      const pnlAmount = await readPnlAmount(page, line.pnlLabel);
      // Non-vacuity: seed ở test 1 đảm bảo tháng này có số, không phải so 0 với 0.
      expect(pnlAmount, `dòng P&L "${line.pnlLabel}" không được bằng 0 sau khi seed`).not.toBe(0);

      await page.getByRole("link", { name: line.linkName, exact: true }).click();
      await expect(page).toHaveURL(/\/don-hang\?/);

      let cardAmount = 0;
      for (const o of line.cardParts) cardAmount += await readCard(page, o);
      expect(cardAmount, `thẻ ${line.cardParts.join(" + ")} phải bằng dòng P&L "${line.pnlLabel}"`).toBe(pnlAmount);
    }
  });

  test('thẻ "Tiền sau voucher và phí sàn" bằng dòng subtotal "Thực nhận từ sàn" ở P&L', async ({ page }) => {
    await page.goto("/tai-chinh?tab=loi-lo");
    const pnlNetRevenue = await readPnlAmount(page, "Thực nhận từ sàn");
    expect(pnlNetRevenue).not.toBe(0);

    await page.getByRole("link", { name: "Doanh thu", exact: true }).click();
    await expect(page).toHaveURL(/\/don-hang\?/);
    expect(await readCard(page, "thuc-nhan")).toBe(pnlNetRevenue);
  });

  test('thẻ "Lãi đơn" bằng dòng "LN gộp" khi lọc đúng đơn hợp lệ', async ({ page }) => {
    await page.goto("/tai-chinh?tab=loi-lo");
    const pnlGrossProfit = await readPnlAmount(page, "LN gộp");
    expect(pnlGrossProfit).not.toBe(0);

    await page.getByRole("link", { name: "Doanh thu", exact: true }).click();
    await expect(page).toHaveURL(/\/don-hang\?/);
    // Drill "Doanh thu" luôn lọc đúng 3 trạng thái hợp lệ ⇒ không có phí sàn đơn hoàn/hủy trừ vào thẻ.
    expect(new URL(page.url()).searchParams.get("trang_thai")?.split(",").sort()).toEqual(
      ["cho_xu_ly", "dang_giao", "hoan_thanh"].sort(),
    );
    expect(await readCard(page, "lai")).toBe(pnlGrossProfit);
  });

  test("tổng theo BỘ LỌC chứ không theo trang: sang trang 2 số trên thẻ không đổi", async ({ page }) => {
    await page.goto("/tai-chinh?tab=loi-lo");
    await page.getByRole("link", { name: "Doanh thu", exact: true }).click();
    await expect(page).toHaveURL(/\/don-hang\?/);
    const page1 = {
      revenue: await readCard(page, "tien-hang"),
      fee: await readCard(page, "phi-san"),
      voucher: await readCard(page, "voucher"),
    };

    const url = new URL(page.url());
    url.searchParams.set("trang", "2");
    await page.goto(`${url.pathname}${url.search}`);

    // Fixture seed 21 đơn hợp lệ (> PAGE_SIZE 20) nên trang 2 LUÔN có dòng —
    // không có nhánh skip ở đây, skip là để lọt đúng rủi ro cần chặn.
    await expect(page.getByTestId("bang-don-hang").getByTestId("dong-don-hang").first()).toBeVisible();
    expect(new URL(page.url()).searchParams.get("trang")).toBe("2");

    expect(await readCard(page, "tien-hang")).toBe(page1.revenue);
    expect(await readCard(page, "phi-san")).toBe(page1.fee);
    expect(await readCard(page, "voucher")).toBe(page1.voucher);
  });

  test('bấm dòng "Phí sàn đơn hoàn/hủy" → số phí sàn đơn hoàn/hủy trên trang BẰNG ĐÚNG dòng đó', async ({ page }) => {
    await page.goto("/tai-chinh?tab=loi-lo");
    const pnlHoanHuy = await readPnlAmount(page, "Phí sàn đơn hoàn/hủy");
    // Non-vacuity: hai đơn loại ở test 1 có phí sàn giữ 33.000 + 11.000.
    expect(pnlHoanHuy).toBeLessThanOrEqual(-44_000);

    await page.getByRole("link", { name: "Phí sàn đơn hoàn/hủy", exact: true }).click();
    await expect(page).toHaveURL(/\/don-hang\?/);
    expect(new URL(page.url()).searchParams.get("trang_thai")?.split(",").sort()).toEqual(["hoan_hang", "huy_bom"]);

    // Số nhìn thấy (không nằm trong title) — người không rê chuột được (iPhone) vẫn đối chiếu được.
    await expect(page.getByTestId("phi-san-hoan-huy-tong")).toBeVisible();
    expect(await readCard(page, "phi-san-hoan-huy")).toBe(pnlHoanHuy);
    // Chú thích trỏ ĐÚNG dòng vừa bấm, không phải bản cảnh báo "Đang lọc… không khớp".
    const ghiChu = page.getByTestId("ghi-chu-the");
    await expect(ghiChu).toContainText("khớp dòng “Phí sàn đơn hoàn/hủy” của bảng Lãi/Lỗ");
    await expect(ghiChu).toContainText(formatVndE2e(-pnlHoanHuy));
    await expect(ghiChu).not.toContainText("Đang lọc");
  });

  test("màn mặc định (Tháng này, mọi trạng thái): Lãi đơn = LN gộp − Phí sàn đơn hoàn/hủy, các thẻ tiền vẫn khớp", async ({ page }) => {
    await page.goto("/tai-chinh?tab=loi-lo");
    const pnl = {
      doanhThu: await readPnlAmount(page, "Doanh thu"),
      phiSan: await readPnlAmount(page, "Phí sàn"),
      thucNhan: await readPnlAmount(page, "Thực nhận từ sàn"),
      lnGop: await readPnlAmount(page, "LN gộp"),
      hoanHuy: await readPnlAmount(page, "Phí sàn đơn hoàn/hủy"),
    };
    expect(pnl.lnGop).not.toBe(0);
    expect(pnl.hoanHuy).toBeLessThan(0);

    await page.goto("/don-hang");
    expect((await readCard(page, "tien-hang")) + (await readCard(page, "voucher"))).toBe(pnl.doanhThu);
    expect(await readCard(page, "phi-san")).toBe(pnl.phiSan);
    expect(await readCard(page, "thuc-nhan")).toBe(pnl.thucNhan);
    expect(await readCard(page, "phi-san-hoan-huy")).toBe(pnl.hoanHuy);
    // Dòng P&L "Phí sàn đơn hoàn/hủy" là khoản trừ (đọc ra số âm) ⇒ cộng là trừ đi.
    expect(await readCard(page, "lai")).toBe(pnl.lnGop + pnl.hoanHuy);

    const ghiChu = page.getByTestId("ghi-chu-the");
    await expect(ghiChu).toContainText(/khớp bảng Lãi\/Lỗ/);
    await expect(ghiChu).toContainText(`Lãi đơn = “LN gộp” − “Phí sàn đơn hoàn/hủy” (${formatVndE2e(-pnl.hoanHuy)})`);
    await expect(ghiChu).not.toContainText("Đang lọc");
  });
});
