import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { landRaw } from "@/lib/bronze/land-raw";
import { rebuildFromRaw } from "@/lib/bronze/rebuild";
import { prisma } from "@/lib/prisma";
import { calcPnl } from "@/lib/reports/pnl";
import { computeProductReport } from "@/lib/reports/product-report";

import { seedReference, truncateBusinessTables } from "./helpers/test-db";

/**
 * ĐỐI CHIẾU doanh thu tab SẢN PHẨM vs P&L (`hogikids_test`) — hai đường tính KHÁC nhau:
 *   - P&L (pnl.ts, nguồn chuẩn duy nhất): revenue = Σ itemsTotal = total_price − (Σ quantity×discount_each_product − voucher SÀN tài trợ)
 *   - Tab Sản phẩm (product-report.ts):   revenue = Σ (unitPrice × quantity − lineDiscount) từng dòng
 * Chúng chỉ bằng nhau khi total_price == Σ retail_price × qty (convention Pancake, verify 60/60 đơn).
 * Không có guard nào khoá điều này ⇒ suite này là LƯỚI: ai đổi 1 trong 2 công thức mà làm 2 tab lệch
 * số doanh thu là đỏ ngay. CHỈ THÊM test — không đổi lõi, không thêm aggregate thứ 2 (bất biến #1).
 *
 * Số kỳ vọng là LITERAL tính tay từ payload (không tính lại bằng công thức app — tránh tautology).
 */

const body = (items: string) => `{"success":true,"data":[${items}]}`;

/** Product shop KHO — 2 biến thể: SKU-1 (retail 100.000, vốn 40.000), SKU-2 (retail 60.000, vốn 25.000). */
const PRODUCT = `{"id":"P-PAR","name":"Set bé gái","variations":[
  {"id":"V-PAR-1","display_id":"SKU-1","retail_price":100000,"remain_quantity":10,"average_imported_price":40000},
  {"id":"V-PAR-2","display_id":"SKU-2","retail_price":60000,"remain_quantity":5,"average_imported_price":25000}]}`;

/**
 * Đơn Shopee HỢP LỆ có giảm giá dòng + voucher mức đơn:
 *   total_price = Σ retail × qty = 2×100.000 + 1×60.000 = 260.000 (GỘP, convention Pancake)
 *   `discount_each_product` là giảm giá MỖI ĐƠN VỊ ⇒ Σ = 2×20.000 + 1×5.000 = 45.000 → itemsTotal = 215.000
 *   total_discount (voucher) = 10.000 — trừ ở netRevenue, KHÔNG đụng revenue (cả 2 tab đều không trừ).
 */
const ORDER_A = `{
  "id":"ORD-PAR-1","status":3,"inserted_at":"2026-07-05T10:00:00.000000",
  "order_sources_name":"Shopee","marketplace_id":"-3",
  "total_price":260000,"total_discount":10000,"fee_marketplace":12000,
  "items":[
    {"quantity":2,"discount_each_product":20000,"variation_id":"V-X1",
     "variation_info":{"display_id":"SKU-1","name":"Set bé gái","retail_price":100000}},
    {"quantity":1,"discount_each_product":5000,"variation_id":"V-X2",
     "variation_info":{"display_id":"SKU-2","name":"Set bé gái","retail_price":60000}}]}`;

/**
 * Đơn có item SKU KHÔNG KHỚP variant nào (variantId null → nhóm "SKU không khớp" ở tab Sản phẩm):
 *   total_price = 3 × 50.000 = 150.000, không giảm giá → itemsTotal = 150.000.
 * Nhóm không khớp PHẢI được cộng vào Σ tab Sản phẩm — thiếu nó là parity vỡ.
 */
const ORDER_B = `{
  "id":"ORD-PAR-2","status":3,"inserted_at":"2026-07-06T10:00:00.000000",
  "order_sources_name":"Shopee","marketplace_id":"-3",
  "total_price":150000,"total_discount":0,"fee_marketplace":0,
  "items":[{"quantity":3,"discount_each_product":0,"variation_id":"V-LA",
    "variation_info":{"display_id":"SKU-LA","name":"Áo lạ ngoài catalog","retail_price":50000}}]}`;

/**
 * Đơn TikTok có VOUCHER SÀN TÀI TRỢ trên dòng qty>1 — ca mà voucher phải được phân bổ về dòng, nếu
 * không thì `Order.itemsTotal` và Σ doanh thu dòng lệch nhau (chính là bất biến lưới này canh):
 *   total_price = 2 × 100.000 = 200.000
 *   Σ giảm giá dòng = 2 × 30.000 = 60.000; sàn tài trợ 25.000 → shop chịu 35.000 → itemsTotal = 165.000
 */
const ORDER_C = `{
  "id":"ORD-PAR-3","status":3,"inserted_at":"2026-07-08T10:00:00.000000",
  "order_sources_name":"Tiktok","marketplace_id":"-9",
  "total_price":200000,"total_discount":0,"fee_marketplace":0,
  "advanced_platform_fee":{"marketplace_voucher":25000},
  "items":[{"quantity":2,"discount_each_product":30000,"variation_id":"V-X1",
    "variation_info":{"display_id":"SKU-1","name":"Set bé gái","retail_price":100000}}]}`;

/** Đơn HOÀN (status 4 → RETURNED) tiền khác 0 — cả 2 tab đều phải loại. */
const ORDER_RETURNED = `{
  "id":"ORD-PAR-HOAN","status":4,"inserted_at":"2026-07-07T10:00:00.000000",
  "order_sources_name":"Shopee","marketplace_id":"-3",
  "total_price":500000,"total_discount":0,"fee_marketplace":40000,
  "items":[{"quantity":5,"discount_each_product":0,"variation_id":"V-X1",
    "variation_info":{"display_id":"SKU-1","name":"Set bé gái","retail_price":100000}}]}`;

/** Kỳ báo cáo bao trọn tháng 7/2026 (neo giờ VN). */
const RANGE = {
  from: new Date("2026-07-01T00:00:00+07:00"),
  to: new Date("2026-07-31T00:00:00+07:00"),
};

beforeAll(async () => {
  await seedReference();
}, 60_000);

beforeEach(async () => {
  await truncateBusinessTables();
  // Bảng Bronze không nằm trong truncateBusinessTables (raw là append-only, không phải nghiệp vụ).
  await prisma.rawPancakeOrder.deleteMany();
  await prisma.rawPancakeProduct.deleteMany();
});

describe("Doanh thu tab Sản phẩm khớp P&L", () => {
  it("Σ revenue computeProductReport === calcPnl().revenue (kể cả giảm giá dòng + SKU không khớp + đơn hoàn)", async () => {
    await landRaw("products", "714995134", body(PRODUCT));
    await landRaw("orders", "1942992175", body(`${ORDER_A},${ORDER_B},${ORDER_C},${ORDER_RETURNED}`));
    await rebuildFromRaw();

    const pnl = await calcPnl(RANGE);
    const productRows = await computeProductReport(RANGE);
    const productRevenue = productRows.reduce((s, r) => s + r.revenue, 0);

    // Tính tay: ORDER_A 215.000 + ORDER_B 150.000 + ORDER_C 165.000 = 530.000 (đơn hoàn bị loại).
    expect(pnl.revenue).toBe(530_000);
    expect(productRevenue).toBe(530_000);
    expect(productRevenue).toBe(pnl.revenue);

    // Nhóm "SKU không khớp" thật sự có mặt và mang đúng doanh thu dòng (3 × 50.000).
    const unmatched = productRows.find((r) => r.productId === "sku-khong-khop");
    expect(unmatched?.revenue).toBe(150_000);
  });

  it("kỳ không có đơn → cả 2 phía cùng bằng 0 (parity giữ ở biên rỗng)", async () => {
    const pnl = await calcPnl(RANGE);
    const productRows = await computeProductReport(RANGE);
    expect(pnl.revenue).toBe(0);
    expect(productRows.reduce((s, r) => s + r.revenue, 0)).toBe(0);
  });
});
