import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { landRaw } from "@/lib/bronze/land-raw";
import { rebuildFromRaw } from "@/lib/bronze/rebuild";
import { prisma } from "@/lib/prisma";
import { calcPnl } from "@/lib/reports/pnl";

import { seedReference, truncateBusinessTables } from "../helpers/test-db";

/**
 * TEST HỒI QUY TIỀN — Bronze thay hẳn đường ingest (n8n → land raw → transform → Silver).
 * Nếu công thức lệch DÙ 1 ĐỒNG thì P&L sai và chủ shop ra quyết định sai. Suite này chốt:
 * land raw → rebuild → `calcPnl()` khớp số TÍNH TAY.
 *
 * MỌI con số kỳ vọng ở đây là LITERAL tính tay từ payload (xem chú thích từng case) — TUYỆT ĐỐI
 * không tính lại bằng chính công thức của app (tautology thì test vô dụng).
 *
 * Công thức (bất biến — `src/lib/reports/pnl.ts`, KHÔNG sửa):
 *   revenue     = Σ itemsTotal đơn hợp lệ (status ∉ {RETURNED, CANCELLED})
 *                 ; itemsTotal = total_price − (Σ quantity×discount_each_product − marketplace_voucher áp dụng)
 *   platformFee = Σ platformFeeEst đơn hợp lệ = fee_marketplace THẬT (shopee/tiktok)
 *   voucher     = Σ discount (order.total_discount)
 *   netRevenue  = revenue − platformFee − voucher
 *   cogs        = Σ quantity × Variant.costPrice HIỆN HÀNH
 *   grossProfit = netRevenue − cogs
 *   netProfit   = grossProfit − chi phí sổ theo danh mục ("purchase" KHÔNG BAO GIỜ vào P&L)
 */

const body = (items: string) => `{"success":true,"data":[${items}]}`;

/** Product shop KHO (714995134) — nguồn giá vốn: average_imported_price = 40.000. */
const PRODUCT = `{"id":"P-1","name":"Váy hè","variations":[
  {"id":"V-KHO-1","display_id":"SKU-1","retail_price":100000,
   "remain_quantity":10,"average_imported_price":40000}]}`;

/**
 * Đơn Shopee HỢP LỆ (status 3 = delivered): total_price 200.000, không voucher,
 * phí sàn thật 15.000, 1 item × qty 2 khớp SKU-1.
 */
const ORDER = `{
  "id":"ORD-1","status":3,"inserted_at":"2026-07-01T10:00:00.000000",
  "order_sources_name":"Shopee","marketplace_id":"-3",
  "total_price":200000,"total_discount":0,"fee_marketplace":15000,
  "items":[{"quantity":2,"discount_each_product":0,"variation_id":"V-SHOPEE-KHAC",
    "variation_info":{"display_id":"SKU-1","name":"Váy hè","retail_price":100000}}]}`;

/**
 * Đơn Shopee HOÀN (status 4 = returning → RETURNED). Tiền khác 0 để nếu lọt vào P&L là thấy ngay:
 * revenue +500.000, platformFee +40.000, cogs +120.000 (3 × 40.000).
 */
const RETURNED_ORDER = `{
  "id":"ORD-HOAN","status":4,"inserted_at":"2026-07-02T10:00:00.000000",
  "order_sources_name":"Shopee","marketplace_id":"-3",
  "total_price":500000,"total_discount":0,"fee_marketplace":40000,
  "items":[{"quantity":3,"discount_each_product":0,"variation_id":"V-SHOPEE-KHAC",
    "variation_info":{"display_id":"SKU-1","name":"Váy hè","retail_price":100000}}]}`;

/**
 * Đơn MIRROR shop KHO — bản sao "Affiliate" của đơn Shopee (id `AF<shopId>O…`, invariant #2).
 * Cùng giao dịch, khác id ⇒ nếu tính doanh thu thì đếm 2 lần dạng ẩn.
 */
const MIRROR_ORDER = `{
  "id":"AF1942992175O9","status":3,"inserted_at":"2026-07-01T10:00:00.000000",
  "order_sources_name":"Affiliate","marketplace_id":"-3",
  "total_price":999000,"total_discount":0,"fee_marketplace":0,"items":[]}`;

/** Kỳ báo cáo bao trọn tháng 7/2026 (neo giờ VN) — chứa `inserted_at` của mọi đơn trên. */
const RANGE = {
  from: new Date("2026-07-01T00:00:00+07:00"),
  to: new Date("2026-07-31T00:00:00+07:00"),
};

/** Nền chung: 1 product kho + 1 đơn Shopee hợp lệ → Silver. */
async function landBase(): Promise<void> {
  await landRaw("products", "714995134", body(PRODUCT));
  await landRaw("orders", "1942992175", body(ORDER));
}

beforeAll(async () => {
  await seedReference();
}, 60_000);

beforeEach(async () => {
  await truncateBusinessTables();
  // Bảng Bronze KHÔNG nằm trong truncateBusinessTables (raw là append-only, không phải nghiệp vụ).
  await prisma.rawPancakeOrder.deleteMany();
  await prisma.rawPancakeProduct.deleteMany();
});

describe("Bronze KHÔNG làm đổi số P&L", () => {
  it("P&L dựng từ Bronze khớp số tính TAY", async () => {
    await landBase();
    await rebuildFromRaw();

    const p = await calcPnl(RANGE);

    // itemsTotal = total_price 200.000 − Σ quantity×discount_each_product 0 = 200.000
    expect(p.revenue).toBe(200_000);
    expect(p.platformFee).toBe(15_000); // fee_marketplace THẬT, KHÔNG ước tính 12,5% (= 25.000)
    expect(p.voucher).toBe(0);
    expect(p.netRevenue).toBe(185_000); // 200.000 − 15.000 − 0
    expect(p.cogs).toBe(80_000); // 2 × 40.000 (giá vốn prefill từ kho)
    expect(p.grossProfit).toBe(105_000); // 185.000 − 80.000
    expect(p.netProfit).toBe(105_000); // chưa có chi phí sổ
    expect(p.orderCount).toBe(1);
    expect(p.skuMissingCount).toBe(0); // item tra được Variant → COGS không âm thầm về 0
  });

  it("rebuild 2 lần → P&L Y HỆT (idempotent)", async () => {
    await landBase();

    await rebuildFromRaw();
    const a = await calcPnl(RANGE);
    await rebuildFromRaw();
    const b = await calcPnl(RANGE);

    expect(b).toEqual(a);
    expect(b.revenue).toBe(200_000); // không nhân đôi thành 400.000
    expect(b.cogs).toBe(80_000);
  });

  it("đơn RETURNED bị loại khỏi CẢ doanh thu LẪN phí sàn", async () => {
    await landBase();
    await landRaw("orders", "1942992175", body(RETURNED_ORDER));

    const stats = await rebuildFromRaw();
    expect(stats.ordersUpserted).toBe(2); // đơn hoàn VẪN vào Silver (để xem ở /don-hang)…

    const p = await calcPnl(RANGE);
    // …nhưng KHÔNG vào P&L: mọi số y hệt case 1.
    expect(p.revenue).toBe(200_000); // không phải 700.000
    expect(p.platformFee).toBe(15_000); // không phải 55.000
    expect(p.cogs).toBe(80_000); // không phải 200.000
    expect(p.netProfit).toBe(105_000);
    expect(p.orderCount).toBe(1);
    expect(p.returnBomOrderCount).toBe(1);
  });

  it("đơn MIRROR shop kho KHÔNG vào doanh thu (chống đếm 2 lần)", async () => {
    await landBase();
    await landRaw("orders", "714995134", body(MIRROR_ORDER));

    const stats = await rebuildFromRaw();
    expect(stats.ordersSkippedMirror).toBe(1);
    expect(await prisma.rawPancakeOrder.count()).toBe(2); // raw GIỮ cả mirror
    expect(await prisma.order.count()).toBe(1); // Silver chỉ có đơn gốc

    const p = await calcPnl(RANGE);
    expect(p.revenue).toBe(200_000); // đếm 2 lần thì đã vọt lên 1.199.000
    expect(p.netProfit).toBe(105_000);
    expect(p.orderCount).toBe(1);
  });

  it("chi phí danh mục 'purchase' (Nhập hàng) KHÔNG vào P&L — là dòng tiền", async () => {
    await landBase();
    await rebuildFromRaw();

    await prisma.expense.create({
      data: {
        date: new Date("2026-07-05T00:00:00+07:00"), // trong kỳ
        categoryId: "purchase",
        description: "Nhập lô hè",
        amount: 50_000_000,
        source: "MANUAL",
      },
    });

    const p = await calcPnl(RANGE);
    expect(p.netProfit).toBe(105_000); // KHÔNG thành −49.895.000
    expect(p.grossProfit).toBe(105_000);
    expect(p.other).toBe(0); // "purchase" cũng không lọt vào nhóm "khác"
  });

  it("COGS dùng giá vốn SỬA TAY hiện hành, rebuild không đè lại giá Pancake", async () => {
    await landBase();
    await rebuildFromRaw();

    // Chủ shop sửa giá vốn 40.000 → 55.000 (Pancake không biết con số này).
    await prisma.variant.updateMany({ where: { sku: "SKU-1" }, data: { costPrice: 55_000 } });
    await rebuildFromRaw(); // dựng lại từ raw: KHÔNG được kéo costPrice về 40.000

    const p = await calcPnl(RANGE);
    expect(p.cogs).toBe(110_000); // 2 × 55.000 — không phải 80.000
    expect(p.revenue).toBe(200_000); // doanh thu/phí sàn không đổi
    expect(p.platformFee).toBe(15_000);
    expect(p.netRevenue).toBe(185_000);
    expect(p.grossProfit).toBe(75_000); // 185.000 − 110.000
    expect(p.netProfit).toBe(75_000); // giảm ĐÚNG 30.000 so với 105.000 (= 2 × 15.000)
  });
});
