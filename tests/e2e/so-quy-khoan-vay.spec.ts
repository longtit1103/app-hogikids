import { expect, test, type Page } from "@playwright/test";
import { addMonths, format, subMonths } from "date-fns";

import { testPrisma } from "./ingest-raw";
import { TEST_USER_EMAIL, TEST_USER_PASSWORD } from "./test-constants";

/**
 * E2E "Sổ quỹ + Khoản vay" — tab Dòng tiền. Đi TRỌN vòng qua UI: tạo khoản vay khai lùi 3 tháng →
 * app tự xếp 3 kỳ đã tới hạn vào hàng chờ duyệt → sửa số lãi → duyệt → lãi vào Sổ chi phí (danh mục
 * Lãi vay), gốc vào dòng tiền, dư nợ giảm đúng 1.200.000 / 12 kỳ = 100.000. Rồi banner shell nhắc
 * việc ở Dashboard, và nút "Ngân hàng không thu kỳ này" đóng dấu kỳ + để vết vào ghi chú.
 *
 * Khai lùi 3 tháng (kỳ đầu −2 tháng) là CỐ Ý: cần ít nhất 3 kỳ đã tới hạn để sau khi duyệt kỳ 1 và
 * bỏ qua kỳ 2 vẫn còn một kỳ kế hiện ra — đó là thứ ca "bỏ qua kỳ" phải chứng minh.
 *
 * Số cụ thể là số TÍNH TAY theo spec §5.2 — không suy lại bằng chính công thức đang kiểm.
 *
 * Cách ly: tên khoản vay bắt đầu "E2E"; `beforeAll` dọn theo đúng thứ tự khoá ngoại (Expense →
 * CashMovement gắn khoản → Loan) bằng `testPrisma()` (guard chỉ cho đụng DB e2e). KHÔNG assert số
 * quỹ tuyệt đối — dữ liệu e2e tích luỹ từ spec khác.
 */

const TEN_KHOAN = "E2E VPBank";
const TEN_THAU_CHI = "E2E Thấu chi";
const TEN_GOC_CUOI_KY = "E2E Gốc cuối kỳ";

/** Mùng 10 kế tiếp — bản sao literal của `mongMuoiKeTiep` ở UI, cố ý KHÔNG import (kiểm số bằng
 *  chính hàm đang kiểm là phép kiểm rỗng). */
function mongMuoiKeTiep(ngay: Date): string {
  const thang = ngay.getDate() < 10 ? ngay : addMonths(ngay, 1);
  return format(new Date(thang.getFullYear(), thang.getMonth(), 10), "yyyy-MM-dd");
}

/** Chọn 1 mục trong base-ui Select trong dialog (trigger hiện `placeholder`) — cùng helper với chi-phi.spec. */
async function pickSelectOption(page: Page, placeholder: string, optionName: string): Promise<void> {
  await page.getByText(placeholder, { exact: true }).click();
  await page.getByRole("option", { name: optionName, exact: true }).click();
}

async function login(page: Page): Promise<void> {
  await page.goto("/dang-nhap");
  await page.getByLabel("Email").fill(TEST_USER_EMAIL);
  await page.getByLabel("Mật khẩu", { exact: true }).fill(TEST_USER_PASSWORD);
  await page.getByRole("button", { name: "Đăng nhập" }).click();
  await expect(page).toHaveURL("/");
}

test.describe("Sổ quỹ + Khoản vay — tab Dòng tiền", () => {
  test.beforeAll(async () => {
    const prisma = testPrisma();
    await prisma.expense.deleteMany({ where: { description: { contains: "E2E" } } });
    await prisma.cashMovement.deleteMany({ where: { loan: { name: { startsWith: "E2E" } } } });
    await prisma.loan.deleteMany({ where: { name: { startsWith: "E2E" } } });
    await prisma.$disconnect();
  });

  test.beforeEach(async ({ page }) => {
    await login(page);
  });

  test("tạo khoản vay khai lùi ngày → duyệt kỳ 1 → lãi vào Sổ chi phí, dư nợ giảm 100.000", async ({ page }) => {
    const homNay = new Date();
    const ngayGiaiNgan = format(subMonths(homNay, 3), "yyyy-MM-dd");
    const ngayKyDau = format(subMonths(homNay, 2), "yyyy-MM-dd");

    await page.goto("/tai-chinh?tab=dong-tien");
    const khoiVay = page.locator("#khoan-vay");
    await expect(khoiVay).toBeVisible();

    // --- Tạo khoản vay -------------------------------------------------------------------
    await khoiVay.getByRole("button", { name: "+ Thêm khoản vay" }).click();
    const form = page.getByRole("dialog");
    await expect(form.getByText("Thêm khoản vay", { exact: true })).toBeVisible();

    await form.getByLabel("Tên khoản vay").fill(TEN_KHOAN);
    await form.getByLabel("Ngân hàng / người cho vay").fill("VPBank");
    await form.getByLabel("Số tiền giải ngân").fill("1200000");
    await form.getByLabel("Ngày giải ngân").fill(ngayGiaiNgan);
    await form.getByLabel("Lãi %/năm").fill("10.5");
    await form.getByLabel("Kỳ hạn (số kỳ còn lại)").fill("12");
    await form.getByLabel("Ngày trả kỳ đầu").fill(ngayKyDau);
    // Khai lùi ngày ⇒ form phải nói trước SỐ kỳ sẽ xếp hàng chờ duyệt, không chỉ "sẽ có kỳ".
    await expect(form.getByText(/Sẽ có \d+ kỳ chờ duyệt/)).toBeVisible();
    await form.getByRole("button", { name: "Lưu", exact: true }).click();

    await expect(page.getByText(`Đã thêm khoản vay ${TEN_KHOAN}`)).toBeVisible();
    const dongKhoan = khoiVay.locator("tbody tr").filter({ hasText: TEN_KHOAN });
    await expect(dongKhoan).toContainText("1.200.000");
    await expect(dongKhoan).toContainText("10,5%/năm");
    await expect(dongKhoan).toContainText("Đang vay");

    // --- Thẻ kỳ trả nợ chờ duyệt --------------------------------------------------------
    await expect(khoiVay.getByText(/kỳ \d{2}\/\d{2} → \d{2}\/\d{2}/)).toBeVisible();
    await khoiVay.getByLabel("Lãi", { exact: true }).fill("12345");
    // Gốc đề xuất = 1.200.000 / 12 kỳ, app tính sẵn — không gõ đè để kiểm luôn con số đó.
    await expect(khoiVay.getByLabel("Gốc", { exact: true })).toHaveValue("100.000");

    await khoiVay.getByRole("button", { name: "Đã chuyển tiền — ghi vào sổ" }).click();
    const xacNhan = page.getByRole("dialog");
    await expect(xacNhan.getByText(/Chỉ bấm khi đã chuyển tiền cho ngân hàng/)).toBeVisible();
    await xacNhan.getByRole("button", { name: "Ghi vào sổ", exact: true }).click();

    await expect(page.getByText(/Đã ghi lãi 12\.345 ₫ \+ gốc 100\.000 ₫/)).toBeVisible();

    // --- Kỳ 2 hiện ngay tại chỗ: thẻ phải MANG SỐ CỦA KỲ 2, không giữ số vừa gõ cho kỳ 1 ---
    // (key của thẻ gồm ngày đến hạn ⇒ remount. Thiếu nó, bấm tiếp là ghi đúng số tiền của kỳ TRƯỚC.)
    await expect(khoiVay).toContainText(`kỳ ${format(subMonths(homNay, 2), "dd/MM")} →`);
    await expect(khoiVay.getByLabel("Lãi", { exact: true })).not.toHaveValue("12.345");

    // --- Dư nợ giảm đúng 100.000 ---------------------------------------------------------
    await expect(khoiVay.locator("tbody tr").filter({ hasText: TEN_KHOAN })).toContainText("1.100.000");
    // Thẻ Quỹ đã mở sổ (dòng LOAN_IN là dòng ghi tay đầu tiên nếu DB e2e còn trống).
    await expect(page.getByText(/tính từ \d{2}\/\d{2}\/\d{4} — ngày nhập quỹ đầu tiên/)).toBeVisible();

    // --- Lãi nằm ở Sổ chi phí, danh mục Lãi vay ------------------------------------------
    const tu = format(subMonths(homNay, 3), "yyyy-MM-dd");
    const den = format(homNay, "yyyy-MM-dd");
    await page.goto(`/tai-chinh?tab=so-chi-phi&danh_muc=interest&tu=${tu}&den=${den}`);
    const dongLai = page.locator("tbody tr").filter({ hasText: `Lãi vay ${TEN_KHOAN}` });
    await expect(dongLai).toHaveCount(1);
    await expect(dongLai).toContainText("12.345");
  });

  /**
   * PHỤ THUỘC test trên: khoản vay + kỳ 1 đã duyệt do test đầu tạo ra (`workers: 1`, `fullyParallel:
   * false` nên thứ tự chắc chắn). Playwright retry chạy lại CẢ FILE nên `beforeAll` dọn rồi dựng lại
   * từ đầu — không có ca chạy test này trên dữ liệu nửa vời.
   */
  test("kỳ đã duyệt sinh ĐÚNG 1 dòng trả gốc; ô chọn khoản vay hiện dư nợ hiện hành", async ({ page }) => {
    // Banner shell là đường DUY NHẤT chủ shop biết có việc phải duyệt khi không mở tab Dòng tiền —
    // `beforeEach` vừa đăng nhập nên đang đứng ở Dashboard.
    await expect(
      page.getByRole("link", { name: /khoản vay có kỳ trả nợ tới hạn chưa ghi/ })
    ).toBeVisible();

    // Duyệt kỳ chỉ được ghi MỘT lần — con dấu `lastDueHandled` + `Expense.refId` unique.
    const prisma = testPrisma();
    const soDongGoc = await prisma.cashMovement.count({
      where: { loan: { name: TEN_KHOAN }, kind: "LOAN_REPAY" },
    });
    const soDongLai = await prisma.expense.count({
      where: { categoryId: "interest", description: { contains: TEN_KHOAN } },
    });
    await prisma.$disconnect();
    expect(soDongGoc).toBe(1);
    expect(soDongLai).toBe(1);

    // Menu ⋯: khoản đã ghi kỳ thì KHÔNG xoá được — nhưng mục "Xoá" vẫn HIỆN và bấm vào phải nói
    // thẳng lý do. Bản cũ ẩn hẳn mục đó: chủ shop khai nhầm không thấy đường nào, cũng không biết vì
    // sao. Luật chặn không đổi — hộp này không có nút ghi, chỉ có "Đã hiểu".
    await page.goto("/tai-chinh?tab=dong-tien");
    const khoiVay = page.locator("#khoan-vay");
    await khoiVay.getByRole("button", { name: `Thao tác ${TEN_KHOAN}` }).click();
    await expect(page.getByRole("menuitem", { name: "Tất toán", exact: true })).toBeVisible();
    await page.getByRole("menuitem", { name: "Xoá", exact: true }).click();
    const hopXoa = page.getByRole("dialog");
    await expect(hopXoa.getByText("Không xoá được khoản vay", { exact: true })).toBeVisible();
    await expect(hopXoa.getByText("đã có dòng trả gốc", { exact: false })).toBeVisible();
    await hopXoa.getByRole("button", { name: "Đã hiểu", exact: true }).click();

    // Ô chọn khoản vay trong modal ghi tay đọc CÙNG con số dư nợ với bảng khoản vay.
    await page.locator("#ghi-tay").getByRole("button", { name: "+ Nhập quỹ" }).click();
    const modal = page.getByRole("dialog");
    await expect(modal.getByText("Nhập quỹ / rút quỹ", { exact: true })).toBeVisible();
    await pickSelectOption(page, "Chọn loại khoản", "Trả nợ gốc");
    await modal.getByText("Chọn khoản vay", { exact: true }).click();
    await expect(
      page.getByRole("option", { name: `${TEN_KHOAN} — dư nợ 1.100.000 ₫`, exact: true })
    ).toBeVisible();
  });

  /**
   * PHỤ THUỘC hai test trên (kỳ 1 đã duyệt ⇒ kỳ 2 đang chờ). Nút "Ngân hàng không thu kỳ này" đóng
   * dấu kỳ VĨNH VIỄN — không có đường mở lại — nên vết trong `Loan.note` là thứ duy nhất giải thích
   * được về sau; kiểm thẳng ở DB vì UI không in ghi chú ra bảng.
   */
  test("bỏ qua kỳ → kỳ kế hiện ra, ghi chú khoản vay mang vết 'Bỏ qua kỳ'", async ({ page }) => {
    // Neo theo ĐÚNG ngày kỳ đầu đã khai rồi cộng tháng như app (`addMonths`), KHÔNG suy lại bằng
    // `subMonths(homNay, 1)`: hai phép đó lệch nhau ở tháng thiếu ngày (khai 31/01 ⇒ kỳ kế 28/02,
    // cộng tháng ra 28/02 nhưng trừ tháng từ hôm nay ra 31/01) — CI sẽ đỏ giả vài ngày mỗi năm.
    const homNay = new Date();
    const ngayKyDau = subMonths(homNay, 2);
    await page.goto("/tai-chinh?tab=dong-tien");
    const khoiVay = page.locator("#khoan-vay");
    await expect(khoiVay).toContainText(`kỳ ${format(ngayKyDau, "dd/MM")} →`);

    await khoiVay.getByRole("button", { name: "Ngân hàng không thu kỳ này" }).click();
    const hop = page.getByRole("dialog");
    await expect(hop.getByText(/KHÔNG mở lại được/)).toBeVisible();
    await hop.getByRole("button", { name: "Bỏ qua kỳ", exact: true }).click();

    await expect(page.getByText(/Đã đánh dấu kỳ .* không thu/)).toBeVisible();
    // Kỳ kế hiện ngay tại chỗ — mốc đầu kỳ = ngày trả kỳ 2 = kỳ đầu + 1 tháng.
    await expect(khoiVay).toContainText(`kỳ ${format(addMonths(ngayKyDau, 1), "dd/MM")} →`);

    const prisma = testPrisma();
    const loan = await prisma.loan.findFirstOrThrow({ where: { name: TEN_KHOAN } });
    const soDongGoc = await prisma.cashMovement.count({
      where: { loan: { name: TEN_KHOAN }, kind: "LOAN_REPAY" },
    });
    await prisma.$disconnect();
    // Bỏ qua kỳ CHỈ đóng dấu + để vết: không sinh thêm lãi lẫn gốc.
    expect(loan.note).toContain("Bỏ qua kỳ");
    expect(soDongGoc).toBe(1);
  });

  /**
   * Thấu chi (spec `plans/260908-1751-thau-chi-khoan-vay/design.md` §6–§7) — KHÔNG phụ thuộc 3 test
   * trên (khoản riêng, tên bắt đầu "E2E Thấu chi"), nhưng CHẠY SAU chúng nên thẻ kỳ của "E2E VPBank"
   * (kỳ 3 đang chờ, do test "bỏ qua kỳ" để lại) vẫn còn trên trang — mọi thẻ kỳ phải lọc theo
   * `hasText: TEN_THAU_CHI`, không dùng `getByText` chuỗi ngắn + `.first()`.
   */
  test("thấu chi: tạo khoản → duyệt kỳ lãi → tất toán trả trọn gốc + lãi, dư nợ về 0", async ({
    page,
  }) => {
    const homNay = new Date();
    const ngayRut = format(subMonths(homNay, 2), "yyyy-MM-dd");
    const mocKyDauLai = subMonths(homNay, 1);
    const ngayKyDauLai = format(mocKyDauLai, "yyyy-MM-dd");

    await page.goto("/tai-chinh?tab=dong-tien");
    const khoiVay = page.locator("#khoan-vay");
    await expect(khoiVay).toBeVisible();

    // --- Tạo khoản thấu chi --------------------------------------------------------------
    await khoiVay.getByRole("button", { name: "+ Thêm khoản vay" }).click();
    const form = page.getByRole("dialog");
    await expect(form.getByText("Thêm khoản vay", { exact: true })).toBeVisible();

    await form.getByLabel("Tên khoản vay").fill(TEN_THAU_CHI);
    await form.getByLabel("Ngân hàng / người cho vay").fill("VPBank");
    await form.getByLabel("Thấu chi (lãi tính theo ngày)").click();
    // Chọn chế độ Thấu chi PHẢI tự đặt lại "Ngày thu lãi kỳ đầu" = mùng 10 kế tiếp (spec §6). Trước
    // đây prefill chỉ chạy khi ĐỔI ô Ngày rút, nên chọn radio rồi lưu luôn là ghi lịch "+1 tháng".
    await expect(form.getByLabel("Ngày thu lãi kỳ đầu")).toHaveValue(mongMuoiKeTiep(homNay));
    await form.getByLabel("Số tiền rút thấu chi").fill("1000000");
    await form.getByLabel("Ngày rút").fill(ngayRut);
    await form.getByLabel("Lãi %/năm").fill("12");
    // "Ngân hàng thu lãi hàng tháng" mặc định BẬT — không cần bấm; chỉ sửa lại ngày kỳ đầu.
    await form.getByLabel("Ngày thu lãi kỳ đầu").fill(ngayKyDauLai);
    await form.getByRole("button", { name: "Lưu", exact: true }).click();

    await expect(page.getByText(`Đã thêm khoản vay ${TEN_THAU_CHI}`)).toBeVisible();
    const dongThauChi = khoiVay.locator("tbody tr").filter({ hasText: TEN_THAU_CHI });
    await expect(dongThauChi).toContainText("thấu chi");
    await expect(dongThauChi).toContainText("1.000.000");

    // --- Thẻ kỳ LÃI chờ duyệt (lọc riêng khoản này, khoản "E2E VPBank" vẫn còn thẻ trên trang) ---
    const theKyLai = khoiVay.locator(".border-warning").filter({ hasText: TEN_THAU_CHI });
    await expect(theKyLai).toBeVisible();
    await expect(theKyLai.getByText("kỳ lãi")).toBeVisible();
    // Gốc đề xuất = 0 (thấu chi chỉ thu lãi mỗi kỳ) — ô tiền hiện "0" bằng cách để TRỐNG
    // (`formatAmountInput`), cùng quy ước với mọi ô tiền khác trong app.
    await expect(theKyLai.getByLabel("Gốc", { exact: true })).toHaveValue("");
    await theKyLai.getByLabel("Lãi", { exact: true }).fill("5000");

    await theKyLai.getByRole("button", { name: "Đã chuyển tiền — ghi vào sổ" }).click();
    const xacNhanKy = page.getByRole("dialog");
    await expect(xacNhanKy.getByText(/Chỉ bấm khi đã chuyển tiền cho ngân hàng/)).toBeVisible();
    await xacNhanKy.getByRole("button", { name: "Ghi vào sổ", exact: true }).click();
    await expect(page.getByText(/Đã ghi lãi 5\.000 ₫ \+ gốc 0 ₫/)).toBeVisible();

    // `router.refresh()` sau lượt duyệt kỳ là BẤT ĐỒNG BỘ: mở hộp Tất toán ngay lúc này thì dòng
    // khoản vay vẫn là ảnh chụp CŨ (con dấu null) nên hộp đề xuất lãi tính TRÙNG đoạn kỳ vừa thu —
    // và `tatToanThauChi` từ chối đúng luật đó. Tải lại trang = đúng thứ chủ shop thấy sau khi
    // trang tự làm mới xong.
    await page.reload();

    // --- Tất toán: menu ⋯ mở hộp riêng thấu chi (không phải hộp "Tất toán khoản vay" chung) -----
    await khoiVay.getByRole("button", { name: `Thao tác ${TEN_THAU_CHI}` }).click();
    await page.getByRole("menuitem", { name: "Tất toán", exact: true }).click();
    const hopTatToan = page.getByRole("dialog");
    await expect(hopTatToan.getByText(`Tất toán ${TEN_THAU_CHI}`, { exact: true })).toBeVisible();
    await expect(hopTatToan).toContainText("1.000.000");
    // Mốc tính lãi phải là CON DẤU kỳ vừa duyệt, không phải ngày rút — in ra để chủ shop soi được
    // hộp đang tính từ đâu (ảnh chụp cũ sẽ hiện ngày rút).
    await expect(hopTatToan).toContainText(`Lãi — từ ${format(mocKyDauLai, "dd/MM/yyyy")}`);
    await hopTatToan.getByRole("button", { name: "Đã chuyển tiền — tất toán" }).click();

    await expect(page.getByText(new RegExp(`Đã tất toán ${TEN_THAU_CHI}: lãi .* \\+ gốc 1\\.000\\.000`))).toBeVisible();
    await expect(dongThauChi).toContainText("Đã tất toán");
    // Neo ĐÚNG ô "Dư nợ gốc" (cột 6) và so BẰNG: `toContainText("0 ₫")` là phép kiểm mù — mọi số
    // tròn nghìn đều chứa chuỗi đó, dư nợ 1.000.000 còn treo vẫn xanh.
    await expect(dongThauChi.locator("td").nth(5)).toHaveText("0 ₫");
  });

  /**
   * Vay trả gốc cuối kỳ (`Loan.kind=BULLET`, thêm 2026-09-10) — chỉ kiểm RADIO thứ tư xuất hiện đúng
   * chỗ và câu đếm kỳ chờ duyệt đúng số, KHÔNG đi trọn vòng duyệt kỳ/tất toán (36 kỳ qua UI thật là
   * phi thực tế; vòng đời đầy đủ đã có ở `khoan-vay-actions.integration.test.ts`).
   *
   * "Sẽ có 4 kỳ chờ duyệt" phải ĐÚNG SỐ bất kể hôm nay là ngày nào trong tháng — neo kỳ đầu vào NGÀY
   * 1 (ngày duy nhất tồn tại ở MỌI tháng, không bị `addMonths` kẹp) của tháng cách đây 3 tháng: kỳ 4
   * rơi đúng ngày 1 THÁNG NÀY (luôn ≤ hôm nay dù hôm nay là ngày mấy), kỳ 5 rơi ngày 1 THÁNG SAU (luôn
   * > hôm nay). Neo theo ngày-trong-tháng thật của `homNay` (như hai test trên) sẽ SAI vài ngày mỗi
   * năm ở tháng thiếu ngày — đúng bẫy đã ghi ở test "bỏ qua kỳ" phía trên.
   */
  test('form khoản vay hiện đủ 4 chế độ; chọn "Vay trả gốc cuối kỳ" báo đúng "Sẽ có 4 kỳ chờ duyệt"', async ({
    page,
  }) => {
    const homNay = new Date();
    const ngayGiaiNgan = format(new Date(homNay.getFullYear(), homNay.getMonth() - 4, 1), "yyyy-MM-dd");
    const ngayKyDau = format(new Date(homNay.getFullYear(), homNay.getMonth() - 3, 1), "yyyy-MM-dd");

    await page.goto("/tai-chinh?tab=dong-tien");
    const khoiVay = page.locator("#khoan-vay");
    await khoiVay.getByRole("button", { name: "+ Thêm khoản vay" }).click();
    const form = page.getByRole("dialog");
    await expect(form.getByText("Thêm khoản vay", { exact: true })).toBeVisible();

    // Đủ 4 chế độ — radio thứ tư là loại mới thêm 2026-09-10.
    await expect(form.getByLabel("Khoản vay mới")).toBeVisible();
    await expect(form.getByLabel("Khoản vay đã có từ trước ngày mở sổ")).toBeVisible();
    await expect(form.getByLabel("Thấu chi (lãi tính theo ngày)")).toBeVisible();
    await expect(form.getByLabel("Vay trả gốc cuối kỳ (lãi cố định hàng tháng)")).toBeVisible();

    await form.getByLabel("Tên khoản vay").fill(TEN_GOC_CUOI_KY);
    await form.getByLabel("Ngân hàng / người cho vay").fill("NH Chính sách");
    await form.getByLabel("Vay trả gốc cuối kỳ (lãi cố định hàng tháng)").click();

    await form.getByLabel("Số tiền giải ngân").fill("200000000");
    // Fill "Ngày giải ngân" TRƯỚC — nó tự prefill "Ngày trả kỳ đầu" theo mùng 10 kế tiếp; ghi đè bằng
    // giá trị mong muốn ở dòng SAU (cùng thứ tự với hai test "thấu chi"/"VPBank" phía trên).
    await form.getByLabel("Ngày giải ngân").fill(ngayGiaiNgan);
    await form.getByLabel("Kỳ hạn (số kỳ)").fill("36");
    await form.getByLabel("Ngày trả kỳ đầu").fill(ngayKyDau);

    await expect(form.getByText("Sẽ có 4 kỳ chờ duyệt — duyệt lần lượt từng kỳ.")).toBeVisible();

    // Mặc định khai lãi CỐ ĐỊNH (công tắc "%/năm" tắt) — ô "Lãi cố định mỗi kỳ" hiện sẵn, không cần
    // bật công tắc trước.
    await form.getByLabel("Lãi cố định mỗi kỳ").fill("1121096");
    await form.getByLabel("Tiền gửi tiết kiệm bắt buộc mỗi kỳ").fill("300000");
    await form.getByRole("button", { name: "Lưu", exact: true }).click();

    await expect(page.getByText(`Đã thêm khoản vay ${TEN_GOC_CUOI_KY}`)).toBeVisible();
    const dongKhoan = khoiVay.locator("tbody tr").filter({ hasText: TEN_GOC_CUOI_KY });
    await expect(dongKhoan).toContainText("200.000.000");
    await expect(dongKhoan).toContainText("36 kỳ");
  });
});
