import { expect, test, type Page } from "@playwright/test";

import { postRawEnvelope, resetRawTiktokShopAnalytics, SHOP_TIKTOK_SHOP } from "./ingest-raw";
import { TEST_USER_EMAIL, TEST_USER_PASSWORD } from "./test-constants";

/**
 * Smoke `/marketing` — 5 tab render, đổi tab GIỮ kỳ.
 * Neo bằng getByRole(link/heading) chứ KHÔNG `getByText(chuỗi ngắn).first()`: bẫy 22/08 — selector đó
 * khớp cả chú giải biểu đồ nên test vẫn xanh kể cả khi khối cần kiểm đã biến mất.
 */

async function login(page: Page): Promise<void> {
  await page.goto("/dang-nhap");
  await page.getByLabel("Email").fill(TEST_USER_EMAIL);
  await page.getByLabel("Mật khẩu", { exact: true }).fill(TEST_USER_PASSWORD);
  await page.getByRole("button", { name: "Đăng nhập" }).click();
  await expect(page).toHaveURL("/");
}

test.describe("Marketing smoke", () => {
  /**
   * Ép baseline TRƯỚC, không chỉ dọn SAU (bài học `datGiaVonDrawer`, `tests/e2e/views.spec.ts`):
   * describe "dữ liệu TikTok Shop Analytics thật" bên dưới land 3 bảng Bronze rồi dọn ở `afterAll` —
   * nhưng nếu một lượt trước bị NGẮT GIỮA CHỪNG (crash/Ctrl+C) thì `afterAll` đó không chạy, để lại
   * dữ liệu chưa dọn. Describe NÀY chạy TRƯỚC theo thứ tự khai báo (`workers:1`/`fullyParallel:false`)
   * và không tự dọn gì — nếu không ép sạch ở đây thì assertion "Chưa kết nối TikTok Shop Analytics"
   * bên dưới sẽ đỏ VĨNH VIỄN ở MỌI lượt chạy sau, không tự chữa được.
   */
  test.beforeAll(async () => {
    await resetRawTiktokShopAnalytics();
  });

  test.beforeEach(async ({ page }) => {
    await login(page);
  });

  test("5 tab có mặt, mặc định Tổng quan", async ({ page }) => {
    await page.goto("/marketing");
    // Topbar (`banner`, src/components/shell/topbar.tsx) VÀ nội dung trang đều render
    // `<h1>Marketing</h1>` ⇒ getByRole("heading") không scope sẽ vỡ strict mode (2 phần tử).
    // Neo vào `<main>` (src/components/shell/shell-chrome.tsx) để chỉ bắt heading trang.
    await expect(
      page.locator("main").getByRole("heading", { name: "Marketing", exact: true })
    ).toBeVisible();
    for (const t of ["Tổng quan", "Nội dung", "Creator", "Quảng cáo", "Sản phẩm"]) {
      // Scope vào <main>: sidebar nav cũng có link "Sản phẩm" (/san-pham) ⇒ strict mode vỡ trên CI (public run 32810428532).
      await expect(page.locator("main").getByRole("link", { name: t, exact: true })).toBeVisible();
    }
  });

  test("đổi tab giữ nguyên kỳ đang chọn", async ({ page }) => {
    await page.goto("/marketing?range=last_month");
    await page.getByRole("link", { name: "Quảng cáo", exact: true }).click();
    await expect(page).toHaveURL(/tab=quang-cao/);
    await expect(page).toHaveURL(/range=last_month/);
  });

  test("nav sidebar: mục Kênh đã đổi nhãn, mục Marketing có mặt", async ({ page }) => {
    await page.goto("/kenh");
    await expect(page.getByRole("link", { name: "Kênh", exact: true }).first()).toBeVisible();
    await expect(page.getByRole("link", { name: "Marketing", exact: true }).first()).toBeVisible();
  });

  test("tab Nội dung / Sản phẩm KHÔNG dính khối Pancake của Tổng quan", async ({ page }) => {
    // Hồi quy 25/08: nhánh `tong-quan` từng được viết bằng `else` gom, nên hai tab này hiện nguyên 3
    // khối Pancake (sai nội dung tab) + bắn 3 truy vấn cho một tab đáng lẽ chỉ là khu trống.
    for (const tab of ["noi-dung", "san-pham"]) {
      await page.goto(`/marketing?tab=${tab}`);
      // Neo bằng heading (getByRole) chứ không getByText chuỗi ngắn — bài học 22/08.
      await expect(page.getByRole("heading", { name: /Affiliate/ })).toHaveCount(0);
      // Ruling P2-R39: tên khối THẬT ở /cai-dat là "Kết nối & Đồng bộ" (chuỗi khớp `CHUA_KET_NOI_ANALYTICS`).
      await expect(
        page.getByText("Chưa kết nối TikTok Shop Analytics — xem Cài đặt → Kết nối & Đồng bộ")
      ).toBeVisible();
    }
  });

  test("số sàn có nhãn + tooltip đúng câu spec", async ({ page }) => {
    await page.goto("/marketing?tab=quang-cao");
    // Assert VÔ ĐIỀU KIỆN trước: nhánh `if` bên dưới chỉ chạy khi kỳ mặc định CÓ dòng sàn báo, nên
    // một mình nó là phép kiểm MÙ — chú thích nguồn biến mất khỏi tab vẫn xanh. Câu này luôn phải có.
    // Khớp bằng mảnh RIÊNG của câu TIKTOK_ADS trong `chu-thich-nguon.tsx`: đoạn đầu câu ("Chi tiêu lấy
    // từ Sổ chi phí…") trùng với chú thích chân BẢNG chiến dịch ⇒ locator ra 2 phần tử, vỡ strict mode.
    await expect(page.getByText(/Đơn\/GMV\/ROI lấy từ TikTok Ads — số sàn tự nhận công/)).toBeVisible();
    // `exact: true` để khớp ĐÚNG span nhãn trong `<SoSanBao>` (so-san-bao.tsx) — không exact sẽ ăn
    // luôn phụ đề tab ("… số do sàn báo, đặt cạnh số thật từ Pancake") chứa "sàn báo" như substring,
    // khiến `.first()` chọn nhầm phần tử không có attribute `title`.
    const nhan = page.getByText("sàn báo", { exact: true });
    // `count()` phải chạy trên locator GỐC (đếm được mọi badge), nhưng `toHaveAttribute` thì lấy
    // `.first()`: bảng có ≥2 cột số sàn ⇒ ≥2 badge ⇒ locator gốc vỡ strict mode và test đỏ oan.
    if (await nhan.count()) {
      await expect(nhan.first().locator("xpath=..")).toHaveAttribute(
        "title",
        /Số do TikTok tự nhận công.*doanh thu\/lãi thật xem ở Kênh \(Pancake\)/
      );
    }
  });

  test("tab Nội dung: có 2 bảng, tiêu đề đúng vai trò", async ({ page }) => {
    await page.goto("/marketing?tab=noi-dung");
    await expect(page.getByRole("heading", { name: "Video", exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Phiên live", exact: true })).toBeVisible();
  });

  test("tab Sản phẩm: segmented nguồn đổi được và GIỮ kỳ", async ({ page }) => {
    await page.goto("/marketing?tab=san-pham&range=last_month");
    await page.getByRole("link", { name: "Affiliate video", exact: true }).click();
    await expect(page).toHaveURL(/nguon=affiliate_video/);
    await expect(page).toHaveURL(/range=last_month/);
  });

  test("tab Tổng quan: khối nguồn doanh số có mặt", async ({ page }) => {
    await page.goto("/marketing");
    await expect(page.getByRole("heading", { name: "Nguồn doanh số (sàn báo)", exact: true })).toBeVisible();
  });

  test("tab Creator: trạng thái rỗng mới (P3) + khối Pancake đứng cạnh", async ({ page }) => {
    // Empty-state cũ "Cần scope Affiliate" đã GỠ (scope có từ 26/08). Kho affiliate được beforeAll
    // dọn SẠCH TOÀN BỘ ⇒ đây là ca "chưa có dữ liệu nào trong kho" — câu chữ KHÔNG được khẳng định
    // "kỳ này chưa có đơn" (review 28/08: chưa backfill / mất scope / nightly chết đều cho kho rỗng,
    // khẳng định sự thật kinh doanh lúc đó là nói sai).
    await page.goto("/marketing?tab=creator");
    await expect(page.getByText(/Chưa có dữ liệu affiliate nào trong kho/)).toBeVisible();
    await expect(page.getByText("Kỳ này chưa có đơn affiliate.")).toHaveCount(0);
    await expect(page.getByText("Cần scope Affiliate")).toHaveCount(0);
    await expect(
      page.locator("main").getByRole("heading", { name: "Affiliate / KOC theo kỳ — TikTok", exact: true })
    ).toBeVisible();
  });
});

/**
 * DỮ LIỆU THẬT (fix review Task 8, Việc #8) — 3 test trên chỉ xanh qua EMPTY-STATE: `KhuTrongMarketing`
 * render `<h2>{tieuDe}</h2>` nên `getByRole("heading", {name: "Video"})` khớp CẢ KHI bảng Video bị xoá
 * sạch (DB e2e không có analytics — không phép kiểm nào ở trên từng đi qua bảng thật). Land dữ liệu
 * qua ĐÚNG đường ingest thật (`postRawEnvelope`, không tự bịa shape — record lấy khuôn từ
 * `tests/fixtures/tiktokshop/analytics/*.json`), rồi assert vào thứ CHỈ tồn tại ở nhánh CÓ dữ liệu:
 * `getByRole("table")`, `columnheader`, một ô số thật.
 *
 * Kỳ CỐ Ý là ĐÚNG MỘT NGÀY (`tu=den=NGAY`, không phải tháng/kỳ rộng hơn): `mocSanSang` là mốc
 * TOÀN BẢNG (không lọc theo kỳ, xem `moc-du-lieu-san-sang.ts`), nên nếu kỳ query rộng hơn ngày đã
 * land thì `xepNgayTheoMoc` sẽ thấy những ngày KHÔNG có dòng ⇒ `soNgayThieu > 0` ⇒ mọi tổng bị null
 * hoá — bảng vẫn "có dữ liệu" (mocSanSang không null) nhưng mọi ô số lại là "—", phá đúng thứ test
 * này cần thấy.
 *
 * `beforeAll`/`afterAll` dọn RIÊNG 4 bảng Bronze TikTok Shop Analytics (append-only trong PROD,
 * nhưng DB e2e dùng chung suốt lượt chạy) — land rồi không dọn sẽ làm `mocSanSang` hết còn `null`,
 * phá vĩnh viễn 2 test "Chưa kết nối TikTok Shop Analytics" ở describe block phía trên (chạy TRƯỚC
 * describe này theo thứ tự khai báo, `workers:1`/`fullyParallel:false` — nhưng `afterAll` vẫn phải
 * dọn sạch để LƯỢT KẾ TIẾP của toàn bộ `npm run test:e2e` không kế thừa dữ liệu của lượt này).
 */
test.describe("Marketing — dữ liệu TikTok Shop Analytics thật (đường ingest thật)", () => {
  const NGAY = "2026-01-15";
  const KY_QS = `tu=${NGAY}&den=${NGAY}`;
  // Một ngày SAU ngày đã land — không seed gì cho ngày này, để `soNgayChuaSanSang > 0` và câu
  // ĐỘ TƯƠI thật sự render (xem test "câu độ tươi hiện đúng" bên dưới, ruling P2-R42).
  const NGAY_SAU = "2026-01-16";

  const ENVELOPE_SHOP = {
    code: 0,
    message: "Success",
    data: {
      latest_available_date: NGAY,
      performance: {
        intervals: [
          {
            start_date: NGAY,
            end_date: "2026-01-16",
            traffic: { avg_visitors: 120, avg_page_views: 340 },
            sales: { orders_count: 6, gmv: { overall: { amount: "1800000.00", currency: "VND" } } },
          },
        ],
      },
    },
  };

  const ENVELOPE_PRODUCTS = {
    code: 0,
    message: "Success",
    data: {
      latest_available_date: NGAY,
      products: [
        {
          id: "E2E-SP-1",
          total_performance: {
            gmv: { amount: "950000.00", currency: "VND" },
            orders: 4,
            product_impressions: 500,
            product_clicks: 60,
            add_cart_count: 20,
          },
        },
      ],
    },
  };

  const ENVELOPE_VIDEOS = {
    code: 0,
    message: "Success",
    data: {
      latest_available_date: NGAY,
      videos: [
        {
          id: "E2E-VID-1",
          title: "Video test E2E marketing",
          username: "shop_hogikids",
          creator: { author_type: "OFFICIAL_ACCOUNTS", user_name: "shop_hogikids" },
          video_post_time: "2026-01-15 10:00:00",
          views: 1000,
          sku_orders: 5,
          gmv: { amount: "700000.00", currency: "VND" },
          click_through_rate: "0.1200",
          products: [],
        },
      ],
    },
  };

  /**
   * Envelope affiliate ĐÃ LÀM PHẲNG — đúng shape workflow gửi cho app (mỗi dòng SKU một record,
   * 4 trường `_don_id`/`_create_time`/`_delivery_time`/`_ngay` bơm sẵn; khuôn field lấy từ
   * `tests/fixtures/tiktokshop/affiliate/orders-search.json`, không tự bịa).
   * `_create_time` 1768446000 = 2026-01-15 10:00 giờ VN ⇒ `_ngay` = NGAY (khớp kỳ KY_QS).
   * `actual_paid_commission = {}` CÓ CHỦ ĐÍCH: ô "HH đã trả" phải là "—" (sàn không báo), đứng cạnh
   * ô ước tính 14.720 ₫ — đúng cặp mặt chữ mà tab này sinh ra để phân biệt.
   * Dòng thứ hai (creator RIÊNG `e2e_creator_2`, `settlement_status: "To-SETTLE"`) nối UI↔helper cho nhánh
   * fail-open "đang chờ sàn chốt" — review 30/08: chỉ có fixture SETTLED thì drawer hardcode "đã chốt" vẫn xanh.
   * Creator riêng để các ô của `e2e_creator_1` (GMV 204.700, "—" duy nhất) không đổi; `actual_paid_commission`
   * = 0 tường minh để KHÔNG đẻ thêm ô "—" (assert bảng dùng `exact: true` strict mode).
   */
  const ENVELOPE_AFFILIATE = {
    code: 0,
    message: "Success",
    data: {
      total_count: 2,
      next_page_token: "",
      orders: [
        {
          _don_id: "900000000000000001",
          _create_time: 1768446000,
          _delivery_time: 1768532400,
          _ngay: NGAY,
          sku_id: "900000000000000101",
          product_id: "900000000000000201",
          quantity: 1,
          price: { amount: "204700", currency: "VND" },
          content_type: "VIDEO",
          content_id: "900000000000000301",
          creator_username: "e2e_creator_1",
          open_collaboration_id: "900000000401",
          estimated_paid_commission: { amount: "14720", currency: "VND" },
          actual_paid_commission: {},
          settlement_status: "SETTLED",
          fully_return: "No",
        },
        {
          _don_id: "900000000000000002",
          _create_time: 1768446000,
          _delivery_time: 1768532400,
          _ngay: NGAY,
          sku_id: "900000000000000102",
          product_id: "900000000000000202",
          quantity: 1,
          price: { amount: "99000", currency: "VND" },
          content_type: "LIVE",
          content_id: "900000000000000302",
          creator_username: "e2e_creator_2",
          open_collaboration_id: "900000000402",
          estimated_paid_commission: { amount: "5000", currency: "VND" },
          actual_paid_commission: { amount: "0", currency: "VND" },
          settlement_status: "To-SETTLE",
          fully_return: "No",
        },
      ],
    },
  };

  test.beforeAll(async () => {
    await resetRawTiktokShopAnalytics();
    const shop = await postRawEnvelope("tiktok/analytics_shop", SHOP_TIKTOK_SHOP, ENVELOPE_SHOP);
    expect(shop.ok, `land analytics_shop: ${shop.text}`).toBe(true);
    const products = await postRawEnvelope("tiktok/analytics_products", SHOP_TIKTOK_SHOP, ENVELOPE_PRODUCTS, {
      ngay: NGAY,
    });
    expect(products.ok, `land analytics_products: ${products.text}`).toBe(true);
    const videos = await postRawEnvelope("tiktok/analytics_videos", SHOP_TIKTOK_SHOP, ENVELOPE_VIDEOS, {
      ngay: NGAY,
    });
    expect(videos.ok, `land analytics_videos: ${videos.text}`).toBe(true);
    const affiliate = await postRawEnvelope("tiktok/affiliate_orders", SHOP_TIKTOK_SHOP, ENVELOPE_AFFILIATE);
    expect(affiliate.ok, `land affiliate_orders: ${affiliate.text}`).toBe(true);
  });

  test.afterAll(async () => {
    await resetRawTiktokShopAnalytics();
  });

  test.beforeEach(async ({ page }) => {
    await login(page);
  });

  test("tab Tổng quan: nhãn 'Tổng theo sản phẩm (sàn)' — hồi quy Việc 1 (nhãn từng là mã chết)", async ({
    page,
  }) => {
    await page.goto(`/marketing?tab=tong-quan&${KY_QS}`);
    // Nhãn ĐÚNG phải hiện — trước khi vá, code đổi nhãn nằm trong nhánh `!gopChong` nên KHÔNG BAO
    // GIỜ chạy tới dòng `total` (nó có `gopChong:true`), và nhãn cũ "Tổng (sàn)" vẫn đứng nguyên.
    // KHÔNG `exact:true` ở đây: dòng `total` có `gopChong:true` nên span nhãn còn mang thêm badge
    // "(gộp — chồng…)" + ghi chú làm CON của cùng span — text ĐẦY ĐỦ của span đó không còn khớp
    // tuyệt đối chuỗi nhãn, nhưng đây là span DUY NHẤT chứa chuỗi này (không span con nào khác chứa
    // lại nó) nên phép so KHÔNG exact vẫn quy về đúng MỘT phần tử, không vỡ strict mode.
    await expect(page.locator("main").getByText("Tổng theo sản phẩm (sàn)")).toBeVisible();
    // Assertion "nhãn CŨ đã biến mất" từng đứng ở đây (`getByText("Tổng (sàn)", {exact:true})
    // toHaveCount(0)`) — BỎ: dòng `total` LUÔN mang badge "(gộp — chồng…)" làm span con (từ
    // `gopChong: true`, độc lập với bug nhãn), nên text ĐẦY ĐỦ của span không bao giờ khớp tuyệt đối
    // "Tổng (sàn)" — kể cả khi bug tái phát (nhãn rơi về "Tổng (sàn)" cũ). Phép kiểm RỖNG: luôn có
    // count 0 dù bug còn hay đã vá. Assertion dòng trên (nhãn ĐÚNG có mặt) đã đủ chứng minh hồi quy.
  });

  test("tab Sản phẩm: bảng CÓ dữ liệu thật (không phải khu trống 'Chưa kết nối')", async ({ page }) => {
    await page.goto(`/marketing?tab=san-pham&${KY_QS}`);
    await expect(page.getByRole("table")).toBeVisible();
    await expect(page.getByRole("columnheader", { name: "GMV" })).toBeVisible();
    // `Product.code` không khớp ⇒ `ten` rơi về chính id — ô CÓ THẬT trong bảng, không phải suy diễn.
    await expect(page.getByRole("cell", { name: "E2E-SP-1" })).toBeVisible();
    // Ô SỐ THẬT (Việc #8 hồi quy — bảng có thể "— hết bảng" mà 3 assertion trên vẫn xanh, vì chúng
    // không chạm số nào): GMV khối `total_performance` fixture = 950000 → `formatVnd` = "950.000 ₫".
    // Chuỗi dài + có ký hiệu tiền — không lo trùng chuỗi ngắn ở nơi khác trên trang.
    await expect(page.getByRole("cell", { name: "950.000 ₫" })).toBeVisible();
  });

  test("tab Nội dung: bảng Video CÓ dòng thật (không chỉ tiêu đề rỗng)", async ({ page }) => {
    await page.goto(`/marketing?tab=noi-dung&${KY_QS}`);
    // `getByRole("table")` không scope vẫn AN TOÀN ở đây: bảng "Phiên live" cạnh bên KHÔNG land dữ
    // liệu (`tiktok/analytics_lives`) ⇒ rơi nhánh rỗng render `<p>`, không phải `<table>` — chỉ bảng
    // Video có `<table>` trên trang này, nên vẫn ĐÚNG MỘT phần tử khớp (không vỡ strict mode).
    await expect(page.getByRole("table")).toBeVisible();
    await expect(page.getByRole("cell", { name: "Video test E2E marketing" })).toBeVisible();
    // Ô SỐ THẬT (cùng lý do đã thêm ở test tab Sản phẩm): "Lượt xem" fixture = 1000 → soGon = "1.000".
    // KHÔNG chọn cột GMV/GPM ở đây — fixture 700000÷1000×1000 = 700000 làm HAI cột đó ra CÙNG một
    // chuỗi "700.000 ₫", `getByRole` sẽ khớp 2 phần tử và vỡ strict mode.
    await expect(page.getByRole("cell", { name: "1.000" })).toBeVisible();
  });

  /**
   * Ruling P2-R42 mục 4: `KY_QS` (tu=den=NGAY) trùng đúng ngày đã land ⇒ `soNgayChuaSanSang = 0` ⇒
   * `ChuThichDoTuoiVaThieu` không bao giờ render câu #1 trong suốt bộ e2e — bug ở chính câu chữ đó
   * (vd sai `mocSanSang`/lệch stream) sẽ không một test nào bắt được. Mở kỳ tới `NGAY_SAU` (chưa land
   * gì) để `soNgayChuaSanSang = 1` và câu thật sự render.
   *
   * CÂU NÀO RENDER phụ thuộc "hôm nay" (đã cân nhắc — xem cảnh báo "test thối theo thời gian" ở B5):
   * `NGAY` cố định 2026-01-15 trong khi "hôm nay" là giờ thực khi test chạy. Backstop 7 ngày
   * (`cau-do-tuoi-du-lieu.ts`) so `mocSanSang` với "hôm nay − 7 ngày" — một khi "hôm nay" đã qua
   * ~22/01/2026 (đúng NGAY một lần, KHÔNG lặp lại: mọi lượt chạy sau đó mãi mãi ở phía "quá xa"), so
   * sánh này CHỈ CÓ THỂ ngả về nhánh "App chưa kéo được dữ liệu mới" — ổn định vĩnh viễn về sau, không
   * "tự đổi màu" thêm lần nào nữa (khác câu "Sàn mới có số tới ngày X" — câu đó cần `mocSanSang` mới
   * hơn "hôm nay − 7 ngày", không đạt được với fixture ngày cố định này).
   */
  test("tab Creator: bảng CÓ dòng thật, {} ra '—' cạnh 14.720 ₫, click mở drawer", async ({ page }) => {
    await page.goto(`/marketing?tab=creator&${KY_QS}`);
    // Tab creator chỉ có MỘT <table> (khối Pancake cạnh bên là grid ô số, không phải bảng).
    await expect(page.getByRole("table")).toBeVisible();
    await expect(page.getByRole("columnheader", { name: "HH ước tính" })).toBeVisible();
    await expect(page.getByRole("columnheader", { name: "HH đã trả" })).toBeVisible();
    // Ô SỐ THẬT: GMV = 204.700 × 1 và HH ước tính = 14.720 (formatVnd, kèm nhãn "sàn báo" trong ô).
    await expect(page.getByRole("cell", { name: "204.700 ₫" })).toBeVisible();
    await expect(page.getByRole("cell", { name: "14.720 ₫" })).toBeVisible();
    // 🔑 Mặt chữ null ≠ 0 (review 28/08 — trước đây KHÔNG có assertion nào cho dấu "—", đổi
    // `tienSan` trả "0 ₫" cho null là mọi test vẫn xanh): `actual_paid_commission: {}` + không có
    // bucket shop_ads ⇒ ô "HH đã trả" PHẢI là "—". Fixture 1 dòng nên "—" quy về đúng MỘT ô
    // (các cột % ra "100.0%"/"0.0%", cột Hoàn/KĐK ra "0 / 0" — không ô nào khác là "—").
    await expect(page.getByRole("cell", { name: "—", exact: true })).toBeVisible();
    // Phương án B (30/08): dòng `e2e_creator_2` (To-SETTLE, actual 0) ⇒ ô "HH đã trả" = "0 ₫ sàn báo" + chú thích
    // "1 dòng chờ" ngay trong ô; dòng `e2e_creator_1` (SETTLED) KHÔNG có chú thích nên ô "—" ở trên vẫn exact.
    // Tên ô gộp cả chú thích ⇒ `exact` bắt được cả hai điều: có chú thích, và đúng số 1.
    await expect(page.getByRole("cell", { name: "0 ₫ sàn báo 1 dòng chờ", exact: true })).toBeVisible();
    await expect(page.getByRole("cell", { name: "— 1 dòng chờ", exact: true })).toHaveCount(0);

    // Nhấn dòng (link tên creator) ⇒ drawer đơn cấp SKU mở qua `?creator=` (cơ chế `?don=` của /don-hang).
    await page.getByRole("link", { name: "e2e_creator_1" }).click();
    await expect(page).toHaveURL(/creator=e2e_creator_1/);
    await expect(page.getByRole("heading", { name: "Đơn affiliate — e2e_creator_1" })).toBeVisible();
    await expect(page.getByRole("cell", { name: "900000000000000001" })).toBeVisible();
    // Từ 30/08: cột "Trạng thái" hiện nhãn Việt, KHÔNG in chuỗi sàn; fixture `settlement_status:
    // "SETTLED"` ⇒ "đã chốt", chuỗi gốc chỉ còn trong `title` của ô (bằng chứng không mất).
    const oTrangThai = page.getByRole("cell", { name: "đã chốt", exact: true });
    await expect(oTrangThai).toBeVisible();
    await expect(oTrangThai).toHaveAttribute("title", "Sàn báo: SETTLED");
    await expect(page.getByRole("cell", { name: "SETTLED", exact: true })).toHaveCount(0);
  });

  test("tab Creator: drawer mở thẳng bằng ?creator= — trạng thái CHỜ ra nhãn fail-open, chuỗi sàn chỉ còn trong title", async ({
    page,
  }) => {
    // `To-SETTLE` là trạng thái chờ THẬT đo trên prod 28–30/08; helper không liệt kê nó — mọi thứ ngoài
    // SETTLED/INELIGIBLE đều phải ra "đang chờ sàn chốt". Đây là phép kiểm nối UI↔helper cho nhánh fail-open.
    await page.goto(`/marketing?tab=creator&${KY_QS}&creator=e2e_creator_2`);
    await expect(page.getByRole("heading", { name: "Đơn affiliate — e2e_creator_2" })).toBeVisible();
    await expect(page.getByRole("cell", { name: "900000000000000002" })).toBeVisible();
    const oCho = page.getByRole("cell", { name: "đang chờ sàn chốt", exact: true });
    await expect(oCho).toBeVisible();
    await expect(oCho).toHaveAttribute("title", "Sàn báo: To-SETTLE");
    await expect(page.getByRole("cell", { name: "To-SETTLE", exact: true })).toHaveCount(0);
    // "HH đã trả" 0 ₫ tường minh ≠ "—": dòng chờ vẫn giữ đúng mặt chữ của khoản sàn báo 0. Giới hạn trong
    // dialog + `exact` (tên ô gồm nhãn "sàn báo"): bảng creator phía sau cũng có ô 0 ₫, và "0 ₫" không exact
    // còn khớp cả "5.000 ₫" (substring) — bẫy strict mode đã cắn ở lượt chạy đầu.
    await expect(page.getByRole("dialog").getByRole("cell", { name: "0 ₫ sàn báo", exact: true })).toBeVisible();
  });

  test("tab Sản phẩm: câu độ tươi hiện đúng khi kỳ vượt mốc dữ liệu", async ({ page }) => {
    await page.goto(`/marketing?tab=san-pham&tu=${NGAY}&den=${NGAY_SAU}`);
    await expect(
      page.getByText("App chưa kéo được dữ liệu mới — kiểm lượt đồng bộ đêm (Cài đặt → Kết nối & Đồng bộ).")
    ).toBeVisible();
  });
});
