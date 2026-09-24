import { expect, test, type Page } from "@playwright/test";

import { formatVnd } from "@/lib/format";

import { testPrisma } from "./ingest-raw";
import { TEST_USER_EMAIL, TEST_USER_PASSWORD } from "./test-constants";

/**
 * E2E tab "Sổ quỹ" (dòng chạy) — `/tai-chinh?tab=so-quy`: mở sổ bằng một dòng ghi tay + thêm một
 * khoản chi qua UI ⇒ Sổ quỹ hiện đúng 2 dòng, số dư chạy đúng, "Cuối kỳ" khớp thẻ Quỹ tab Dòng tiền
 * cùng tháng.
 *
 * DB e2e local tích luỹ CashMovement/Expense từ spec khác, còn DB e2e trên CI có thể CHƯA mở sổ
 * (mới tinh) — không giả định số tuyệt đối, chỉ so DELTA quanh khoản chi tự thêm SAU khi sổ đã mở. Trạng thái CHƯA MỞ SỔ CỐ Ý
 * không kiểm ở đây: tái tạo nó phải xoá TẠM cả bảng `CashMovement` của DB dùng chung, mà tiến trình bị
 * giết giữa chừng (timeout, Ctrl-C) thì `finally` không chạy ⇒ mọi spec Sổ quỹ khác đỏ không rõ lý do.
 * Ba trạng thái đã được test tích hợp của lõi phủ (`tests/so-quy/dong-chay-so-quy.integration.test.ts`).
 */

async function login(page: Page): Promise<void> {
  await page.goto("/dang-nhap");
  await page.getByLabel("Email").fill(TEST_USER_EMAIL);
  await page.getByLabel("Mật khẩu", { exact: true }).fill(TEST_USER_PASSWORD);
  await page.getByRole("button", { name: "Đăng nhập" }).click();
  await expect(page).toHaveURL("/");
}

/** Chọn 1 mục trong base-ui Select trong dialog (trigger hiện `placeholder`) — cùng helper với các spec khác. */
async function pickSelectOption(page: Page, placeholder: string, optionName: string): Promise<void> {
  await page.getByText(placeholder, { exact: true }).click();
  await page.getByRole("option", { name: optionName, exact: true }).click();
}

/** "1.234.567 ₫" / "−1.234.567 ₫" ⇒ số — cùng helper với `chot-so-du-cuoi-thang.spec.ts`. */
function docTien(text: string): number {
  const am = /[-−]/.test(text);
  const n = Number(text.replace(/\D/g, ""));
  return am ? -n : n;
}

/**
 * Đọc "Cuối kỳ" của thẻ Quỹ (tab Dòng tiền, `so-quy-card.tsx`) bằng text + DOM sibling — thẻ đó
 * không có `data-testid` riêng cho số này. Regex loại trừ nhãn "Cuối kỳ (sổ quỹ)" của thẻ Chốt số dư
 * cuối tháng (khác thẻ, trùng chữ đầu). Chỉ gọi khi sổ ĐÃ mở — chưa mở thì thẻ không có ô này.
 */
async function docCuoiKyTheQuy(page: Page): Promise<number> {
  const nhan = page.locator("p", { hasText: /^Cuối kỳ(?!\s\(sổ)/ }).first();
  const gia = nhan.locator("xpath=following-sibling::p[1]");
  return docTien((await gia.innerText()).trim());
}

test.describe("Sổ quỹ (dòng chạy) — tab Sổ quỹ", () => {
  const descThu = `E2E so quy dong chay thu ${Date.now()}`;
  const descChi = `E2E so quy dong chay chi ${Date.now()}`;

  test.beforeAll(async () => {
    const prisma = testPrisma();
    await prisma.cashMovement.deleteMany({ where: { description: descThu } });
    await prisma.expense.deleteMany({ where: { description: descChi } });
    await prisma.$disconnect();
  });

  test.afterAll(async () => {
    const prisma = testPrisma();
    await prisma.cashMovement.deleteMany({ where: { description: descThu } });
    await prisma.expense.deleteMany({ where: { description: descChi } });
    await prisma.$disconnect();
  });

  test.beforeEach(async ({ page }) => {
    await login(page);
  });

  test("mở sổ bằng 1 dòng ghi tay + 1 khoản chi ⇒ Sổ quỹ hiện đúng 2 dòng, Cuối kỳ khớp thẻ Quỹ", async ({
    page,
  }) => {
    // ① Thêm khoản Thu khác qua UI (ghi tay) — cùng luồng `tien-vao-khac.spec.ts`. Ghi TRƯỚC khi đọc
    // mốc: trên DB e2e mới tinh (CI) sổ CHƯA mở, và dòng ghi tay đầu tiên mở sổ với ngày mở = hôm nay
    // ⇒ mọi chi phí spec khác đã ghi hôm nay cũng vào quỹ cùng lúc. Mốc đọc trước khi mở sổ vì thế vô
    // nghĩa; mốc đọc SAU khi sổ đã mở thì delta quanh khoản chi dưới đây luôn đúng.
    await page.goto("/tai-chinh?tab=dong-tien");
    const THU = 777_779;
    await page.locator("#ghi-tay").getByRole("button", { name: "+ Nhập quỹ" }).click();
    let dialog = page.getByRole("dialog");
    await pickSelectOption(page, "Chọn loại khoản", "Thu khác");
    await dialog.getByPlaceholder("0").fill(String(THU));
    await dialog.locator("textarea").fill(descThu);
    await dialog.getByRole("button", { name: "Lưu" }).click();
    await expect(page.getByText(/Đã ghi Thu khác/)).toBeVisible();

    // ② Cuối kỳ thẻ Quỹ khi sổ đã chắc chắn mở — mốc để tính delta, không giả định số tuyệt đối.
    await page.goto("/tai-chinh?tab=dong-tien");
    const truoc = await docCuoiKyTheQuy(page);

    // ③ Thêm khoản chi phí qua UI — cùng luồng `chi-phi.spec.ts`.
    const CHI = 234_567;
    await page.goto("/tai-chinh?tab=so-chi-phi");
    await page.getByRole("button", { name: "+ Thêm chi phí" }).first().click();
    dialog = page.getByRole("dialog");
    await pickSelectOption(page, "Chọn danh mục", "Đóng gói");
    await dialog.getByPlaceholder("0").fill(String(CHI));
    await dialog.locator("textarea").fill(descChi);
    await dialog.getByRole("button", { name: "Lưu" }).click();
    await expect(page.getByText(/Đã thêm chi phí/)).toBeVisible();

    // ④ Cuối kỳ thẻ Quỹ sau khoản chi = mốc − Chi.
    await page.goto("/tai-chinh?tab=dong-tien");
    const sau = await docCuoiKyTheQuy(page);
    expect(sau).toBe(truoc - CHI);

    // ⑤ Tab Sổ quỹ: đúng 2 dòng mang tên mình, KHÔNG banner lệch, Cuối kỳ = số vừa đọc ở ④.
    await page.goto("/tai-chinh?tab=so-quy");
    await expect(page.getByTestId("so-quy-dong-chay-lech")).toHaveCount(0);

    const rowThu = page.getByTestId("so-quy-dong-chay-row").filter({ hasText: descThu });
    await expect(rowThu).toBeVisible();
    await expect(rowThu).toContainText("Ghi tay");
    await expect(rowThu).toContainText(formatVnd(THU));

    const rowChi = page.getByTestId("so-quy-dong-chay-row").filter({ hasText: descChi });
    await expect(rowChi).toBeVisible();
    await expect(rowChi).toContainText("Chi phí");
    await expect(rowChi).toContainText(formatVnd(CHI));

    const cuoiKyDongChay = docTien((await page.getByTestId("so-quy-dong-chay-cuoi-ky").innerText()).trim());
    expect(cuoiKyDongChay).toBe(sau);

    // ⑥ Số dư chạy đúng: dòng CUỐI CÙNG của bảng (bất kể của ai) phải khớp đúng Cuối kỳ — chứng minh
    // chuỗi cộng dồn đầuKỳ→...→cuốiKỳ không rớt dòng nào (`dungDongChay` cộng dồn `soDu` từ `dauKy`).
    const lastRow = page.getByTestId("so-quy-dong-chay-row").last();
    await expect(lastRow).toContainText(formatVnd(cuoiKyDongChay));

    // ⑦ Nhãn "Cuối kỳ" (bảo toàn — không tạo khoản ngày SAU hôm nay qua UI: server chặn future date
    // cho GHI_TAY/CHI_PHI ở `ngayGhiTaySchema`, chi phí định kỳ backfill cũng chỉ sinh tới hôm nay
    // (`ensure-recurring-expenses.ts`); nguồn còn lại tạo future date được CHỈ qua duyệt kỳ trả nợ
    // trước hạn — đụng state Loan dùng chung, không tái tạo AN TOÀN ở spec này, nên chỉ khoá NHÁNH
    // THƯỜNG): hai dòng vừa thêm đều ngày hôm nay ⇒ không mang dấu "(dự kiến)"; và khi ô "Quỹ tới hôm
    // nay" không hiện thì nhãn "Cuối kỳ" phải trơn, không phải biến thể "(dự kiến hết tháng)".
    await expect(rowThu).not.toContainText("dự kiến");
    await expect(rowChi).not.toContainText("dự kiến");
    if ((await page.getByText("Quỹ tới hôm nay", { exact: true }).count()) === 0) {
      const nhanCuoiKy = page.getByTestId("so-quy-dong-chay-cuoi-ky").locator("xpath=preceding-sibling::p[1]");
      await expect(nhanCuoiKy).toHaveText("Cuối kỳ");
    }

    // ⑧ Khối cảnh báo PARITY với thẻ Quỹ (tab Dòng tiền) — không giả định nội dung cụ thể (DB tích
    // luỹ, cảnh báo có/không tuỳ thời điểm chạy): mỗi câu cảnh báo CÓ trên thẻ thì PHẢI có trên tab Sổ
    // quỹ, và ngược lại. So bằng text toàn trang thay vì `data-testid` vì `so-quy-canh-bao.tsx` không
    // export testid riêng cho khối này.
    await page.goto("/tai-chinh?tab=dong-tien");
    const textTheQuy = await page.locator("body").innerText();
    await page.goto("/tai-chinh?tab=so-quy");
    const textSoQuy = await page.locator("body").innerText();
    const CAU_CANH_BAO = [
      "lệnh TikTok đã trả nhưng thiếu ngày",
      "thiếu tiền rút Shopee trước đó",
      "ví Shopee mới nhập tới",
      "giao dịch Shopee chưa phân loại (toàn bộ)",
      "chi phí định kỳ chỉ được ghi khi tháng đó được mở xem",
      "sàn trừ ví ads TikTok nhiều hơn ads đã ghi Sổ chi phí",
      "khoản vay có kỳ trả nợ chưa ghi",
    ];
    for (const cau of CAU_CANH_BAO) {
      expect(textSoQuy.includes(cau)).toBe(textTheQuy.includes(cau));
    }
  });
});
