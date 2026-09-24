import { expect, test, type Page } from "@playwright/test";
import { addMonths, format, subMonths } from "date-fns";

import { testPrisma } from "./ingest-raw";
import { TEST_USER_EMAIL, TEST_USER_PASSWORD } from "./test-constants";

/**
 * E2E "Lịch trả nợ dự kiến" — khối Khoản vay, tab Dòng tiền. Bảng CHỈ ĐỌC: kiểm nó hiện đủ kỳ, dư nợ
 * giảm dần theo mô phỏng, nói rõ DỰ KIẾN, và TUYỆT ĐỐI không có nút ghi nào bên trong.
 *
 * Khoản vay khai với kỳ đầu ở TƯƠNG LAI (tháng sau) để không đẻ kỳ chờ duyệt — tách hẳn khỏi luồng
 * ghi sổ của `so-quy-khoan-vay.spec.ts`, hai spec không giẫm chân nhau.
 *
 * MỖI test tự dọn + tự dựng khoản vay trong `beforeEach`. Trước đó test 2 kế thừa khoản do test 1 tạo:
 * CI có `retries: 2`, mà `beforeAll` không chạy lại giữa các lượt retry ⇒ lượt retry tạo khoản THỨ HAI
 * trùng tên (`Loan.name` không unique), locator lọc theo chữ khớp 2 khối và spec đỏ vĩnh viễn.
 */
const TEN_KHOAN = "E2E Du kien 6 ky";

async function login(page: Page): Promise<void> {
  await page.goto("/dang-nhap");
  await page.getByLabel("Email").fill(TEST_USER_EMAIL);
  await page.getByLabel("Mật khẩu", { exact: true }).fill(TEST_USER_PASSWORD);
  await page.getByRole("button", { name: "Đăng nhập" }).click();
  await expect(page).toHaveURL("/");
}

/** "1.234.567 ₫" ⇒ 1234567 */
const docTien = (t: string) => Number(t.replace(/\D/g, ""));

/** Dọn sạch khoản vay của spec này — chạy trước MỖI test để retry trên CI không tạo bản trùng tên. */
async function don(): Promise<void> {
  const prisma = testPrisma();
  await prisma.cashMovement.deleteMany({ where: { loan: { name: TEN_KHOAN } } });
  await prisma.loan.deleteMany({ where: { name: TEN_KHOAN } });
  await prisma.$disconnect();
}

/**
 * Tạo khoản vay TERM 12 kỳ QUA UI: giải ngân 3 THÁNG TRƯỚC, kỳ đầu THÁNG SAU.
 * Kỳ đầu ở tương lai ⇒ chưa có kỳ chờ duyệt. Giải ngân lùi 3 tháng là CỐ Ý: test thứ hai kéo kỳ đầu
 * về tháng trước, mà app chặn "ngày trả kỳ đầu phải sau ngày giải ngân" — giải ngân hôm nay thì
 * không còn chỗ hợp lệ nào để kéo về.
 */
async function taoKhoan(page: Page, homNay: Date): Promise<void> {
  const khoiVay = page.locator("#khoan-vay");
  await expect(khoiVay).toBeVisible();
  await khoiVay.getByRole("button", { name: "+ Thêm khoản vay" }).click();
  const form = page.getByRole("dialog");
  await form.getByLabel("Tên khoản vay").fill(TEN_KHOAN);
  await form.getByLabel("Ngân hàng / người cho vay").fill("ACB");
  await form.getByLabel("Số tiền giải ngân").fill("120000000");
  await form.getByLabel("Ngày giải ngân").fill(format(subMonths(homNay, 3), "yyyy-MM-dd"));
  await form.getByLabel("Lãi %/năm").fill("12");
  await form.getByLabel("Kỳ hạn (số kỳ còn lại)").fill("12");
  await form.getByLabel("Ngày trả kỳ đầu").fill(format(addMonths(homNay, 1), "yyyy-MM-dd"));
  await form.getByRole("button", { name: "Lưu", exact: true }).click();
  await expect(page.getByText(`Đã thêm khoản vay ${TEN_KHOAN}`)).toBeVisible();
}

test.describe("Lịch trả nợ dự kiến — khối Khoản vay", () => {
  test.beforeEach(async ({ page }) => {
    await don();
    await login(page);
    await page.goto("/tai-chinh?tab=dong-tien");
    await taoKhoan(page, new Date());
  });

  test.afterAll(don);

  test("bảng dự kiến: 6 kỳ, dư nợ giảm dần, có chữ DỰ KIẾN, KHÔNG có nút ghi", async ({ page }) => {
    // --- Bảng dự kiến ---------------------------------------------------------------------
    const bang = page.getByTestId("lich-tra-no-du-kien");
    await expect(bang).toBeVisible();
    await expect(bang).toContainText("Lịch trả nợ dự kiến — 6 kỳ tới");
    await expect(bang).toContainText("DỰ KIẾN");
    await expect(bang).toContainText("ngân hàng thu theo giấy báo");
    await expect(bang).toContainText(TEN_KHOAN);

    // Khối của khoản này: 6 dòng kỳ. Bám `data-testid` theo id khoản — lọc theo chữ rồi `.last()`
    // bắt trúng div LÁ (không chứa bảng) nên đếm ra 0.
    const khoi = bang.locator('[data-testid^="lich-du-kien-khoan-"]').filter({ hasText: TEN_KHOAN });
    const dong = khoi.locator("tbody tr");
    await expect(dong).toHaveCount(6);

    // Khoản TERM này không có tiền gửi bắt buộc ⇒ bảng không có cột "Tiền gửi".
    const coCotTienGui = (await khoi.locator("thead th").allInnerTexts()).includes("Tiền gửi");
    expect(coCotTienGui).toBe(false);

    // Dư nợ sau kỳ giảm dần — cột cuối cùng của mỗi dòng.
    const duNo: number[] = [];
    for (let i = 0; i < 6; i++) {
      duNo.push(docTien(await dong.nth(i).locator("td").last().innerText()));
    }
    for (let i = 1; i < duNo.length; i++) expect(duNo[i]).toBeLessThan(duNo[i - 1]);
    // Gốc đều 120tr/12 = 10tr mỗi kỳ ⇒ sau kỳ 1 còn 110tr, sau kỳ 6 còn 60tr.
    expect(duNo[0]).toBe(110_000_000);
    expect(duNo[5]).toBe(60_000_000);

    // Bất biến "Σ dòng tổng = Σ các dòng kỳ" — chặt hơn hẳn một khoảng magic number, và bắt được mọi
    // lượt công thức dòng tổng trôi khỏi công thức từng dòng.
    const cotChuyen: number[] = [];
    for (let i = 0; i < 6; i++) {
      cotChuyen.push(docTien(await dong.nth(i).locator("td").nth(coCotTienGui ? 5 : 4).innerText()));
    }
    const tong = docTien(await khoi.getByTestId(/^lich-du-kien-tong-/).innerText());
    expect(tong).toBe(cotChuyen.reduce((a, b) => a + b, 0));
    // Và phải LỚN HƠN Σ gốc (6 × 10tr) — tức cột lãi thật sự được cộng vào.
    expect(tong).toBeGreaterThan(60_000_000);

    // --- Bảng CHỈ ĐỌC: không nút nào bên trong --------------------------------------------
    await expect(bang.getByRole("button")).toHaveCount(0);
    await expect(bang.getByRole("textbox")).toHaveCount(0);

    // Kỳ đầu ở tương lai ⇒ không kỳ nào của KHOẢN NÀY mang badge "đang chờ duyệt". Phải soi trong
    // `khoi` chứ không cả thẻ: DB e2e còn khoản vay quá hạn của spec khác, quét cả thẻ ra 5 badge.
    await expect(khoi.getByText("đang chờ duyệt")).toHaveCount(0);
  });

  test("khai lùi ngày ⇒ CHỈ kỳ quá hạn đầu tiên là 'đang chờ duyệt', kỳ sau là 'quá hạn — chưa ghi'", async ({ page }) => {
    const homNay = new Date();
    const khoiVay = page.locator("#khoan-vay");

    // Sửa khoản vừa tạo: kéo ngày kỳ đầu về THÁNG TRƯỚC ⇒ kỳ 1 quá hạn.
    const dongKhoan = khoiVay.locator("tbody tr").filter({ hasText: TEN_KHOAN }).first();
    await expect(dongKhoan).toBeVisible();
    await dongKhoan.getByRole("button", { name: `Thao tác ${TEN_KHOAN}` }).click();
    await page.getByRole("menuitem", { name: "Sửa" }).click();
    const form = page.getByRole("dialog");
    // Lùi 2 tháng ⇒ có ÍT NHẤT 2 kỳ quá hạn, đủ để phân biệt "đang chờ duyệt" với "quá hạn — chưa ghi".
    await form.getByLabel("Ngày trả kỳ đầu").fill(format(subMonths(homNay, 2), "yyyy-MM-dd"));
    await form.getByRole("button", { name: "Lưu", exact: true }).click();
    await expect(page.getByText(/Đã cập nhật khoản vay/)).toBeVisible();

    // Scope về khối của CHÍNH khoản này — thẻ gộp mọi khoản, DB e2e có sẵn vài khoản khác.
    const khoi = page
      .getByTestId("lich-tra-no-du-kien")
      .locator('[data-testid^="lich-du-kien-khoan-"]')
      .filter({ hasText: TEN_KHOAN });
    // Kỳ quá hạn KHÔNG bị loại khỏi bảng — bỏ đi thì "Σ 6 kỳ tới" hụt đúng kỳ gần nhất.
    await expect(khoi.locator("tbody tr")).toHaveCount(6);
    // ĐÚNG MỘT kỳ mang "đang chờ duyệt" (thẻ ghi sổ chỉ duyệt tuần tự từng kỳ), các kỳ quá hạn còn
    // lại mang nhãn khác — nếu gắn "đang chờ duyệt" cho cả 2 thì chủ shop tưởng app sót một kỳ.
    await expect(khoi.getByText("đang chờ duyệt")).toHaveCount(1);
    await expect(khoi.getByText("quá hạn — chưa ghi").first()).toBeVisible();
  });
});
