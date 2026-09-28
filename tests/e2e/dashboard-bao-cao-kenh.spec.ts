import { expect, test, type Page } from "@playwright/test";
import { format } from "date-fns";

import { ingestPancake, resetRawPancake } from "./ingest-raw";
import { TEST_USER_EMAIL, TEST_USER_PASSWORD } from "./test-constants";

/**
 * Phase 5 smoke — Dashboard / Báo cáo (P&L) / Kênh + drill-down `/kenh/:id`.
 * Seed 1 đơn Shopee COMPLETED "hôm nay" (đơn gốc, không phải mirror kho) qua
 * chính luồng `/api/ingest/raw` (Bronze → Silver; không ghi Prisma tay để dựng dữ liệu
 * nghiệp vụ) — neo ngày "hôm nay" (không dùng fixture ngày cố định) để LUÔN rơi vào
 * "Tháng này" bất kể tháng chạy test, đưa Dashboard/`/kenh`/`/kenh/shopee` ra khỏi
 * empty-state. Assert PRESENCE (không assert tổng tiền chính xác) — chịu được dữ liệu
 * tích lũy từ các spec khác chạy chung test DB.
 */

const TODAY = format(new Date(), "yyyy-MM-dd");

test.beforeAll(async () => {
  const stamp = Date.now();
  const sku = `E2E-KENH-SKU-${stamp}`;

  // Bronze dedupe theo hash payload: raw sót từ lần chạy trước ⇒ land 0 ⇒ transform không chạy.
  await resetRawPancake();
  await ingestPancake({
    products: [
      {
        id: `E2E-KENH-P-${stamp}`,
        name: "SP Kênh Test",
        variations: [
          {
            id: `E2E-KENH-V-${stamp}`,
            display_id: sku,
            retail_price: 150000,
            remain_quantity: 50,
            average_imported_price: 50000,
          },
        ],
      },
    ],
    orders: [
      {
        id: `E2E-KENH-ORDER-${stamp}`,
        status: 3, // delivered → COMPLETED, tính vào P&L
        inserted_at: `${TODAY}T10:00:00.000000`,
        order_sources_name: "Shopee",
        marketplace_id: "-3",
        total_price: 300000,
        total_discount: 0,
        fee_marketplace: 20000,
        customer: { name: "E2E Khách Kênh" },
        items: [
          {
            quantity: 2,
            discount_each_product: 0,
            variation_info: { display_id: sku, name: "SP Kênh Test", retail_price: 150000 },
          },
        ],
      },
    ],
  });
});

async function login(page: Page): Promise<void> {
  await page.goto("/dang-nhap");
  await page.getByLabel("Email").fill(TEST_USER_EMAIL);
  await page.getByLabel("Mật khẩu", { exact: true }).fill(TEST_USER_PASSWORD);
  await page.getByRole("button", { name: "Đăng nhập" }).click();
  await expect(page).toHaveURL("/");
}

test.describe("Phase 5 smoke — Dashboard / Báo cáo / Kênh", () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
  });

  test("Dashboard hiện 4 KPI card + card Tình trạng đồng bộ", async ({ page }) => {
    // Neo vào ĐÚNG nhãn "Doanh thu gộp". Bản cũ neo `getByText("Doanh thu", { exact: true })`
    // — chú giải biểu đồ bên dưới cũng có đúng chuỗi "Doanh thu", nên phép kiểm đó vẫn XANH kể
    // cả khi card KPI đổi nhãn hay biến mất hoàn toàn; `.first()` chỉ giấu chuyện đó kỹ hơn.
    await expect(page.getByText("Doanh thu gộp", { exact: true })).toBeVisible();
    // Dòng đối chiếu Pancake: `netRevenue` (gộp − phí sàn − voucher), cùng nhãn với bảng Lãi/Lỗ
    // và ứng với ô "Doanh thu" bên Pancake POS. Mất dòng ⇒ chủ shop lại so hai màn ra hai số lệch.
    await expect(page.getByText(/^Thực nhận từ sàn:/)).toBeVisible();
    await expect(page.getByText("Số đơn hợp lệ")).toBeVisible();
    await expect(page.getByText("LN ròng ước tính tháng")).toBeVisible();
    await expect(page.getByText("Tỷ lệ hoàn/bom tháng")).toBeVisible();
    await expect(page.getByText("Tình trạng đồng bộ")).toBeVisible();
  });

  test("/tai-chinh?tab=loi-lo hiện dòng LN ròng + badge tạm tính", async ({ page }) => {
    await page.goto("/tai-chinh?tab=loi-lo");
    await expect(page.getByText("LN ròng").first()).toBeVisible();
    // `exact` vì chú thích bản in (ẩn trên màn) cũng chứa cụm "tạm tính".
    await expect(page.getByText("tạm tính", { exact: true })).toBeVisible();
  });

  /**
   * Chú thích các khoản mục nằm sau dấu "?" (bảng gọn hơn hẳn khi không in mọi
   * lời giải thích ra màn). Nếu nút đó không mở được thì toàn bộ phần giải thích
   * biến mất khỏi app mà nhìn bảng vẫn thấy "bình thường".
   *
   * Phải khẳng định chú thích BAN ĐẦU KHÔNG hiện rồi mới rê chuột: bản test cũ
   * chỉ `click()` — mà Playwright tự di chuột tới nút trước khi bấm, nên hover đã
   * mở sẵn và phép kiểm xanh kể cả khi thao tác bấm hỏng hoàn toàn.
   */
  test("/tai-chinh?tab=loi-lo — dấu ? mở chú thích khi rê chuột, đóng khi rời", async ({ page }) => {
    await page.goto("/tai-chinh?tab=loi-lo");

    const nut = page.getByRole("button", { name: /^Giải thích: Doanh thu$/ });
    // Neo vào ĐÚNG popup, không phải text bất kỳ: bản sao chú thích dành cho máy
    // in luôn nằm sẵn trong DOM (chỉ ẩn trên màn) nên đếm theo text sẽ ra 1 kể cả
    // khi popup chưa mở — phép kiểm thành vô nghĩa.
    const popup = page.locator('[data-slot="popover-content"]', { hasText: /Tiền hàng shop thực bán được/ });
    await expect(nut).toBeVisible();
    await expect(popup).toHaveCount(0); // chưa đụng vào thì không được hiện sẵn

    await nut.hover();
    await expect(popup).toBeVisible();

    // Rời chuột sang chỗ khác thì phải đóng — kẹt mở sẽ che mất các dòng bên dưới.
    await page.getByRole("heading", { name: "Tài chính" }).first().hover();
    await expect(popup).toHaveCount(0);
  });

  test("/bao-cao?tab=pnl (URL cũ) redirect sang hub Tài chính", async ({ page }) => {
    await page.goto("/bao-cao?tab=pnl");
    await expect(page).toHaveURL(/\/tai-chinh\?tab=loi-lo/);
    await expect(page.getByText("LN ròng").first()).toBeVisible();
  });

  test("/kenh hiện card Shopee", async ({ page }) => {
    await page.goto("/kenh");
    await expect(page.getByText("Shopee", { exact: true }).first()).toBeVisible();
  });

  test("/kenh/shopee hiện đủ 8 KPI card", async ({ page }) => {
    await page.goto("/kenh/shopee");
    await expect(page.getByText("Doanh thu", { exact: true }).first()).toBeVisible();
    await expect(page.getByText("Số đơn", { exact: true }).first()).toBeVisible();
    await expect(page.getByText("AOV", { exact: true }).first()).toBeVisible();
    await expect(page.getByText("Chi phí ads", { exact: true }).first()).toBeVisible();
    await expect(page.getByText("Phí sàn (từ đơn)").first()).toBeVisible();
    await expect(page.getByText("Hoàn/Bom", { exact: true }).first()).toBeVisible();
    await expect(page.getByText("LN ròng", { exact: true }).first()).toBeVisible();
    await expect(page.getByText("ROAS", { exact: true }).first()).toBeVisible();
  });

  test("/kenh/shopee có khối sản phẩm bán chạy theo kênh", async ({ page }) => {
    await page.goto("/kenh/shopee");
    await expect(page.getByRole("heading", { name: /Sản phẩm bán chạy/ })).toBeVisible();
  });

  test("picker toàn cục theo kịp URL khi drill client-side đổi tu/den (không kẹt nhãn cũ)", async ({ page }) => {
    // Bug: DateRangeProvider chỉ đọc URL lúc mount → điều hướng soft đổi
    // ?tu=&den= không cập nhật nhãn picker. Kịch bản thật: drill dòng P&L (COGS)
    // sang /bao-cao?tab=san-pham&tu=&den= — cùng là route áp picker toàn cục.
    await page.goto("/tai-chinh?tab=loi-lo");
    const picker = page.getByRole("group", { name: "Chọn khoảng thời gian" });
    await expect(picker).toBeVisible();
    // Trước drill: đang ở preset "Tháng này" → CHƯA có nhãn khoảng ngày "dd/MM – dd/MM".
    const customLabel = picker.getByText(/\d{2}\/\d{2}\s*[–-]\s*\d{2}\/\d{2}/);
    await expect(customLabel).toHaveCount(0);

    // Dòng "COGS" luôn hiện khi tháng có doanh thu (đơn seed hôm nay) → là Next
    // <Link> (soft-nav, KHÔNG remount provider) sang /bao-cao?tab=san-pham gắn
    // tu/den = trọn tháng đang xem. Soft-nav là điều kiện ĐANG được kiểm: chỉ
    // effect sync (không phải mount effect) mới cập nhật nhãn — nếu COGS đổi
    // thành full-reload, mount effect sẽ che mất effect sync hỏng.
    await page.getByRole("link", { name: "COGS" }).click();
    await expect(page).toHaveURL(/\/bao-cao\?.*tab=san-pham/);
    await expect(page).toHaveURL(/tu=\d{4}-\d{2}-\d{2}/);

    // Sau fix: picker nhận tu/den từ URL → nhãn "Tùy chọn" đổi thành khoảng ngày.
    await expect(customLabel).toBeVisible();

    // Guard: drill soft-nav CHỈ đổi nhãn hiển thị, KHÔNG ghi range vào
    // localStorage (nếu ghi, phiên sau mở app URL sạch sẽ kẹt range drill thay
    // vì "Tháng này"). localStorage vẫn giữ preset mặc định.
    const stored = await page.evaluate(() => window.localStorage.getItem("hogikids_date_range"));
    expect(stored).toContain('"this_month"');
    expect(stored).not.toContain("custom");
  });

  test("giữ lựa chọn preset khi soft-nav sang route URL sạch (không âm thầm reset về Tháng này)", async ({
    page,
  }) => {
    // Chốt chặn nhánh "URL sạch → GIỮ lựa chọn in-memory" của effect sync: dễ
    // hồi quy nếu ai đó thêm else-branch reset. Dùng /kenh ↔ "/" (Dashboard) vì
    // cả hai KHÔNG auto-snap range (khác /bao-cao, /tai-chinh có month-picker).
    await page.goto("/kenh");
    const sevenDays = page.getByRole("button", { name: "7 ngày" });
    await sevenDays.click();
    await expect(page).toHaveURL(/range=7d/);
    await expect(sevenDays).toHaveClass(/bg-surface-card/); // active

    // Soft-nav sang Dashboard qua logo (Link href="/", KHÔNG mang ?range) → URL sạch.
    await page.getByRole("link", { name: "HogiKids" }).first().click();
    await expect(page).toHaveURL(/^http:\/\/localhost:3000\/$/);

    // Nút "7 ngày" vẫn active (lựa chọn dính), KHÔNG bị reset về "Tháng này".
    await expect(page.getByRole("button", { name: "7 ngày" })).toHaveClass(/bg-surface-card/);
  });

  test("/kenh/khong-ton-tai redirect về /kenh", async ({ page }) => {
    // KHÔNG assert toast "Không tìm thấy kênh" ở đây — sonner tự dismiss
    // (~4s) và ChannelNotFoundToast tự dọn `?loi=` khỏi URL ngay khi mount,
    // nên đến lúc assertion chạy có thể toast đã biến mất (flaky). Điều
    // khoản e2e chỉ yêu cầu "redirects to /kenh" — kiểm URL là đủ bằng chứng
    // route id-không-hợp-lệ đã redirect đúng.
    await page.goto("/kenh/khong-ton-tai");
    await expect(page).toHaveURL(/\/kenh(\?.*)?$/);
  });
});
