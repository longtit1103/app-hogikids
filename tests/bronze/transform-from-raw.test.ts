import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { landRaw } from "@/lib/bronze/land-raw";
import { transformFromRaw } from "@/lib/bronze/transform-from-raw";
import { prisma } from "@/lib/prisma";

import { SHOP_KHO } from "../helpers/shop-ids-fixture";
import { seedReference, truncateBusinessTables } from "../helpers/test-db";

/**
 * Transform ĐỌC TỪ BẢNG RAW (Bronze) ra Silver — không đọc HTTP body.
 * Luật giữ nguyên phase 2: phí sàn = fee_marketplace THẬT; đơn mirror bị loại khỏi Silver
 * (raw vẫn giữ); record hỏng shape → skip + warning, không giết batch.
 */

const body = (items: string) => `{"success":true,"data":[${items}]}`;

/** Đơn Shopee tối thiểu (khớp pancakeOrderSchema). */
const ORDER = (id: string) => `{
  "id":"${id}","status":3,"inserted_at":"2026-07-01T10:00:00.000000",
  "order_sources_name":"Shopee","marketplace_id":"-3",
  "total_price":200000,"total_discount":0,"fee_marketplace":15000,
  "items":[{"quantity":2,"discount_each_product":0,
    "variation_info":{"display_id":"SKU-T1","name":"SP","retail_price":100000}}]}`;

/** Đơn MIRROR shop kho: nguồn Affiliate + marketplace → phải bị loại khỏi Silver. */
const MIRROR = `{
  "id":"AF1942992175O-9","status":3,"inserted_at":"2026-07-01T10:00:00.000000",
  "order_sources_name":"Affiliate","marketplace_id":"-3",
  "total_price":999000,"total_discount":0,"fee_marketplace":0,"items":[]}`;

/**
 * Mirror shop kho NHƯNG nguồn ghi "Shopee" (luật `isAffiliateMirror` không bắt được).
 * Lọt vào Silver = đơn gốc Shopee bị đếm doanh thu 2 lần → luật id `AF<shop>O` phải chặn.
 */
const MIRROR_ID_ONLY = `{
  "id":"AF1942992175O9","status":3,"inserted_at":"2026-07-01T10:00:00.000000",
  "order_sources_name":"Shopee","marketplace_id":"-3",
  "total_price":999000,"total_discount":0,"fee_marketplace":50000,"items":[]}`;

const PRODUCT = (id: string, sku: string, cost: number) => `{
  "id":"${id}","name":"Váy hè","variations":[
    {"id":"V-${id}","display_id":"${sku}","retail_price":100000,
     "remain_quantity":10,"average_imported_price":${cost}}]}`;

beforeAll(async () => {
  await seedReference();
}, 60_000);

beforeEach(async () => {
  await truncateBusinessTables();
  await prisma.rawPancakeOrder.deleteMany();
  await prisma.rawPancakeProduct.deleteMany();
});

describe("transformFromRaw", () => {
  it("đọc TỪ BẢNG RAW ra Silver (không đọc HTTP body)", async () => {
    await landRaw("orders", "1942992175", body(ORDER("ORD-1")));

    const stats = await transformFromRaw("orders", []);

    expect(stats.ordersUpserted).toBe(1);
    const o = await prisma.order.findUnique({ where: { pancakeId: "ORD-1" } });
    expect(o?.itemsTotal).toBe(200_000);
    expect(o?.platformFeeEst).toBe(15_000); // phí THẬT fee_marketplace
  });

  it("đơn mirror CÓ trong raw nhưng KHÔNG vào Silver", async () => {
    await landRaw("orders", "714995134", body(MIRROR));

    const stats = await transformFromRaw("orders", []);

    expect(stats.ordersSkippedMirror).toBe(1);
    expect(stats.ordersUpserted).toBe(0);
    expect(await prisma.rawPancakeOrder.count()).toBe(1); // raw VẪN giữ
    expect(await prisma.order.count()).toBe(0); // Silver KHÔNG có
  });

  it("đơn kho id AF<shop>O nhưng nguồn 'Shopee' → VẪN loại khỏi Silver + cảnh báo luật bất đồng", async () => {
    await landRaw("orders", "714995134", body(MIRROR_ID_ONLY));
    const warnings: string[] = [];

    const stats = await transformFromRaw("orders", warnings);

    expect(stats.ordersSkippedMirror).toBe(1);
    expect(stats.ordersUpserted).toBe(0);
    expect(await prisma.order.count()).toBe(0); // KHÔNG đếm doanh thu 2 lần (invariant #2)
    expect(warnings.some((w) => w.includes("bất đồng"))).toBe(true);
  });

  it("đơn shop BÁN có id kiểu AF… CŨNG bị loại (luật id áp MỌI shop — chốt 2026-08-21)", async () => {
    // Trước 2026-08-21 luật id chỉ áp shop kho — tức cổng an toàn tiền phụ thuộc so ĐÚNG một id
    // cấu hình; bản clone điền nhầm id kho là mirror lọt Silver ÂM THẦM (red-team). Mã `AF...O`
    // là dấu mirror của Pancake bất kể đơn nằm shop nào; đơn gốc Shopee/TikTok mang mã sàn,
    // không bao giờ có tiền tố này.
    await landRaw("orders", "1942992175", body(ORDER("AF1942992175O7")));
    const warnings: string[] = [];

    const stats = await transformFromRaw("orders", warnings);

    expect(stats.ordersUpserted).toBe(0);
    expect(stats.ordersSkippedMirror).toBe(1);
    expect(await prisma.order.count()).toBe(0);
    // Nguồn "Shopee" (không phải Affiliate) nhưng id khớp AF ⇒ 2 luật bất đồng — phải kêu.
    expect(warnings.some((w) => w.includes("bất đồng"))).toBe(true);
  });

  it("id kho cấu hình SAI vẫn KHÔNG cho mirror lọt Silver (cổng không phụ thuộc cấu hình)", async () => {
    // Kịch bản red-team: `pancakeShopIdKho` trỏ một id KHÁC id thật của dòng Bronze (bản clone
    // điền nhầm). Luật id `AF...O` phải vẫn chặn — nếu cổng chỉ chạy khi shopId == id kho cấu
    // hình thì đúng ca này doanh thu đếm 2 lần mà không ai hay.
    const { xoaCacheCauHinhShop } = await import("@/lib/ket-noi/cau-hinh-shop");
    await prisma.setting.update({ where: { key: "pancakeShopIdKho" }, data: { value: "999999999" } });
    xoaCacheCauHinhShop();
    try {
      // Đơn mirror mang id `AF<id kho SAI>O`, nguồn ghi "Shopee" (luật nguồn không bắt được),
      // land trên shop bán — chỉ còn luật id đứng giữa nó và Silver.
      await landRaw("orders", "1942992175", body(MIRROR_ID_ONLY.replace("AF1942992175O9", "AF999999999O9")));

      const stats = await transformFromRaw("orders", []);

      expect(stats.ordersSkippedMirror).toBe(1);
      expect(stats.ordersUpserted).toBe(0);
      expect(await prisma.order.count()).toBe(0);
    } finally {
      await prisma.setting.update({ where: { key: "pancakeShopIdKho" }, data: { value: SHOP_KHO } });
      xoaCacheCauHinhShop();
    }
  });

  it("externalIds giới hạn transform vào ĐÚNG trang vừa land (không quét cả bảng)", async () => {
    await landRaw("orders", "1942992175", body(ORDER("ORD-CU"))); // trang trước
    const r = await landRaw("orders", "1942992175", body(ORDER("ORD-MOI"))); // trang này

    const stats = await transformFromRaw("orders", [], { externalIds: r.landedIds });

    expect(stats.ordersUpserted).toBe(1); // chỉ ORD-MOI
    expect(await prisma.order.findUnique({ where: { pancakeId: "ORD-MOI" } })).not.toBeNull();
    expect(await prisma.order.findUnique({ where: { pancakeId: "ORD-CU" } })).toBeNull();
  });

  it("externalIds RỖNG (land trùng, không có gì mới) → transform 0 dòng", async () => {
    await landRaw("orders", "1942992175", body(ORDER("ORD-1")));

    const stats = await transformFromRaw("orders", [], { externalIds: [] });

    expect(stats.ordersUpserted).toBe(0); // KHÔNG rơi về quét cả bảng
    expect(await prisma.order.count()).toBe(0);
  });

  it("chỉ lấy BẢN MỚI NHẤT mỗi externalId", async () => {
    await landRaw("orders", "1942992175", body(ORDER("ORD-1"))); // status 3
    await landRaw("orders", "1942992175", body(ORDER("ORD-1").replace('"status":3', '"status":4')));

    await transformFromRaw("orders", []);

    const o = await prisma.order.findUnique({ where: { pancakeId: "ORD-1" } });
    expect(o?.status).toBe("RETURNED"); // 4 = returning → bản mới nhất thắng
  });

  it("record hỏng shape → skip + warning, KHÔNG giết batch", async () => {
    await landRaw("orders", "1942992175", body(`{"id":"BAD","status":"xxx"},${ORDER("ORD-2")}`));
    const warnings: string[] = [];

    const stats = await transformFromRaw("orders", warnings);

    expect(stats.skipped).toBe(1);
    expect(stats.ordersUpserted).toBe(1);
    expect(warnings.length).toBeGreaterThan(0);
  });

  it("products CHỈ transform từ shop KHO (nguồn giá vốn) — shop bán chỉ land", async () => {
    await landRaw("products", "714995134", body(PRODUCT("P-KHO", "SKU-T1", 40000)));
    await landRaw("products", "1942992175", body(PRODUCT("P-SHOPEE", "SKU-T1", 0)));

    const stats = await transformFromRaw("products", []);

    expect(stats.productsUpserted).toBe(1);
    expect(await prisma.rawPancakeProduct.count()).toBe(2); // raw giữ cả 2 shop
    expect(await prisma.product.findUnique({ where: { pancakeId: "P-SHOPEE" } })).toBeNull();
    const v = await prisma.variant.findFirst({ where: { sku: "SKU-T1" } });
    expect(v?.costPrice).toBe(40_000); // giá vốn kho, KHÔNG bị variant shop bán (=0) chen vào
  });
});
