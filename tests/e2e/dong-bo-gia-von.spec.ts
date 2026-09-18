import { readFileSync } from "node:fs";
import path from "node:path";

import { expect, test, type Page } from "@playwright/test";

import { ingestPancake, resetRawPancake, testPrisma } from "./ingest-raw";
import { TEST_USER_EMAIL, TEST_USER_PASSWORD } from "./test-constants";

/**
 * Màn "Đồng bộ giá vốn từ Pancake" — đường thay cho việc chủ shop phải NHỚ mà báo rồi có người chạy
 * lệnh trên máy dev.
 *
 * Kiểm đúng thứ dễ vỡ mà unit test không thấy: đường vào có thật (màn không bị cô lập), bảng ảnh
 * hưởng theo tháng có hiện, và bấm duyệt thì giá vốn ĐỔI THẬT trong DB.
 *
 * KHÔNG dùng `getByText` chuỗi ngắn + `.first()` — bài học 22/08: card biến mất mà phép kiểm vẫn xanh.
 */

const fixture = (name: string) =>
  JSON.parse(readFileSync(path.resolve(process.cwd(), "tests/fixtures/pancake", name), "utf8")) as unknown[];

/** Biến thể dùng cho cả file — chọn ở `beforeAll`, phải CÓ trong Bronze mới sinh được dòng lệch. */
let variantId = "";
let giaPancake = 0;

test.beforeAll(async () => {
  await resetRawPancake();
  await ingestPancake({ products: fixture("products-sample.json") });

  const db = testPrisma();
  // Lấy biến thể do CHÍNH lượt ingest sinh ra (⇒ chắc chắn có trong Bronze) và có giá vốn > 0.
  const bt = await db.variant.findFirstOrThrow({
    where: { costPrice: { gt: 0 } },
    orderBy: { pancakeId: "asc" },
  });
  variantId = bt.id;

  // Giá kỳ vọng phải lấy từ BRONZE, KHÔNG lấy giá app đang giữ: lượt chạy trước có thể để lại giá
  // rác, khi đó "đặt rồi so lại chính nó" thành phép kiểm XANH GIẢ — không ghi gì vẫn qua.
  giaPancake = await giaVonPancakeCuaBienThe(bt.pancakeId);
  expect(giaPancake).toBeGreaterThan(0);

  // Fixture đơn hàng KHÔNG dùng chung biến thể với fixture sản phẩm, nên phải tự dựng một dòng bán:
  // bảng "lãi từng tháng" chỉ hiện khi mã đó ĐÃ BÁN (mã chưa bán thì áp giá không đụng kỳ nào).
  const kenh = await db.channel.findFirstOrThrow();
  // Xoá đơn của lượt chạy trước: `pancakeId` là unique nên `create` lần hai sẽ ném, và lỗi đó
  // hiện ra ở tận phép kiểm cuối chứ không phải ở đây — rất khó truy.
  await db.order.deleteMany({ where: { pancakeId: "E2E-GIAVON-ORDER-1" } });
  const don = await db.order.create({
    data: {
      pancakeId: "E2E-GIAVON-ORDER-1",
      code: "E2E-GIAVON-1",
      channelId: kenh.id,
      status: "COMPLETED",
      orderedAt: new Date("2026-08-15T03:00:00.000Z"),
      itemsTotal: 300_000,
      syncedAt: new Date(),
    },
  });
  await db.orderItem.create({
    data: {
      orderId: don.id,
      variantId,
      sku: bt.sku,
      productName: "Hàng test đồng bộ giá vốn",
      quantity: 2,
      unitPrice: 150_000,
    },
  });
});

/** Đọc giá vốn Pancake của một biến thể từ ảnh Bronze mới nhất — nguồn sự thật cho phép kiểm. */
async function giaVonPancakeCuaBienThe(pancakeId: string): Promise<number> {
  const [row] = await testPrisma().$queryRawUnsafe<{ gia: number | null }[]>(
    `SELECT COALESCE(NULLIF((x->>'average_imported_price')::numeric, 0),
                     (x->>'last_imported_price')::numeric)::int AS gia
       FROM (SELECT DISTINCT ON ("externalId") payload FROM "RawPancakeProduct"
              ORDER BY "externalId", "fetchedAt" DESC) p,
            jsonb_array_elements(p.payload->'variations') x
      WHERE x->>'id' = $1 LIMIT 1`,
    pancakeId,
  );
  return row?.gia ?? 0;
}

async function login(page: Page): Promise<void> {
  await page.goto("/dang-nhap");
  await page.getByLabel("Email").fill(TEST_USER_EMAIL);
  await page.getByLabel("Mật khẩu", { exact: true }).fill(TEST_USER_PASSWORD);
  await page.getByRole("button", { name: "Đăng nhập" }).click();
  await expect(page).toHaveURL("/");
}

test.describe("Đồng bộ giá vốn từ Pancake", () => {
  test("vào được từ trang Sản phẩm — màn KHÔNG phụ thuộc dải cảnh báo", async ({ page }) => {
    // Đường vào cố định là chốt chặn cho ca "dải im vì chưa đối chiếu lần nào": nếu link duy nhất
    // là chính dải đó thì màn duyệt chỉ vào được bằng gõ tay URL.
    await login(page);
    await page.goto("/san-pham");

    await page.getByRole("link", { name: "Đồng bộ giá vốn từ Pancake" }).click();

    await expect(page).toHaveURL("/san-pham/dong-bo-gia-von");
    await expect(page.getByRole("heading", { name: "Đồng bộ giá vốn từ Pancake" })).toBeVisible();
  });

  test("có mã lệch → bảng theo tháng + duyệt → giá vốn đổi THẬT → màn báo đã khớp", async ({ page }) => {
    // Hạ giá vốn xuống dưới giá Pancake ⇒ sinh đúng dòng lệch, và mã này đã có 1 đơn COMPLETED
    // (dựng ở beforeAll) nên bảng theo tháng có dữ liệu để hiện.
    await testPrisma().variant.update({ where: { id: variantId }, data: { costPrice: 1_000 } });

    await login(page);
    await page.goto("/san-pham/dong-bo-gia-von");

    // Bảng theo tháng là ĐIỀU KIỆN chủ shop đặt ra khi chốt phương án — phải có mặt.
    await expect(page.getByRole("heading", { name: "Lãi từng tháng sẽ đổi thế nào" })).toBeVisible();
    const nut = page.getByRole("button", { name: /Áp giá vốn Pancake cho \d+ mã/ });
    await expect(nut).toBeVisible();

    await nut.click();
    await page.getByRole("button", { name: "Áp giá vốn", exact: true }).click();

    // Chốt bằng DB, không chốt bằng chữ trên màn: toast xanh mà số không đổi là ca đã gặp (12/08).
    await expect
      .poll(async () => (await testPrisma().variant.findUniqueOrThrow({ where: { id: variantId } })).costPrice, {
        timeout: 20_000,
      })
      .toBe(giaPancake);

    // Áp xong thì màn phải tự nói "đang khớp" và KHÔNG còn nút — gộp vào đây để khỏi phụ thuộc
    // thứ tự chạy giữa các test.
    await page.goto("/san-pham/dong-bo-gia-von");
    await expect(page.getByText("Không có mã nào lệch")).toBeVisible();
    await expect(page.getByRole("button", { name: /Áp giá vốn Pancake/ })).toHaveCount(0);
  });
});
