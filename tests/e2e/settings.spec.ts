import { expect, test, type Page } from "@playwright/test";
import { format } from "date-fns";

import { ingestPancake, resetRawPancake, testPrisma, type IngestInput } from "./ingest-raw";
import { TEST_USER_EMAIL, TEST_USER_PASSWORD } from "./test-constants";

/**
 * E2E màn Cài đặt (Phase 6 Task 8) — 3 mục theo task brief:
 *  1. Đổi tên shop → sidebar cập nhật ngay (khôi phục tên gốc cuối test — spec repeatable).
 *  2. Đổi ngưỡng tồn mặc định → biến thể vượt ngưỡng hiện badge "Sắp hết" ở /ton-kho
 *     (khôi phục ngưỡng gốc cuối test).
 *  3. Dialog "Xóa dữ liệu giao dịch" bước 2 gõ SAI tên shop → nút "Xóa vĩnh viễn" vẫn khoá.
 *     TUYỆT ĐỐI không xác nhận xóa thật.
 *
 * Chạy SERIAL: test 1 đổi `shopName` (dialog xóa dữ liệu giao dịch đọc `shopName` hiện tại để so khớp
 * xác nhận) và test 2 đổi ngưỡng tồn MẶC ĐỊNH (ảnh hưởng badge của MỌI SKU chưa có ngưỡng
 * riêng) — cả hai là state TOÀN CỤC, chạy song song trong cùng file sẽ đá nhau.
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

test.describe("Cài đặt", () => {
  // Bronze dedupe theo hash payload: raw sót từ lần chạy trước ⇒ land 0 ⇒ transform không chạy.
  test.beforeAll(async () => {
    await resetRawPancake();
  });

  test.beforeEach(async ({ page }) => {
    await login(page);
  });

  test("Section 1 — đổi tên shop → khối user cuối sidebar cập nhật ngay", async ({ page }) => {
    await page.goto("/cai-dat");
    const nameInput = page.locator("#shop-name-input");
    const originalName = await nameInput.inputValue();
    const newName = `AC-Settings-Shop-${Date.now()}`;

    async function saveShopName(name: string) {
      await page.goto("/cai-dat");
      await page.locator("#shop-name-input").fill(name);
      await page.getByRole("button", { name: "Lưu thông tin" }).click();
      await expect(page.getByText("Đã lưu thông tin shop")).toBeVisible();
    }

    // Khối tài khoản cuối thanh bên là `button`, còn tên thương hiệu ở đầu là `link`. PHẢI lọc theo
    // vai trò: bắt chữ trong cả `<aside>` thì khi tên shop TRÙNG tên thương hiệu ("HogiKids") sẽ có
    // 2 phần tử cùng khớp ⇒ locator mơ hồ ⇒ đỏ, và vì nhóm này chạy tuần tự nên các test sau bị bỏ
    // theo. Tên shop mặc định đúng bằng tên thương hiệu nên bẫy này bật đúng lúc state đã sạch.
    const khoiUser = (name: string) =>
      page.locator("aside").getByRole("button").filter({ hasText: name });

    await saveShopName(newName);
    // Khối user cuối sidebar (desktop `<aside>`) đọc `User.shopName` qua `(app)/layout.tsx` —
    // action `updateShopInfo` gọi `revalidatePath("/", "layout")` nên đổi ngay, không cần F5.
    await expect(khoiUser(newName)).toBeVisible();

    // Khôi phục tên gốc — spec chạy lại nhiều lần không lệch state.
    await saveShopName(originalName);
    await expect(khoiUser(originalName)).toBeVisible();
  });

  test("Section 4 — đổi ngưỡng tồn mặc định → SKU vượt ngưỡng hiện badge Sắp hết ở /ton-kho", async ({ page }) => {
    const stamp = Date.now();
    const sku = `SET4-SKU-${stamp}`;
    const stock = 10; // cố định giữa 2 ngưỡng test (thấp=0 < 10 < cao=20)

    await postIngest({
      products: [
        {
          id: `SET4-P-${stamp}`,
          name: "SET4 Product",
          variations: [
            { id: `SET4-V-${stamp}`, display_id: sku, retail_price: 50000, remain_quantity: stock, average_imported_price: 20000 },
          ],
        },
      ],
      orders: [],
    });

    await page.goto("/cai-dat");
    const thresholdInput = page.locator("#stock-threshold-input");
    const originalThreshold = await thresholdInput.inputValue();

    async function setThreshold(value: string) {
      await page.goto("/cai-dat");
      await page.locator("#stock-threshold-input").fill(value);
      await page.getByRole("button", { name: "Lưu ngưỡng" }).click();
      await expect(page.getByText("Đã cập nhật ngưỡng cảnh báo tồn")).toBeVisible();
    }

    // Ngưỡng THẤP (0) < tồn SKU (10) → SKU CHƯA "Sắp hết".
    await setThreshold("0");
    await page.goto(`/ton-kho?q=${sku}`);
    await expect(page.locator("tbody tr").filter({ hasText: sku })).not.toContainText("Sắp hết");

    // Ngưỡng CAO (20) > tồn SKU (10) → SKU giờ VƯỢT ngưỡng → hiện "Sắp hết".
    await setThreshold("20");
    await page.goto(`/ton-kho?q=${sku}`);
    await expect(page.locator("tbody tr").filter({ hasText: sku })).toContainText("Sắp hết");

    // Khôi phục ngưỡng gốc — spec chạy lại nhiều lần không lệch state toàn cục.
    await setThreshold(originalThreshold || "5");
  });

  test('Dialog "Xóa dữ liệu giao dịch" — gõ SAI tên shop → nút "Xóa vĩnh viễn" vẫn khoá (KHÔNG xóa thật)', async ({
    page,
  }) => {
    await page.goto("/cai-dat");
    await page.getByRole("button", { name: "Xóa dữ liệu giao dịch" }).click();
    const dialog = page.getByRole("dialog");

    // Cực hiếm: DB hoàn toàn sạch (chưa spec nào seed đơn/chi phí) → dialog chỉ hiện
    // "Không có dữ liệu để xóa", không có bước 2 để kiểm — seed tối thiểu 1 đơn rồi mở lại.
    if (await dialog.getByText("Không có dữ liệu để xóa").count()) {
      await page.keyboard.press("Escape");
      const stamp = Date.now();
      const sku = `SET-DEL-GUARD-${stamp}`;
      await postIngest({
        products: [
          {
            id: `SET-DEL-GUARD-P-${stamp}`,
            name: "Seed guard xóa toàn bộ",
            variations: [{ id: `SET-DEL-GUARD-V-${stamp}`, display_id: sku, retail_price: 10000, remain_quantity: 1, average_imported_price: 5000 }],
          },
        ],
        orders: [
          {
            id: `SET-DEL-GUARD-ORD-${stamp}`,
            status: 3,
            inserted_at: `${TODAY}T08:00:00.000000`,
            order_sources_name: "Shopee",
            marketplace_id: "-3",
            total_price: 10000,
            total_discount: 0,
            fee_marketplace: 1000,
            items: [{ quantity: 1, discount_each_product: 0, variation_info: { display_id: sku, name: "Seed guard", retail_price: 10000 } }],
          },
        ],
      });
      await page.goto("/cai-dat");
      await page.getByRole("button", { name: "Xóa dữ liệu giao dịch" }).click();
    }

    await expect(dialog.getByText("Xóa dữ liệu giao dịch")).toBeVisible();
    // Hợp đồng (a+): giữ giá vốn nhập tay + kho thô, xoá thêm 4 bảng "Tiền đã về" — bám điểm ổn
    // định (mục liệt kê), không bám câu chữ mô tả có thể đổi mà hành vi thật không đổi. Phải lọc
    // theo <li>: cụm "Tiền đã về" còn xuất hiện ở câu hướng dẫn dựng lại → getByText khớp 2 chỗ.
    const mucTienDaVe = dialog.locator("li").filter({ hasText: "Tiền đã về" });
    await expect(mucTienDaVe).toHaveCount(1);
    await expect(mucTienDaVe).toBeVisible();
    await expect(dialog.locator("li").filter({ hasText: "giá vốn" })).toHaveCount(0);
    await dialog.getByRole("button", { name: "Tiếp tục" }).click();
    // Dùng role heading (không phải getByText) — DialogDescription bước 2 cũng chứa cụm
    // "xác nhận xóa" (không phân biệt hoa/thường trong khớp text của Playwright) → 2 khớp.
    await expect(dialog.getByRole("heading", { name: "Xác nhận xóa" })).toBeVisible();

    await dialog.getByLabel("Tên shop xác nhận").fill("Ten-Sai-Chac-Chan-Khong-Khop-123");
    await expect(dialog.getByRole("button", { name: "Xóa vĩnh viễn" })).toBeDisabled();

    // Đóng dialog — KHÔNG xác nhận xóa thật (invariant: dữ liệu các spec khác phải còn nguyên).
    await page.keyboard.press("Escape");
    await expect(dialog).not.toBeVisible();
  });

  /**
   * Khối "Hạn kết nối": token Meta KHÔNG gia hạn tự động được nên chủ shop phải cấp lại trước hạn.
   * Cảnh báo của workflow nằm trong log n8n — chủ shop không mở n8n, nên đây mới là chỗ họ nhìn thấy.
   * DB test không có mốc hạn ⇒ mong đợi trạng thái "Chưa có mốc", KHÔNG được hiện "hết hạn" (báo nhầm
   * hết hạn khi chỉ là thiếu dữ liệu sẽ làm người đọc quen tay bỏ qua cảnh báo thật).
   */
  test("Section 5 — khối Hạn kết nối liệt kê đủ token, thiếu mốc thì báo 'Chưa có mốc' chứ không báo hết hạn", async ({
    page,
  }) => {
    await page.goto("/cai-dat");
    const khoi = page.locator("section#ket-noi");
    await expect(khoi.getByRole("heading", { name: "Hạn kết nối" })).toBeVisible();

    for (const ten of [
      "Token quảng cáo Facebook",
      "Quyền đọc dữ liệu Facebook",
      "Token TikTok Shop",
      "Khoá gia hạn TikTok Shop",
    ]) {
      await expect(khoi.getByText(ten, { exact: true })).toBeVisible();
    }

    await expect(khoi.getByText("Chưa có mốc").first()).toBeVisible();
    await expect(khoi.getByText("ĐÃ HẾT HẠN")).toHaveCount(0);
    // Token máy tự lo phải nói rõ là không cần làm gì, để không ai đi cấp lại token thừa.
    await expect(khoi.getByText(/Máy tự gia hạn/).first()).toBeVisible();
  });

  /**
   * Khối "Webhook Pancake": app chỉ xử lý các LOẠI sự kiện đã đo đạc (đơn hàng, tồn kho kho) —
   * loại lạ phải hiện lên đây để còn vào fix, không được nuốt im lặng. DB test chưa có sự kiện nào
   * ⇒ mong đợi trạng thái rỗng nói rõ "chưa nhận", KHÔNG được im lìm (im lìm thì không phân biệt
   * được "webhook chết" với "webhook chạy tốt mà không có việc").
   */
  test("Section 5 — khối Webhook Pancake nói rõ khi chưa nhận sự kiện nào", async ({ page }) => {
    await page.goto("/cai-dat");
    const khoi = page.locator("section#ket-noi");

    await expect(khoi.getByRole("heading", { name: "Webhook Pancake (7 ngày)" })).toBeVisible();
    await expect(khoi.getByText("Chưa nhận sự kiện nào")).toBeVisible();
    await expect(khoi.getByText("Sự kiện app chưa hiểu — cần vào fix:")).toHaveCount(0);
  });

  /**
   * Khối "Đơn chưa vào Sổ": đơn kẹt giữa "land kho thô" và "ghi Sổ" (tiến trình chết giữa chừng, hoặc
   * payload không map được) phải hiện lên đây để chủ shop vào xử lý — nếu không, đơn mất doanh thu âm
   * thầm dưới log xanh. Trạng thái sạch thì khối ẩn hẳn (đỡ nhiễu). Land một đơn có inserted_at KHÔNG
   * parse được ngày → transform đóng dấu FAILED_SHAPE ngay lượt đầu (lỗi dữ liệu tất định), khối hiện
   * đúng badge + shop + mã đơn + ghi chú lý do.
   */
  test("Section 5 — khối Đơn chưa vào Sổ: sạch thì ẩn, có đơn hỏng shape thì hiện đủ badge/shop/mã/ghi chú", async ({
    page,
  }) => {
    const BACKLOG_KEY = "bronzeBacklogPending";
    const stamp = Date.now();
    const maDon = `SET-BADSHAPE-ORD-${stamp}`;
    const prisma = testPrisma();
    // Đơn hỏng shape làm route thật gọi markBronzeBacklog() (distinctLanded > accounted). DB E2E dùng
    // chung nên PHẢI trả trạng thái về y nguyên: chụp cờ TRƯỚC test, khôi phục trong finally (kể cả khi
    // assert đỏ) — nếu không banner backlog dính sang spec/lượt chạy sau và raw hỏng cũng còn lại.
    const coTruoc = await prisma.setting.findUnique({ where: { key: BACKLOG_KEY } });
    try {
      // Chưa có đơn hỏng shape / tồn đọng → khối ẩn hẳn (các spec trước chỉ seed đơn hợp lệ = APPLIED).
      await page.goto("/cai-dat");
      await expect(page.getByRole("heading", { name: "Đơn chưa vào Sổ" })).toHaveCount(0);

      await postIngest({
        orders: [
          {
            id: maDon,
            status: 3,
            inserted_at: "khong-phai-ngay-hop-le", // qua được zod (chuỗi không rỗng), hỏng ở parseVnDate
            order_sources_name: "Shopee",
            marketplace_id: "-3",
            total_price: 10000,
            total_discount: 0,
            fee_marketplace: 1000,
            items: [{ quantity: 1, discount_each_product: 0, variation_info: { display_id: `SET-BADSHAPE-SKU-${stamp}`, name: "x", retail_price: 10000 } }],
          },
        ],
      });

      await page.goto("/cai-dat");
      const khoi = page.locator("section#ket-noi");
      await expect(khoi.getByRole("heading", { name: "Đơn chưa vào Sổ" })).toBeVisible();
      await expect(khoi.getByText("1 đơn cần xem")).toBeVisible();
      // Một span gói cả shop + mã đơn + ghi chú lý do — bám cùng dòng để chắc đúng đơn này.
      const dongChinh = khoi.locator("span").filter({ hasText: maDon });
      await expect(dongChinh).toContainText("Shopee");
      await expect(dongChinh).toContainText("ngày giờ không hợp lệ");
    } finally {
      // Xoá đơn hỏng shape + khôi phục cờ backlog về ĐÚNG giá trị trước test (không có dòng ⇒ xoá dòng).
      await prisma.rawPancakeOrder.deleteMany({ where: { externalId: maDon } });
      if (coTruoc) {
        await prisma.setting.update({ where: { key: BACKLOG_KEY }, data: { value: coTruoc.value } });
      } else {
        await prisma.setting.deleteMany({ where: { key: BACKLOG_KEY } });
      }
      await prisma.$disconnect();
    }
  });

  /**
   * Khối "Khóa kết nối nguồn dữ liệu": chủ shop tự dán khóa ngay trên web. Bất biến CHỈ-GHI:
   * lưu xong trang chỉ được hiện đuôi 4 ký tự — giá trị đầy đủ TUYỆT ĐỐI không quay lại trình
   * duyệt (soi cả HTML trang sau reload). DB E2E dùng chung ⇒ khôi phục key về y nguyên trong finally.
   */
  test("Section 5 — Khóa kết nối: đủ 4 nguồn, lưu khóa bí mật chỉ hiện đuôi 4 ký tự", async ({ page }) => {
    const KHOA_KEY = "pancakeApiKeyKho";
    const giaTri = `E2E-PAN-KHO-${Date.now()}`;
    const prisma = testPrisma();
    const coTruoc = await prisma.setting.findUnique({ where: { key: KHOA_KEY } });
    try {
      await page.goto("/cai-dat");
      const khoi = page.locator("section#ket-noi");
      await expect(khoi.getByRole("heading", { name: "Khóa kết nối nguồn dữ liệu" })).toBeVisible();
      for (const ten of ["Pancake POS", "Meta Ads (Facebook)", "TikTok Shop", "TikTok Ads (Business)"]) {
        await expect(khoi.getByRole("heading", { name: ten })).toBeVisible();
      }

      // Thẻ dạng gấp/mở: đảm bảo Pancake ĐANG MỞ trước khi đụng vào thân thẻ (thẻ đủ khóa
      // tự gấp — click header để bung; thẻ thiếu khóa đã mở sẵn thì không click kẻo gấp lại).
      const thePancake = khoi
        .locator("div.rounded-lg.border")
        .filter({ has: page.getByRole("heading", { name: "Pancake POS" }) });
      const oKhoaKho = page.locator(`#khoa-${KHOA_KEY}`);
      if (!(await oKhoaKho.isVisible())) {
        await thePancake.getByRole("button", { name: /Pancake POS/ }).click();
        await expect(oKhoaKho).toBeVisible();
      }

      // Khối webhook nằm trong thân thẻ Pancake: đủ URL để dán lại vào Pancake khi mất cấu hình.
      await expect(khoi.getByText("Webhook (sự kiện realtime từ Pancake)")).toBeVisible();
      await expect(khoi.getByText("https://n8n.example.com/webhook/pancake-pos-hogikids1")).toBeVisible();

      // Lưu một khóa bí mật của thẻ Pancake — nút "Lưu khóa" chỉ mở khi có ô đã gõ.
      const nutLuu = thePancake.getByRole("button", { name: "Lưu khóa" });
      await expect(nutLuu).toBeDisabled();
      await page.locator(`#khoa-${KHOA_KEY}`).fill(giaTri);
      await nutLuu.click();
      await expect(page.getByText("Đã lưu 1 khóa của Pancake POS")).toBeVisible();

      // Reload: trạng thái đã che — có đuôi 4 ký tự, còn giá trị đầy đủ không nằm ĐÂU trong HTML.
      await page.goto("/cai-dat");
      await expect(khoi.getByText(`đuôi …${giaTri.slice(-4)}`).first()).toBeVisible();
      expect(await page.content()).not.toContain(giaTri);
    } finally {
      if (coTruoc) {
        await prisma.setting.update({ where: { key: KHOA_KEY }, data: { value: coTruoc.value } });
      } else {
        await prisma.setting.deleteMany({ where: { key: KHOA_KEY } });
      }
      await prisma.$disconnect();
    }
  });
});
