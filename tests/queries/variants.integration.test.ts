import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  countMissingCostVariants,
  getVariantListPage,
  getVariantsForExport,
} from "@/lib/queries/variants";
import { prisma } from "@/lib/prisma";

/**
 * Integration test queries variant (raw SQL ngưỡng 2 cột + KPI) trên DB test `hogikids_test`.
 * Dữ liệu: V1 tồn thấp (default 5), V2 thiếu giá vốn, V3 hết hàng (ngưỡng riêng 10).
 */

let productId: string;

beforeAll(async () => {
  await prisma.setting.upsert({
    where: { key: "defaultLowStockThreshold" },
    create: { key: "defaultLowStockThreshold", value: "5" },
    update: { value: "5" },
  });
  await prisma.orderItem.deleteMany();
  await prisma.order.deleteMany();
  await prisma.variant.deleteMany();
  await prisma.product.deleteMany();

  const product = await prisma.product.create({
    data: { pancakeId: "Q-P1", name: "SP Query Test", imageUrl: null, syncedAt: new Date() },
  });
  productId = product.id;
  const now = new Date();
  await prisma.variant.createMany({
    data: [
      { pancakeId: "Q-V1", productId, sku: "Q-A", label: "A", sellPrice: 200000, stock: 3, costPrice: 100000, lowStockThreshold: null, syncedAt: now },
      { pancakeId: "Q-V2", productId, sku: "Q-B", label: "B", sellPrice: 90000, stock: 50, costPrice: 0, lowStockThreshold: null, syncedAt: now },
      { pancakeId: "Q-V3", productId, sku: "Q-C", label: "C", sellPrice: 150000, stock: 0, costPrice: 50000, lowStockThreshold: 10, syncedAt: now },
    ],
  });

  // Q-B (biến thể duy nhất thiếu giá vốn) CHỈ xuất hiện trong một đơn HOÀN — dựng cảnh cho bộ lọc
  // hành-động-được: "đã bán" phải hiểu theo đơn HỢP LỆ, không phải mọi dòng OrderItem từng tồn tại.
  const qb = await prisma.variant.findUniqueOrThrow({ where: { pancakeId: "Q-V2" }, select: { id: true } });
  const donHoan = await prisma.order.create({
    data: {
      pancakeId: "Q-ORD-RET", code: "Q-RET", channelId: "shopee", status: "RETURNED",
      orderedAt: now, itemsTotal: 90000, syncedAt: now,
    },
  });
  await prisma.orderItem.create({
    data: { orderId: donHoan.id, variantId: qb.id, sku: "Q-B", productName: "Q San pham", quantity: 1, unitPrice: 90000 },
  });
}, 60_000);

afterAll(async () => {
  // DỌN đơn đã seed: DB test dùng chung và SỐNG QUA NHIỀU LƯỢT CHẠY, mà `beforeAll` ở đây xoá sạch
  // Order/OrderItem — không dọn đối xứng thì file test chạy sau (kể cả ở lượt `vitest run` KẾ TIẾP)
  // nhận thừa đơn của suite này. Đã đo: bỏ khối này thì `delete-all-data.test.ts` đỏ 2 case trong
  // full suite trong khi chạy riêng vẫn xanh — kiểu hỏng khó lần nhất.
  await prisma.orderItem.deleteMany();
  await prisma.order.deleteMany();
  await prisma.$disconnect();
});

describe("getVariantListPage", () => {
  it("KPI toàn cục: tổng/thiếu giá vốn/tồn/low/giá trị vốn", async () => {
    const { kpi } = await getVariantListPage({ page: 1 });
    expect(kpi.totalSku).toBe(3);
    expect(kpi.missingCost).toBe(1); // V2
    expect(kpi.totalStock).toBe(53);
    expect(kpi.lowCount).toBe(2); // V1 (3<=5), V3 (0<=10, gồm hết hàng)
    expect(kpi.stockValue).toBe(300000); // V1 3×100000; V2 costPrice 0 loại; V3 stock 0
    expect(kpi.skusWithoutCostInValue).toBe(1); // V2 costPrice 0 & stock>0
  });

  it("sort mặc định giá vốn desc + effectiveThreshold + isLow", async () => {
    const { rows, total } = await getVariantListPage({ page: 1 });
    expect(total).toBe(3);
    expect(rows.map((r) => r.sku)).toEqual(["Q-A", "Q-C", "Q-B"]); // 100000, 50000, 0
    const v1 = rows.find((r) => r.sku === "Q-A")!;
    expect(v1.effectiveThreshold).toBe(5); // COALESCE(null, 5)
    expect(v1.isLow).toBe(true);
    expect(v1.stockValue).toBe(300000);
    const v3 = rows.find((r) => r.sku === "Q-C")!;
    expect(v3.effectiveThreshold).toBe(10);
    expect(v3.isLow).toBe(true); // stock 0
    expect(rows.find((r) => r.sku === "Q-B")!.isLow).toBe(false); // 50 > 5
  });

  it("lọc thiếu giá vốn", async () => {
    const { rows, total } = await getVariantListPage({ page: 1, missingCost: true });
    expect(total).toBe(1);
    expect(rows[0].sku).toBe("Q-B");
  });

  it("lọc ĐÃ BÁN mà thiếu giá vốn — đơn HOÀN không tính là đã bán", async () => {
    // Q-B là biến thể duy nhất costPrice=0, và nó CHỈ nằm trong một đơn RETURNED ⇒ lọc thường trả
    // 1 dòng, lọc hành-động-được trả 0. Cùng định nghĩa "đơn hợp lệ" với pnl.ts.
    const { total } = await getVariantListPage({ page: 1, soldMissingCost: true });
    expect(total).toBe(0);
    expect((await getVariantListPage({ page: 1, missingCost: true })).total).toBe(1);
  });

  it("lọc sắp hết (isLow, gồm hết hàng)", async () => {
    const { rows } = await getVariantListPage({ page: 1, lowOnly: true });
    expect(rows.map((r) => r.sku).sort()).toEqual(["Q-A", "Q-C"]);
  });

  it("search q theo sku/tên/label không phân biệt hoa-thường", async () => {
    const { rows } = await getVariantListPage({ page: 1, q: "q-a" });
    expect(rows.map((r) => r.sku)).toEqual(["Q-A"]);
  });
});

describe("getVariantsForExport + countMissingCostVariants", () => {
  it("export không phân trang", async () => {
    expect(await getVariantsForExport({})).toHaveLength(3);
    expect(await getVariantsForExport({ lowOnly: true })).toHaveLength(2);
  });
  it("đếm thiếu giá vốn", async () => {
    expect(await countMissingCostVariants()).toBe(1);
  });
});
