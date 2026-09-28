import { expect, test, type Page } from "@playwright/test";
import * as XLSX from "xlsx";

import { testPrisma } from "./ingest-raw";
import { TEST_USER_EMAIL, TEST_USER_PASSWORD } from "./test-constants";

/**
 * E2E "Tiền đã về" ví Shopee (Phase 3). Chạy CẢ luồng qua UI: mở modal → upload
 * file ví (sinh buffer trong test) → preview checksum → import (server action đi
 * qua webServer → test DB) → card "Shopee — net về ví" hiện.
 *
 * Cách ly: dùng ngày trong THÁNG HIỆN TẠI (để lọt view mặc định dong-tien) +
 * upsert idempotent theo khoá tổng hợp → re-run không nhân đôi. Chỉ assert card
 * HIỆN + badge checksum (không assert số tuyệt đối → bền với dữ liệu tích luỹ).
 */

const pad = (n: number) => String(n).padStart(2, "0");

async function login(page: Page): Promise<void> {
  await page.goto("/dang-nhap");
  await page.getByLabel("Email").fill(TEST_USER_EMAIL);
  await page.getByLabel("Mật khẩu", { exact: true }).fill(TEST_USER_PASSWORD);
  await page.getByRole("button", { name: "Đăng nhập" }).click();
  await expect(page).toHaveURL("/");
}

const HEADER = [
  "Ngày", "Loại giao dịch", "Chi tiết", "Mã đơn hàng", "Dòng tiền", "Số tiền", "Trạng thái", "Số dư Ví sau giao dịch",
];

/** Sinh file ví .xlsx (Node buffer) khớp SHAPE Shopee, ngày trong tháng hiện tại. */
function buildWalletBuffer(): Buffer {
  const now = new Date();
  const day = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(Math.min(now.getDate(), 28))} 10:00:00`;
  const rows = [
    [day, "Doanh Thu Đơn Hàng", "Doanh Thu Đơn E2E", "E2ESHOPEEIN01", "Tiền vào", "503310", "Giao dịch thành công", "503310"],
    [day, "Rút Tiền", "Rút Tiền", "-", "Tiền ra", "-200000", "Giao dịch thành công", "303310"],
  ];
  const aoa: (string | number)[][] = [
    ["Báo cáo"],
    ["Tóm tắt", "", "", "", "$", "Đơn vị", "Số giao dịch"],
    ["Tổng tiền vào", "", "", "", 503310, "VND", 1],
    ["Tổng tiền ra", "", "", "", -200000, "VND", 1],
    [],
    ["Chi tiết giao dịch"],
    HEADER,
    ...rows,
  ];
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Transaction Report");
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
}

test.describe("Tiền đã về — ví Shopee", () => {
  // Cùng lý do resetRawPancake: fixture sinh khoá `txnTime|type|orderCode|amount`
  // GIỐNG HỆT trong cùng ngày → Bronze còn raw từ lần chạy trước sẽ dedupe (land 0)
  // → transform không chạy → Silver rỗng → card không hiện dù toast import OK.
  test.beforeAll(async () => {
    const prisma = testPrisma();
    try {
      await prisma.rawShopeeWalletTxn.deleteMany();
    } finally {
      await prisma.$disconnect();
    }
  });

  test.beforeEach(async ({ page }) => {
    await login(page);
  });

  test("tab Dòng tiền có section 'Tiền đã về' + nút import ví Shopee", async ({ page }) => {
    await page.goto("/tai-chinh?tab=dong-tien");
    await expect(page.getByText("Tiền đã về (thật)")).toBeVisible();
    await expect(page.getByRole("button", { name: "Import file ví Shopee" })).toBeVisible();
  });

  test("upload file ví → checksum khớp → import → card Shopee hiện", async ({ page }) => {
    await page.goto("/tai-chinh?tab=dong-tien");
    await page.getByRole("button", { name: "Import file ví Shopee" }).click();

    const dialog = page.getByRole("dialog");
    await expect(dialog.getByText(/Bước 1\/2/)).toBeVisible();

    await dialog.locator('input[type="file"]').setInputFiles({
      name: "my_balance_transaction_report.xlsx",
      mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      buffer: buildWalletBuffer(),
    });

    // Preview bước 2: badge checksum khớp + nút import bật.
    await expect(dialog.getByText(/Checksum khớp/)).toBeVisible();
    const importBtn = dialog.getByRole("button", { name: /Import \d+ dòng/ });
    await expect(importBtn).toBeEnabled();
    await importBtn.click();

    // Toast thành công + card Shopee xuất hiện sau refresh.
    await expect(page.getByText(/Đã import/)).toBeVisible();
    await expect(page.getByText("Shopee — net về ví")).toBeVisible();
  });

  test("nhập LẠI đúng file đã import → toast nói thật 'đã được nhập trước đó', không phải 'Đã import 0 dòng'", async ({
    page,
  }) => {
    // TỰ CHỨA (không dựa thứ tự test): dùng khoá riêng (mã đơn + giờ khác fixture kia), tự import
    // 2 lượt trong cùng test. Lượt 2 land 0 dòng (Bronze dedupe payload y hệt) — trước bản vá
    // tự-chữa, đường này trả "Đã import 0 dòng ví (0 dòng mới)" gây hoang mang; nay modal phải
    // nói đúng sự thật.
    const now = new Date();
    const day = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(Math.min(now.getDate(), 28))} 11:22:33`;
    const aoa: (string | number)[][] = [
      ["Báo cáo"],
      ["Tóm tắt", "", "", "", "$", "Đơn vị", "Số giao dịch"],
      ["Tổng tiền vào", "", "", "", 121000, "VND", 1],
      ["Tổng tiền ra", "", "", "", 0, "VND", 0],
      [],
      ["Chi tiết giao dịch"],
      HEADER,
      [day, "Doanh Thu Đơn Hàng", "Doanh Thu Đơn E2E nhập lại", "E2ESHOPEEIN02", "Tiền vào", "121000", "Giao dịch thành công", "121000"],
    ];
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Transaction Report");
    const buffer = XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
    const file = {
      name: "my_balance_transaction_report.xlsx",
      mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      buffer,
    };

    async function importFile(): Promise<void> {
      await page.getByRole("button", { name: "Import file ví Shopee" }).click();
      const dialog = page.getByRole("dialog");
      await dialog.locator('input[type="file"]').setInputFiles(file);
      await expect(dialog.getByText(/Checksum khớp/)).toBeVisible();
      const importBtn = dialog.getByRole("button", { name: /Import \d+ dòng/ });
      await expect(importBtn).toBeEnabled();
      await importBtn.click();
    }

    await page.goto("/tai-chinh?tab=dong-tien");
    await importFile();
    await expect(page.getByText(/Đã import 1 dòng ví/)).toBeVisible();

    await importFile();
    await expect(page.getByText(/đã được nhập trước đó — không có dòng mới/)).toBeVisible();
  });
});
