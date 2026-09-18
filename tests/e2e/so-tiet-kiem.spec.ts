import { expect, test, type Page } from "@playwright/test";
import { addMonths, format, subMonths } from "date-fns";

import { testPrisma } from "./ingest-raw";
import { TEST_USER_EMAIL, TEST_USER_PASSWORD } from "./test-constants";

/**
 * E2E "Sổ tiết kiệm sinh lãi" — tab Dòng tiền. Đi TRỌN vòng qua UI thật: gửi sổ → bảng hiện đúng số
 * → tất toán → GỐC về quỹ còn LÃI nhảy vào dòng "Thu nhập tài chính" của bảng Lãi/Lỗ. Rồi một sổ
 * thứ hai đi đường RÚT TRƯỚC HẠN (lãi nhập tay, app KHÔNG đoán).
 *
 * Đây là phép kiểm duy nhất chạy qua ĐỦ mọi tầng cùng lúc: form → server action → 2 bảng dữ liệu →
 * công thức quỹ → công thức P&L → 2 màn hiển thị. Unit/integration test từng tầng đã xanh không bảo
 * chứng được chuỗi đó ráp lại vẫn đúng.
 *
 * Số cụ thể là số TÍNH TAY, không suy lại bằng chính công thức đang kiểm:
 *   Sổ A: 200.000.000đ · 5,2%/năm · gửi (hôm nay − 6 tháng) · đáo hạn hôm nay.
 *   Lãi TẤT TOÁN: ô "Lãi thực nhận" app điền sẵn `laiDuKien` — spec KHÔNG ghim con số đó (số ngày
 *   lịch đổi theo ngày chạy test), mà ghim HÀNH VI: số hiện trong ô > 0, và ĐÚNG số đó xuất hiện ở
 *   dòng "Thu nhập tài chính". Ghim literal ở đây là test tự vỡ mỗi tháng vì lý do không liên quan.
 *   Sổ B: 60.000.000đ, rút trước hạn, lãi GÕ TAY 123.456đ — số lẻ để không trùng bất kỳ số nào khác
 *   trên màn, chứng minh app ghi ĐÚNG số chủ shop gõ chứ không tự tính lại.
 *
 * Cách ly: tên sổ bắt đầu "E2E TK"; `beforeAll` dọn theo đúng thứ tự khoá ngoại (ThuNhap →
 * CashMovement → SoTietKiem) bằng `testPrisma()` (guard chỉ cho đụng DB e2e). KHÔNG assert số quỹ
 * tuyệt đối — dữ liệu e2e tích luỹ từ spec khác.
 */

const TEN_SO = "E2E TK Vietcombank";
const TEN_SO_RUT_SOM = "E2E TK rút sớm";
const GOC = "200000000";
const GOC_RUT_SOM = "60000000";
const LAI_RUT_SOM = "123456";

async function login(page: Page): Promise<void> {
  await page.goto("/dang-nhap");
  await page.getByLabel("Email").fill(TEST_USER_EMAIL);
  await page.getByLabel("Mật khẩu", { exact: true }).fill(TEST_USER_PASSWORD);
  await page.getByRole("button", { name: "Đăng nhập" }).click();
  await expect(page).toHaveURL("/");
}

/** Mở menu ⋯ của đúng một dòng sổ rồi bấm một mục. */
async function moMenu(page: Page, tenSo: string, muc: string): Promise<void> {
  await page.getByRole("button", { name: `Thao tác ${tenSo}` }).first().click();
  await page.getByRole("menuitem", { name: muc, exact: true }).click();
}

test.describe("Sổ tiết kiệm sinh lãi — tab Dòng tiền", () => {
  test.beforeAll(async () => {
    const prisma = testPrisma();
    await prisma.thuNhap.deleteMany({ where: { soTietKiem: { name: { startsWith: "E2E TK" } } } });
    await prisma.cashMovement.deleteMany({ where: { soTietKiem: { name: { startsWith: "E2E TK" } } } });
    await prisma.soTietKiem.deleteMany({ where: { name: { startsWith: "E2E TK" } } });
    await prisma.$disconnect();
  });

  test.beforeEach(async ({ page }) => {
    await login(page);
  });

  test("gửi sổ → tất toán → gốc về quỹ, lãi vào dòng Thu nhập tài chính của Lãi/Lỗ", async ({
    page,
  }) => {
    const homNay = new Date();
    const ngayGui = format(subMonths(homNay, 6), "yyyy-MM-dd");
    const ngayDaoHan = format(homNay, "yyyy-MM-dd");

    await page.goto("/tai-chinh?tab=dong-tien");
    const khoi = page.locator("#tiet-kiem");
    await expect(khoi).toBeVisible();

    // --- Gửi sổ --------------------------------------------------------------------------
    await khoi.getByRole("button", { name: "+ Thêm sổ tiết kiệm" }).click();
    const form = page.getByRole("dialog");
    await expect(form.getByText("Thêm sổ tiết kiệm", { exact: true })).toBeVisible();

    await form.getByLabel("Tên sổ").fill(TEN_SO);
    await form.getByLabel("Ngân hàng").fill("Vietcombank");
    await form.getByLabel("Số tiền gửi").fill(GOC);
    await form.getByLabel("Ngày gửi").fill(ngayGui);
    await form.getByLabel("Kỳ hạn (tháng)").fill("6");
    // Ngày đáo hạn app tự điền từ ngày gửi + kỳ hạn; ghi đè để đáo hạn rơi ĐÚNG hôm nay — đó là
    // điều kiện để thẻ nhắc đáo hạn hiện ra ở ca dưới.
    await form.getByLabel("Ngày đáo hạn").fill(ngayDaoHan);
    await form.getByLabel("Lãi %/năm").fill("5.2");
    await form.getByRole("button", { name: "Lưu" }).click();

    await expect(page.getByText(`Đã thêm sổ tiết kiệm ${TEN_SO}`)).toBeVisible();

    // --- Bảng hiện đúng sổ vừa gửi -------------------------------------------------------
    const dong = khoi.getByRole("row").filter({ hasText: TEN_SO });
    await expect(dong).toBeVisible();
    await expect(dong).toContainText("200.000.000 ₫");
    // Dòng tổng của bảng — "đang gửi" phải cộng đúng sổ vừa tạo.
    await expect(khoi).toContainText("Đang gửi Σ");

    // --- Tất toán ------------------------------------------------------------------------
    await moMenu(page, TEN_SO, "Tất toán");
    const hopTatToan = page.getByRole("dialog");
    await expect(hopTatToan.getByText("Tất toán sổ tiết kiệm", { exact: true })).toBeVisible();

    // App điền sẵn lãi dự kiến — đọc lại ĐÚNG số đó rồi đối chiếu ở bảng Lãi/Lỗ. Không ghim
    // literal: số ngày lịch giữa hai mốc đổi theo ngày chạy test.
    // Ô dùng `formatAmountInput` nên giá trị đọc ra ĐÃ có dấu chấm ngăn cách ("5.157.260") — bỏ
    // dấu chấm mới ra số. Giữ nguyên chuỗi đã format để đối chiếu với bảng Lãi/Lỗ bên dưới (bảng
    // cũng in bằng `formatVnd`, cùng một quy ước dấu).
    const oLai = hopTatToan.getByLabel("Lãi thực nhận");
    const laiDeXuat = await oLai.inputValue();
    expect(Number(laiDeXuat.replace(/\./g, ""))).toBeGreaterThan(0);

    await hopTatToan.getByRole("button", { name: "Tất toán", exact: true }).click();
    await expect(page.getByText(`Đã tất toán ${TEN_SO}`)).toBeVisible();

    // --- Lãi vào bảng Lãi/Lỗ của THÁNG NÀY ------------------------------------------------
    await page.goto("/tai-chinh");
    const bangPnl = page.getByRole("table").first();
    await expect(bangPnl).toContainText("Thu nhập tài chính");

    // Neo bằng accessible name có ^ — lọc theo `hasText` khớp CẢ dòng "LN ròng", vì chú thích của
    // dòng đó (Phase 06) cố ý chứa cụm "thu nhập tài chính" khi kỳ có khoản này.
    const dongThuNhap = page.getByRole("row", { name: /^Thu nhập tài chính/ });
    await expect(dongThuNhap).toContainText(laiDeXuat);

    // Và chính cái "vướng" ở trên là bằng chứng chú thích LN ròng đang chạy: kỳ có lãi tiết kiệm
    // thì dòng LN ròng phải NÓI RA, kẻo biên ròng nhảy vọt mà không ai giải thích được vì sao.
    await expect(page.getByRole("row", { name: /^LN ròng/ })).toContainText("thu nhập tài chính");
  });

  test("rút TRƯỚC HẠN: app ghi đúng số lãi gõ tay, không tự tính lại", async ({ page }) => {
    const homNay = new Date();
    const ngayGui = format(subMonths(homNay, 1), "yyyy-MM-dd");
    const ngayDaoHan = format(addMonths(homNay, 5), "yyyy-MM-dd");

    await page.goto("/tai-chinh?tab=dong-tien");
    const khoi = page.locator("#tiet-kiem");

    await khoi.getByRole("button", { name: "+ Thêm sổ tiết kiệm" }).click();
    const form = page.getByRole("dialog");
    await form.getByLabel("Tên sổ").fill(TEN_SO_RUT_SOM);
    await form.getByLabel("Số tiền gửi").fill(GOC_RUT_SOM);
    await form.getByLabel("Ngày gửi").fill(ngayGui);
    await form.getByLabel("Kỳ hạn (tháng)").fill("6");
    await form.getByLabel("Ngày đáo hạn").fill(ngayDaoHan);
    await form.getByLabel("Lãi %/năm").fill("5.2");
    await form.getByRole("button", { name: "Lưu" }).click();
    await expect(page.getByText(`Đã thêm sổ tiết kiệm ${TEN_SO_RUT_SOM}`)).toBeVisible();

    // Rút trước hạn: ô lãi để TRỐNG (app không đoán) — gõ đúng số ngân hàng trả.
    await moMenu(page, TEN_SO_RUT_SOM, "Rút trước hạn");
    const hop = page.getByRole("dialog");
    await hop.getByLabel("Lãi thực nhận").fill(LAI_RUT_SOM);
    await hop.getByRole("button", { name: "Rút trước hạn", exact: true }).click();
    await expect(page.getByText(`Đã rút trước hạn ${TEN_SO_RUT_SOM}`)).toBeVisible();

    // Bảng đánh dấu sổ này là rút trước hạn và in ĐÚNG số lãi đã gõ.
    const dong = khoi.getByRole("row").filter({ hasText: TEN_SO_RUT_SOM });
    await expect(dong).toContainText("rút trước hạn");
    await expect(dong).toContainText("123.456 ₫");
  });
});
