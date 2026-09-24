import { expect, test, type Page } from "@playwright/test";

import { KEY_QUY_TOI_THIEU } from "@/lib/so-quy/du-bao-quy-queries";

import { testPrisma } from "./ingest-raw";
import { TEST_USER_EMAIL, TEST_USER_PASSWORD } from "./test-constants";

/**
 * E2E dự báo quỹ 30 ngày + cảnh báo "sắp cạn" — tab `/tai-chinh?tab=so-quy` + banner toàn app
 * (`docCanhBaoSapCan` ở `(app)/layout.tsx`).
 *
 * Ngưỡng `Setting` (`soQuyQuyToiThieu`) là state TOÀN CỤC dùng chung với mọi spec khác đọc tab Sổ
 * quỹ — chụp giá trị cũ TRƯỚC test, khôi phục trong `afterAll` (kể cả khi assert đỏ giữa chừng, nhờ
 * try/finally) để không làm cảnh báo dính sang lượt chạy sau.
 *
 * DB e2e trên CI có thể CHƯA mở sổ (mới tinh): ghi 1 dòng "Thu khác" qua UI trước (cùng luồng
 * `so-quy-dong-chay.spec.ts`) để đảm bảo sổ ĐÃ MỞ, không giả định trạng thái sẵn có — trên DB local
 * tích luỹ dòng này chỉ cộng thêm, không phá gì. Đặt ngưỡng RẤT CAO (gần trần 2 tỷ của
 * `TRAN_QUY_TOI_THIEU`) để chắc chắn vượt mọi số dư quỹ thực tế bất kể DB đang chạy tích luỹ bao lâu.
 *
 * Bước "hết cảnh báo" KHÔNG được suy từ một ngưỡng thấp đơn thuần: dự báo 30 ngày phụ thuộc dữ liệu
 * NỀN tích luỹ trên DB local (vd `chi-phi.spec.ts` để lại `RecurringExpense` không dọn, sinh lùi mỗi
 * tháng) — sàn dự báo có thể âm bất kỳ lúc nào KHÔNG PHẢI do lỗi code, làm bước này đỏ oan. Bơm THÊM
 * một dòng "Thu khác" LỚN (1 tỷ, dưới trần 2 tỷ của cả ô tiền lẫn ngưỡng) trước khi kiểm để sàn dự báo
 * luôn dương chắc chắn — tách hẳn assert khỏi dữ liệu nền, dọn đúng dòng mình tạo ở `afterAll`.
 */

async function login(page: Page): Promise<void> {
  await page.goto("/dang-nhap");
  await page.getByLabel("Email").fill(TEST_USER_EMAIL);
  await page.getByLabel("Mật khẩu", { exact: true }).fill(TEST_USER_PASSWORD);
  await page.getByRole("button", { name: "Đăng nhập" }).click();
  await expect(page).toHaveURL("/");
}

/** Chọn 1 mục trong base-ui Select trong dialog (trigger hiện `placeholder`) — cùng helper với
 * `so-quy-dong-chay.spec.ts`. */
async function pickSelectOption(page: Page, placeholder: string, optionName: string): Promise<void> {
  await page.getByText(placeholder, { exact: true }).click();
  await page.getByRole("option", { name: optionName, exact: true }).click();
}

/** Mở form sửa ngưỡng, gõ `raw`, bấm Lưu. */
async function datNguong(page: Page, raw: string): Promise<void> {
  await page.getByTestId("so-quy-quy-toi-thieu-sua").click();
  await page.getByTestId("so-quy-quy-toi-thieu-input").fill(raw);
  await page.getByRole("button", { name: "Lưu" }).click();
}

test.describe("Dự báo quỹ + cảnh báo sắp cạn", () => {
  const descMoSo = `E2E du bao quy mo so ${Date.now()}`;
  // Dòng bơm RIÊNG (mô tả khác `descMoSo`) — kéo sàn dự báo 30 ngày lên dương chắc chắn cho bước ⑥,
  // xem docstring đầu file.
  const descBomThu = `E2E du bao quy bom thu ${Date.now()}`;
  let nguongCu: string | null = null;

  test.beforeAll(async () => {
    const prisma = testPrisma();
    const row = await prisma.setting.findUnique({ where: { key: KEY_QUY_TOI_THIEU } });
    nguongCu = row?.value ?? null;
    // Cùng lý do dọn theo tiền tố ở `afterAll`: gỡ dòng kẹt của lượt trước bị giết giữa chừng.
    await prisma.cashMovement.deleteMany({ where: { description: { startsWith: "E2E du bao quy" } } });
    await prisma.$disconnect();
  });

  test.afterAll(async () => {
    const prisma = testPrisma();
    if (nguongCu !== null) {
      await prisma.setting.update({ where: { key: KEY_QUY_TOI_THIEU }, data: { value: nguongCu } });
    } else {
      await prisma.setting.deleteMany({ where: { key: KEY_QUY_TOI_THIEU } });
    }
    // Dọn theo TIỀN TỐ chứ không theo đúng mô tả của lượt này: lượt trước bị giết giữa chừng (Ctrl-C,
    // timeout) thì `afterAll` không chạy, dòng Thu 1 tỷ kẹt lại mang mốc thời gian cũ ⇒ quỹ vượt mọi
    // ngưỡng đặt được và bước "chạm" không bao giờ đạt nữa.
    await prisma.cashMovement.deleteMany({ where: { description: { startsWith: "E2E du bao quy" } } });
    await prisma.$disconnect();
  });

  test.beforeEach(async ({ page }) => {
    await login(page);
  });

  test("ngưỡng rất cao ⇒ cảnh báo chạm ở tab + banner toàn app; đặt lại ⇒ hết cảnh báo; ngưỡng âm/rỗng ⇒ lỗi ở ô", async ({
    page,
  }) => {
    // ① Đảm bảo sổ ĐÃ MỞ — ghi 1 dòng Thu khác qua UI (khuôn `so-quy-dong-chay.spec.ts`).
    await page.goto("/tai-chinh?tab=dong-tien");
    await page.locator("#ghi-tay").getByRole("button", { name: "+ Nhập quỹ" }).click();
    const dialogGhiTay = page.getByRole("dialog");
    await pickSelectOption(page, "Chọn loại khoản", "Thu khác");
    await dialogGhiTay.getByPlaceholder("0").fill("100000");
    await dialogGhiTay.locator("textarea").fill(descMoSo);
    await dialogGhiTay.getByRole("button", { name: "Lưu" }).click();
    await expect(page.getByText(/Đã ghi Thu khác/)).toBeVisible();

    // ①b Bơm THÊM 1 tỷ Thu khác — kéo sàn dự báo 30 ngày lên dương chắc chắn cho bước ⑥, bất kể DB
    // đang chạy tích luỹ bao lâu (xem docstring đầu file). Không ảnh hưởng bước ③–⑤: ngưỡng gần trần
    // vẫn chạm bình thường dù quỹ có thêm khoản này.
    await page.goto("/tai-chinh?tab=dong-tien");
    await page.locator("#ghi-tay").getByRole("button", { name: "+ Nhập quỹ" }).click();
    const dialogBom = page.getByRole("dialog");
    await pickSelectOption(page, "Chọn loại khoản", "Thu khác");
    await dialogBom.getByPlaceholder("0").fill("1000000000");
    await dialogBom.locator("textarea").fill(descBomThu);
    await dialogBom.getByRole("button", { name: "Lưu" }).click();
    await expect(page.getByText(/Đã ghi Thu khác/)).toBeVisible();

    // ② Tab Sổ quỹ: khối dự báo hiện, biểu đồ render (có svg).
    await page.goto("/tai-chinh?tab=so-quy");
    const khoiDuBao = page.getByTestId("so-quy-du-bao");
    await expect(khoiDuBao).toBeVisible();
    await expect(khoiDuBao.locator("svg").first()).toBeVisible();

    // ③ Đặt ngưỡng RẤT CAO — vượt mọi số dư quỹ thực tế của DB test (gần trần 2 tỷ).
    await datNguong(page, "1.999.999.999");
    await expect(page.getByText("Đã đặt quỹ tối thiểu")).toBeVisible();

    // ④ Nhánh CHẠM hiện, nhánh "không chạm" biến mất, kèm chú thích thận trọng.
    await expect(page.getByTestId("so-quy-du-bao-canh-bao")).toBeVisible();
    await expect(page.getByTestId("so-quy-du-bao-khong-cham")).toHaveCount(0);
    await expect(page.getByText(/Dự báo THẬN TRỌNG/)).toBeVisible();

    // ⑤ Banner toàn app hiện Ở TRANG KHÁC (dashboard) — chứng minh banner đọc từ layout, không
    // phải trạng thái cục bộ của tab Sổ quỹ.
    await page.goto("/");
    await expect(page.getByTestId("banner-du-bao-quy-sap-can")).toBeVisible();

    // ⑥ Đặt lại ngưỡng THẤP (1 — chỉ cần một ngưỡng chắc chắn dưới sàn dự báo; đặt đúng 0 kiểm riêng ở
    // bước ⑨) ⇒ hết cảnh báo ở CẢ HAI chỗ. Tất định nhờ khoản bơm ở bước ①b: sàn dự
    // báo giờ cao hơn ngưỡng 1 rất nhiều, không phụ thuộc dữ liệu nền tích luỹ.
    await page.goto("/tai-chinh?tab=so-quy");
    await datNguong(page, "1");
    await expect(page.getByText("Đã đặt quỹ tối thiểu")).toBeVisible();
    await expect(page.getByTestId("so-quy-du-bao-canh-bao")).toHaveCount(0);

    await page.goto("/");
    await expect(page.getByTestId("banner-du-bao-quy-sap-can")).toHaveCount(0);

    // ⑦ Nhập ngưỡng ÂM ⇒ lỗi hiện đúng ô, KHÔNG lưu (không có toast thành công).
    await page.goto("/tai-chinh?tab=so-quy");
    await datNguong(page, "-100000");
    await expect(page.getByTestId("so-quy-quy-toi-thieu-error")).toBeVisible();
    await expect(page.getByTestId("so-quy-quy-toi-thieu-error")).toContainText("âm");
    await expect(page.getByText("Đã đặt quỹ tối thiểu")).toHaveCount(0);

    // ⑧ Xoá TRẮNG ô rồi Lưu ⇒ lỗi NGAY ở ô (chặn phía client, không gọi action) — KHÔNG lặng lẽ đặt 0.
    // Form vẫn đang mở từ bước ⑦ (chưa Hủy/reload) nên gõ tiếp trực tiếp vào cùng ô.
    await page.getByTestId("so-quy-quy-toi-thieu-input").fill("");
    await page.getByRole("button", { name: "Lưu" }).click();
    // Lỗi của bước ⑦ đã hiện sẵn ⇒ phải kiểm ĐÚNG câu của cổng ô rỗng, không chỉ "có lỗi".
    await expect(page.getByTestId("so-quy-quy-toi-thieu-error")).toContainText("Nhập số tiền");
    await expect(page.getByText("Đã đặt quỹ tối thiểu")).toHaveCount(0);
    // Hủy rồi đọc lại số đang dùng — vẫn "1" của bước ⑥, KHÔNG bị hai lần lưu lỗi ở ⑦/⑧ đổi mất.
    await page.getByRole("button", { name: "Hủy" }).click();
    await expect(page.getByTestId("so-quy-quy-toi-thieu-hien-tai")).toHaveText("1 ₫");

    // ⑨ Đặt ngưỡng về đúng 0 qua UI: gõ "0" phải được giữ trong ô (định dạng số không được xoá nó) và
    // lưu thành "0 ₫" — không có đường này thì đã đặt ngưỡng là không quay về mặc định được.
    await datNguong(page, "0");
    await expect(page.getByText("Đã đặt quỹ tối thiểu")).toBeVisible();
    await expect(page.getByTestId("so-quy-quy-toi-thieu-hien-tai")).toHaveText("0 ₫");
  });
});
