import { expect, test, type Page } from "@playwright/test";
import { format, subDays } from "date-fns";

import { testPrisma } from "./ingest-raw";
import { TEST_USER_EMAIL, TEST_USER_PASSWORD } from "./test-constants";

/**
 * E2E "Cổng D0 cho form Khoản vay + Sổ tiết kiệm" — hai form vừa được thêm cổng hỏi lại giống
 * `cash-movement-form-modal.tsx`: ghi ngày (giải ngân/gửi sổ) sớm hơn D0 (ngày mở sổ quỹ = MIN
 * `CashMovement.date` toàn bảng, KHÔNG cấu hình ở Cài đặt) phải hỏi lại bằng CHÍNH nút Lưu (bấm lần
 * hai mới gửi) — D0 lùi ngày kéo MỌI số Đầu kỳ/Cuối kỳ của các tháng đã xem đổi im lặng. Chế độ "mang
 * sang" (khoản vay đã có từ trước ngày mở sổ) KHÔNG sinh dòng tiền nên KHÔNG bị hỏi dù ngày nền trước
 * D0 — đó là ca BÌNH THƯỜNG (tiền đã nằm trong số dư mở sổ).
 *
 * D0 không cấu hình được — seed một dòng ghi tay để chắc bảng CashMovement không rỗng, rồi ĐỌC LẠI
 * MIN(date) THẬT của bảng: DB e2e tích luỹ dữ liệu từ spec khác (`so-quy-khoan-vay.spec.ts`,
 * `so-tiet-kiem.spec.ts` đều seed dòng lùi vài tháng) nên D0 thật có thể sớm hơn nhiều so với dòng vừa
 * seed — KHÔNG suy diễn D0 từ chính dòng mình vừa tạo.
 *
 * Cách ly: mọi tên/mô tả bắt đầu "E2E D0"; `afterAll` dọn theo đúng thứ tự khoá ngoại (ThuNhap →
 * CashMovement → SoTietKiem/Loan) bằng `testPrisma()` (guard chỉ cho đụng DB e2e), rồi xoá dòng seed.
 */

const PREFIX = "E2E D0";
const TEN_TK_TRUOC_D0 = `${PREFIX} TK truoc mo so`;
const TEN_TK_DUNG_D0 = `${PREFIX} TK dung ngay mo so`;
const TEN_VAY_MOI = `${PREFIX} Vay moi`;
const TEN_VAY_MANG_SANG = `${PREFIX} Vay mang sang`;
const MO_TA_SEED = `${PREFIX} seed`;

// Tính ở `beforeAll`, dùng chung cho mọi test trong file (D0 không đổi trong lúc chạy vì các test
// không tự ghi dòng nào TRƯỚC ngày này).
let ngayThu: string; // D0 − 10 ngày — ca "sớm hơn D0" cho SỔ TIẾT KIỆM, phải hỏi lại.
// D0 − 20 ngày cho KHOẢN VAY: ca sổ tiết kiệm ở trên (khi được xác nhận) ghi SAVINGS_OUT ở D0 − 10 và
// chính nó KÉO D0 LÙI về đó — đúng hiện tượng cổng này cảnh báo. Dùng lại D0 − 10 cho khoản vay là
// "đúng ngày D0 mới" ⇒ không hỏi ⇒ test đỏ oan. Ngày sớm hơn nữa thì trước D0 dù ca nào chạy trước.
let ngayThuVay: string;
let ngayD0: string; // ĐÚNG ngày D0 — ca biên, KHÔNG được hỏi.

async function login(page: Page): Promise<void> {
  await page.goto("/dang-nhap");
  await page.getByLabel("Email").fill(TEST_USER_EMAIL);
  await page.getByLabel("Mật khẩu", { exact: true }).fill(TEST_USER_PASSWORD);
  await page.getByRole("button", { name: "Đăng nhập" }).click();
  await expect(page).toHaveURL("/");
}

test.describe("Cổng D0 — form Khoản vay + Sổ tiết kiệm", () => {
  test.beforeAll(async () => {
    const prisma = testPrisma();

    // Seed một dòng ghi tay CHỈ để chắc bảng không rỗng (kind "CAPITAL_IN" không cần loanId/savingsId)
    // — KHÔNG dùng ngày này làm D0, đọc lại MIN(date) thật ngay bên dưới.
    const mocNgay = new Date();
    mocNgay.setMonth(mocNgay.getMonth() - 1);
    await prisma.cashMovement.create({
      data: { date: mocNgay, kind: "CAPITAL_IN", amount: 1, description: MO_TA_SEED },
    });

    const min = await prisma.cashMovement.aggregate({ _min: { date: true } });
    const d0 = min._min.date!;
    ngayThu = format(subDays(d0, 10), "yyyy-MM-dd");
    ngayThuVay = format(subDays(d0, 20), "yyyy-MM-dd");
    ngayD0 = format(d0, "yyyy-MM-dd");

    await prisma.$disconnect();
  });

  test.afterAll(async () => {
    const prisma = testPrisma();
    await prisma.thuNhap.deleteMany({ where: { soTietKiem: { name: { startsWith: PREFIX } } } });
    await prisma.cashMovement.deleteMany({
      where: {
        OR: [
          { soTietKiem: { name: { startsWith: PREFIX } } },
          { loan: { name: { startsWith: PREFIX } } },
          { description: MO_TA_SEED },
        ],
      },
    });
    await prisma.soTietKiem.deleteMany({ where: { name: { startsWith: PREFIX } } });
    await prisma.loan.deleteMany({ where: { name: { startsWith: PREFIX } } });
    await prisma.$disconnect();
  });

  test.beforeEach(async ({ page }) => {
    await login(page);
  });

  test("Sổ tiết kiệm: ngày gửi sớm hơn D0 → hỏi lại 2 lượt bấm, lượt đầu CHƯA tạo", async ({ page }) => {
    await page.goto("/tai-chinh?tab=dong-tien");
    const khoi = page.locator("#tiet-kiem");
    await khoi.getByRole("button", { name: "+ Thêm sổ tiết kiệm" }).click();
    const form = page.getByRole("dialog");
    await expect(form.getByText("Thêm sổ tiết kiệm", { exact: true })).toBeVisible();

    await form.getByLabel("Tên sổ").fill(TEN_TK_TRUOC_D0);
    await form.getByLabel("Số tiền gửi").fill("10000000");
    await form.getByLabel("Ngày gửi").fill(ngayThu);
    await form.getByLabel("Kỳ hạn (tháng)").fill("6");
    await form.getByLabel("Lãi %/năm").fill("5");

    // Lượt Lưu đầu: chỉ hiện cảnh báo, KHÔNG gửi action — sổ chưa tạo, không toast.
    await form.getByRole("button", { name: "Lưu", exact: true }).click();
    await expect(form.getByText(/sớm hơn ngày mở sổ/)).toBeVisible();
    await expect(page.getByText(`Đã thêm sổ tiết kiệm ${TEN_TK_TRUOC_D0}`)).toHaveCount(0);

    // Lượt hai: nút đổi nhãn, bấm mới thật sự gửi.
    const nutXacNhan = form.getByRole("button", { name: "Xác nhận ghi trước ngày mở sổ", exact: true });
    await expect(nutXacNhan).toBeVisible();
    await nutXacNhan.click();
    await expect(page.getByText(`Đã thêm sổ tiết kiệm ${TEN_TK_TRUOC_D0}`)).toBeVisible();
  });

  test('Khoản vay chế độ "mới": ngày giải ngân sớm hơn D0 → hỏi lại; chế độ "mang sang" cùng ngày → KHÔNG hỏi', async ({
    page,
  }) => {
    await page.goto("/tai-chinh?tab=dong-tien");
    const khoiVay = page.locator("#khoan-vay");

    // --- Ca 2: chế độ "Khoản vay mới" — SINH dòng LOAN_IN, phải hỏi ----------------------------
    await khoiVay.getByRole("button", { name: "+ Thêm khoản vay" }).click();
    const form = page.getByRole("dialog");
    await expect(form.getByText("Thêm khoản vay", { exact: true })).toBeVisible();

    await form.getByLabel("Tên khoản vay").fill(TEN_VAY_MOI);
    await form.getByLabel("Ngân hàng / người cho vay").fill("NH E2E");
    await form.getByLabel("Số tiền giải ngân").fill("5000000");
    await form.getByLabel("Ngày giải ngân").fill(ngayThuVay);
    // Form kiểm lãi suất TRƯỚC cổng D0 — thiếu ô này là dừng ở lỗi lãi, không bao giờ tới câu hỏi.
    await form.getByLabel("Lãi %/năm").fill("10");
    await form.getByLabel("Kỳ hạn (số kỳ còn lại)").fill("12");

    await form.getByRole("button", { name: "Lưu", exact: true }).click();
    await expect(form.getByText(/Ngày giải ngân sớm hơn ngày mở sổ/)).toBeVisible();
    // Chế độ "mới" CÓ lối "đã có từ trước" ⇒ câu nhắc thêm phải hiện.
    await expect(form.getByText(/chọn cách khai "đã có từ trước"/)).toBeVisible();
    await expect(page.getByText(`Đã thêm khoản vay ${TEN_VAY_MOI}`)).toHaveCount(0);

    const nutXacNhanVay = form.getByRole("button", {
      name: "Xác nhận ghi trước ngày mở sổ",
      exact: true,
    });
    await expect(nutXacNhanVay).toBeVisible();
    await nutXacNhanVay.click();
    await expect(page.getByText(`Đã thêm khoản vay ${TEN_VAY_MOI}`)).toBeVisible();

    // --- Ca 2b: chế độ "mang sang" cùng ngày nền → KHÔNG sinh dòng tiền, KHÔNG hỏi -------------
    await khoiVay.getByRole("button", { name: "+ Thêm khoản vay" }).click();
    const form2 = page.getByRole("dialog");
    await expect(form2.getByText("Thêm khoản vay", { exact: true })).toBeVisible();

    await form2.getByLabel("Tên khoản vay").fill(TEN_VAY_MANG_SANG);
    await form2.getByLabel("Ngân hàng / người cho vay").fill("NH E2E");
    await form2.getByLabel("Khoản vay đã có từ trước ngày mở sổ").click();
    await form2.getByLabel("Dư nợ còn lại").fill("3000000");
    await form2.getByLabel("Tính từ ngày").fill(ngayThuVay);
    await form2.getByLabel("Lãi %/năm").fill("10");
    await form2.getByLabel("Kỳ hạn (số kỳ còn lại)").fill("12");

    // Lưu MỘT lượt duy nhất — không cảnh báo, không đổi nhãn nút.
    await form2.getByRole("button", { name: "Lưu", exact: true }).click();
    await expect(page.getByText(`Đã thêm khoản vay ${TEN_VAY_MANG_SANG}`)).toBeVisible();
  });

  test("Đúng ngày D0 → không hỏi (sổ tiết kiệm lưu ngay lượt đầu)", async ({ page }) => {
    await page.goto("/tai-chinh?tab=dong-tien");
    const khoi = page.locator("#tiet-kiem");
    await khoi.getByRole("button", { name: "+ Thêm sổ tiết kiệm" }).click();
    const form = page.getByRole("dialog");
    await expect(form.getByText("Thêm sổ tiết kiệm", { exact: true })).toBeVisible();

    await form.getByLabel("Tên sổ").fill(TEN_TK_DUNG_D0);
    await form.getByLabel("Số tiền gửi").fill("10000000");
    await form.getByLabel("Ngày gửi").fill(ngayD0);
    await form.getByLabel("Kỳ hạn (tháng)").fill("6");
    await form.getByLabel("Lãi %/năm").fill("5");

    await form.getByRole("button", { name: "Lưu", exact: true }).click();
    await expect(page.getByText(`Đã thêm sổ tiết kiệm ${TEN_TK_DUNG_D0}`)).toBeVisible();
  });
});
