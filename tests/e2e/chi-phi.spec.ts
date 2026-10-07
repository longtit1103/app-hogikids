import { expect, test, type Page } from "./fixture-cho-trang-stream-xong";
import { format, startOfMonth } from "date-fns";

import { testPrisma } from "./ingest-raw";
import { INGEST_SECRET_TEST, TEST_USER_EMAIL, TEST_USER_PASSWORD } from "./test-constants";

/**
 * E2E màn Chi phí (Phase 4). Cố ý CHỈ dùng UI + HTTP (`/api/ingest/ads`) — không
 * ghi Prisma trực tiếp từ worker: DATABASE_URL của worker Playwright không được
 * bảo đảm trỏ về test DB (chỉ webServer nhận `webServer.env`), nên seed qua
 * endpoint ingest (đi qua webServer → test DB) là đường an toàn duy nhất.
 *
 * Cách ly: mỗi test tự đặt mô tả DUY NHẤT (timestamp) rồi lọc `?q=` để đếm đúng
 * dòng của mình — không phụ thuộc thứ tự chạy, an toàn dưới `fullyParallel`.
 */

const TODAY = format(new Date(), "yyyy-MM-dd");

async function login(page: Page): Promise<void> {
  await page.goto("/dang-nhap");
  await page.getByLabel("Email").fill(TEST_USER_EMAIL);
  await page.getByLabel("Mật khẩu", { exact: true }).fill(TEST_USER_PASSWORD);
  await page.getByRole("button", { name: "Đăng nhập" }).click();
  await expect(page).toHaveURL("/");
}

/** Chọn 1 mục trong base-ui Select đang hiển thị trong dialog (trigger hiện `placeholder`). */
async function pickSelectOption(page: Page, placeholder: string, optionName: string): Promise<void> {
  await page.getByText(placeholder, { exact: true }).click();
  await page.getByRole("option", { name: optionName, exact: true }).click();
}

test.describe("Chi phí", () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
  });

  test("Thêm khoản Đóng gói → toast + dòng mới xuất hiện", async ({ page }) => {
    const desc = `E2E đóng gói ${Date.now()}`;
    try {
      await page.goto("/tai-chinh?tab=so-chi-phi");

      await page.getByRole("button", { name: "+ Thêm chi phí" }).first().click();
      const dialog = page.getByRole("dialog");
      await expect(dialog.getByText("Thêm chi phí")).toBeVisible();

      await pickSelectOption(page, "Chọn danh mục", "Đóng gói");
      await dialog.getByPlaceholder("0").fill("350000");
      await dialog.locator("textarea").fill(desc);
      await dialog.getByRole("button", { name: "Lưu" }).click();

      await expect(page.getByText(/Đã thêm chi phí/)).toBeVisible();

      // Lọc đúng dòng vừa tạo — chứng minh khoản chi đã vào sổ + hiển thị số tiền.
      await page.goto(`/tai-chinh?tab=so-chi-phi&q=${encodeURIComponent(desc)}`);
      const row = page.locator("tbody tr").filter({ hasText: desc }).first();
      await expect(row).toContainText("350.000");
    } finally {
      const prisma = testPrisma();
      await prisma.expense.deleteMany({ where: { description: desc } });
      await prisma.$disconnect();
    }
  });

  test("Danh mục Quảng cáo chưa chọn nguồn → nút Lưu bị khoá", async ({ page }) => {
    await page.goto("/tai-chinh?tab=so-chi-phi");
    await page.getByRole("button", { name: "+ Thêm chi phí" }).first().click();
    const dialog = page.getByRole("dialog");

    await pickSelectOption(page, "Chọn danh mục", "Quảng cáo");
    await dialog.getByPlaceholder("0").fill("500000");

    // Field "Nguồn ads" bắt buộc hiện ra và nút Lưu bị khoá tới khi chọn nguồn.
    await expect(dialog.getByText("Nguồn ads")).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Lưu" })).toBeDisabled();
  });

  // Ô Ngày xoá trống: trước đây vẫn Lưu được, dòng chi phí rơi về 01/01/1970 mà toast vẫn xanh
  // (cùng họ lỗi đã vá ở khoản tiền khác — tien-vao-khac.spec).
  test("Xoá trống ô Ngày → nút Lưu bị khoá", async ({ page }) => {
    await page.goto("/tai-chinh?tab=so-chi-phi");
    await page.getByRole("button", { name: "+ Thêm chi phí" }).first().click();
    const dialog = page.getByRole("dialog");

    await pickSelectOption(page, "Chọn danh mục", "Đóng gói");
    await dialog.getByPlaceholder("0").fill("350000");
    await expect(dialog.getByRole("button", { name: "Lưu" })).toBeEnabled();

    await dialog.locator('input[type="date"]').fill("");
    await expect(dialog.getByRole("button", { name: "Lưu" })).toBeDisabled();
  });

  test("Bật 'Lặp lại hàng tháng' → reload không sinh dòng trùng", async ({ page }) => {
    const desc = `E2E định kỳ ${Date.now()}`;
    try {
      await page.goto("/tai-chinh?tab=so-chi-phi");

      await page.getByRole("button", { name: "+ Thêm chi phí" }).first().click();
      const dialog = page.getByRole("dialog");
      await pickSelectOption(page, "Chọn danh mục", "Mặt bằng-cố định");
      await dialog.getByPlaceholder("0").fill("1200000");
      await dialog.locator("textarea").fill(desc);
      await dialog.getByRole("switch").click();
      await dialog.getByRole("button", { name: "Lưu" }).click();
      await expect(page.getByText(/Đã thêm chi phí/)).toBeVisible();

      // Đếm trong BẢNG SỔ CHI PHÍ thôi — khối "Khoản chi định kỳ" (bảng trong `<details>`) cũng in mô tả
      // của MẪU, đếm lẫn thì ra 2 dù Expense vẫn đúng 1.
      const dongSo = () => page.locator("table:not(details table) tbody tr").filter({ hasText: desc });

      // Đúng 1 dòng ngay sau khi tạo…
      await page.goto(`/tai-chinh?tab=so-chi-phi&q=${encodeURIComponent(desc)}`);
      await expect(dongSo()).toHaveCount(1);

      // …và vẫn đúng 1 dòng sau reload (ensureRecurringExpenses idempotent trong tháng).
      await page.reload();
      await expect(dongSo()).toHaveCount(1);
    } finally {
      // `recurringMonthly=true` tạo CẢ `RecurringExpense` LẪN 1 `Expense{recurringId}` ngay lúc Lưu —
      // mẫu còn `active` nên MỌI lượt render Dashboard/tab Chi phí sau đó (kể cả của spec khác) tự
      // sinh thêm dòng Expense cho tháng mới (issue #247: 453 dòng/491tr tích luỹ do thiếu đúng dọn
      // này). Xoá Expense (con) TRƯỚC rồi mẫu (cha) — không FK nên thứ tự chỉ để tránh mồ côi tạm thời.
      const prisma = testPrisma();
      const mau = await prisma.recurringExpense.findMany({ where: { description: desc }, select: { id: true } });
      await prisma.expense.deleteMany({ where: { recurringId: { in: mau.map((m) => m.id) } } });
      await prisma.recurringExpense.deleteMany({ where: { description: desc } });
      await prisma.$disconnect();
    }
  });

  test("Bật lặp khi đã có mẫu cùng danh mục + số tiền → cảnh báo, 'Vẫn lưu' mới tạo", async ({ page }) => {
    const prefix = `E2E trùng định kỳ ${Date.now()}`;
    const moTaMoi = `${prefix} mới`;
    const prisma = testPrisma();
    // Số tiền riêng cho ca này để không đụng mẫu của spec khác trong DB e2e dùng chung.
    await prisma.recurringExpense.create({
      data: {
        categoryId: "packaging",
        amount: 654_321,
        dayOfMonth: 7,
        description: `${prefix} cũ`,
        active: true,
        activeFrom: startOfMonth(new Date()),
      },
    });
    try {
      await page.goto("/tai-chinh?tab=so-chi-phi");
      await page.getByRole("button", { name: "+ Thêm chi phí" }).first().click();
      const dialog = page.getByRole("dialog");
      await pickSelectOption(page, "Chọn danh mục", "Đóng gói");
      await dialog.getByPlaceholder("0").fill("654321");
      await dialog.locator("textarea").fill(moTaMoi);
      await dialog.getByRole("switch").click();
      await dialog.getByRole("button", { name: "Lưu", exact: true }).click();

      // Lần đầu: server từ chối, hiện cảnh báo + nút đổi thành "Vẫn lưu", chưa có mẫu mới.
      await expect(dialog.getByTestId("expense-canh-bao-dinh-ky-trung")).toContainText(`${prefix} cũ`);
      expect(await prisma.recurringExpense.count({ where: { description: moTaMoi } })).toBe(0);

      // Sửa một ô ⇒ cảnh báo biến mất, nút trở lại "Lưu" (xác nhận không dính sang nội dung khác).
      await dialog.locator("textarea").fill(`${moTaMoi}!`);
      await expect(dialog.getByTestId("expense-canh-bao-dinh-ky-trung")).toHaveCount(0);
      await expect(dialog.getByRole("button", { name: "Lưu", exact: true })).toBeVisible();
      // Trả về ĐÚNG nội dung server đã dò ⇒ cảnh báo gắn với nội dung đó hiện lại, nút lại là "Vẫn lưu".
      await dialog.locator("textarea").fill(moTaMoi);
      await expect(dialog.getByTestId("expense-canh-bao-dinh-ky-trung")).toBeVisible();

      await dialog.getByRole("button", { name: "Vẫn lưu" }).click();
      await expect(page.getByText(/Đã thêm chi phí/)).toBeVisible();
      expect(await prisma.recurringExpense.count({ where: { description: moTaMoi } })).toBe(1);
    } finally {
      const mau = await prisma.recurringExpense.findMany({
        where: { description: { startsWith: prefix } },
        select: { id: true },
      });
      await prisma.expense.deleteMany({ where: { recurringId: { in: mau.map((m) => m.id) } } });
      await prisma.recurringExpense.deleteMany({ where: { description: { startsWith: prefix } } });
      await prisma.$disconnect();
    }
  });

  test("Dòng ADS_API hiện 'Xem log' + nút xoá bị khoá", async ({ page }) => {
    const desc = `E2E ADS API ${Date.now()}`;
    try {
      // Seed dòng ADS_API qua đúng luồng ingest (đi qua webServer → test DB).
      const res = await page.request.post("/api/ingest/ads", {
        headers: { Authorization: `Bearer ${INGEST_SECRET_TEST}` },
        data: {
          source: "META",
          rows: [{ date: TODAY, campaignId: `e2e-${Date.now()}`, campaignName: desc, spendExVat: 54321, vatRate: 0.1 }],
        },
      });
      expect(res.ok()).toBe(true);

      await page.goto(`/tai-chinh?tab=so-chi-phi&q=${encodeURIComponent(desc)}`);
      const row = page.locator("tbody tr").filter({ hasText: desc }).first();
      await expect(row).toBeVisible();

      // Có "Xem log" trỏ mục Kết nối; KHÔNG có nút Sửa; nút xoá disabled.
      await expect(row.getByRole("link", { name: "Xem log" })).toHaveAttribute("href", "/cai-dat#ket-noi");
      await expect(row.getByRole("button", { name: "Sửa" })).toHaveCount(0);
      await expect(row.locator('button[title*="không xóa tay"]')).toBeDisabled();
    } finally {
      // Dòng ADS_API "không xóa tay" qua UI (đúng hành vi đang kiểm) — dọn thẳng qua Prisma.
      const prisma = testPrisma();
      await prisma.expense.deleteMany({ where: { description: desc } });
      await prisma.$disconnect();
    }
  });

  test.describe("Khối 'Khoản chi định kỳ'", () => {
    const prefix = `E2E dinh ky ${Date.now()}`;
    const tenActive = `${prefix} — đang chạy`;
    const tenInactive = `${prefix} — đã dừng`;
    const tenBatLai = `${prefix} — bật lại tháng sau`;

    test.beforeAll(async () => {
      const prisma = testPrisma();
      await prisma.recurringExpense.createMany({
        data: [
          { categoryId: "packaging", amount: 250_000, dayOfMonth: 12, description: tenActive, active: true },
          { categoryId: "fixed", amount: 800_000, dayOfMonth: 3, description: tenInactive, active: false },
          { categoryId: "fixed", amount: 900_000, dayOfMonth: 5, description: tenBatLai, active: false },
        ],
      });
      await prisma.$disconnect();
    });

    test.afterAll(async () => {
      const prisma = testPrisma();
      // Mở tab là `ensureRecurringExpensesForMonths` SINH Expense từ mẫu đang chạy — `recurringId` không
      // có FK nên xoá mẫu không kéo theo; dọn cả hai kẻo spec sau thấy khoản chi lạ trong Lãi/Lỗ.
      const mau = await prisma.recurringExpense.findMany({
        where: { description: { startsWith: prefix } },
        select: { id: true },
      });
      await prisma.expense.deleteMany({ where: { recurringId: { in: mau.map((m) => m.id) } } });
      await prisma.recurringExpense.deleteMany({ where: { description: { startsWith: prefix } } });
      await prisma.$disconnect();
    });

    test("mở khối → thấy cả mẫu đang chạy lẫn đã dừng, đúng badge; nút Bật lại CHỈ ở mẫu đã dừng", async ({ page }) => {
      await page.goto("/tai-chinh?tab=so-chi-phi");

      const khoi = page.locator("details", { hasText: "Khoản chi định kỳ" });
      await expect(khoi).toBeVisible();
      // Mặc định GẤP — mở bằng bấm summary trước khi tìm dòng bên trong.
      await khoi.locator("summary").click();

      const rowActive = khoi.locator("tr", { hasText: tenActive });
      await expect(rowActive).toBeVisible();
      await expect(rowActive.getByText("Đang chạy", { exact: true })).toBeVisible();
      await expect(rowActive).toContainText("250.000");
      await expect(rowActive).toContainText("ngày 12 hằng tháng");

      const rowInactive = khoi.locator("tr", { hasText: tenInactive });
      await expect(rowInactive).toBeVisible();
      await expect(rowInactive.getByText("Đã dừng", { exact: true })).toBeVisible();

      // Bật lại chỉ dành cho mẫu đã dừng (server đặt mốc `activeFrom` = tháng hiện tại ⇒ không ghi bù
      // các tháng đã dừng). Không bấm ở đây: bấm là đổi dữ liệu dùng chung của các spec khác trong file.
      await expect(rowInactive.getByRole("button", { name: "Bật lại" })).toHaveCount(1);
      await expect(rowActive.getByRole("button", { name: /bật lại/i })).toHaveCount(0);
    });

    test("Bật lại → chọn 'Tháng sau' → toast + cột mốc đúng THÁNG SAU đã hiện trong hộp", async ({ page }) => {
      // Chuỗi UI → server action: nhãn hiện trong hộp và khoá gửi lên phải là CÙNG một tháng. Đảo khoá
      // (chọn "tháng sau" mà gửi khoá tháng này) là sinh lại đúng khoản chủ shop vừa xoá. So với nhãn
      // đọc từ chính hộp (server render giờ VN) — không tự tính tháng ở worker (múi giờ worker tuỳ máy).
      await page.goto("/tai-chinh?tab=so-chi-phi");
      const khoi = page.locator("details", { hasText: "Khoản chi định kỳ" });
      await khoi.locator("summary").click();
      const row = khoi.locator("tr", { hasText: tenBatLai });
      await row.getByRole("button", { name: "Bật lại" }).click();

      const dialog = page.getByRole("dialog");
      const radioThangSau = dialog.getByRole("radio", { name: /^Tháng sau/ });
      /** Nhãn `MM/yyyy` trong ngoặc của label bọc radio — "Tháng sau (11/2026) — …". */
      const nhanCuaRadio = async (ten: RegExp) =>
        /\((\d{2}\/\d{4})\)/.exec(
          (await dialog.locator("label", { has: page.getByRole("radio", { name: ten }) }).textContent()) ?? ""
        )?.[1];
      const nhanThangSau = await nhanCuaRadio(/^Tháng sau/);
      const nhanThangNay = await nhanCuaRadio(/^Tháng này/);
      expect(nhanThangSau).toMatch(/^\d{2}\/\d{4}$/);
      expect(nhanThangNay).toMatch(/^\d{2}\/\d{4}$/);
      expect(nhanThangSau).not.toBe(nhanThangNay);

      await radioThangSau.check();
      await expect(dialog.getByTestId("bat-lai-dinh-ky-giai-thich")).toContainText(`từ tháng ${nhanThangSau}`);
      await dialog.getByRole("button", { name: "Bật lại" }).click();

      // DB e2e dùng chung có thể còn mẫu "fixed" khác đang chạy ⇒ server đòi xác nhận trùng lần hai.
      const toast = page.getByText(`Đã bật lại — sinh chi phí từ tháng ${nhanThangSau}`);
      const canhBao = dialog.getByTestId("bat-lai-dinh-ky-canh-bao-trung");
      await expect(toast.or(canhBao)).toBeVisible();
      if (await canhBao.isVisible()) await dialog.getByRole("button", { name: "Vẫn bật lại" }).click();
      await expect(toast).toBeVisible();

      await expect(row.getByText("Đang chạy", { exact: true })).toBeVisible();
      await expect(row).toContainText(`từ ${nhanThangSau}`);
    });
  });
});
