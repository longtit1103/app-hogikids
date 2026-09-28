import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { getProductListPage } from "@/lib/queries/products";
import { prisma } from "@/lib/prisma";

/**
 * Integration test query GOM THEO PRODUCT (redesign /san-pham 2026-07-17) trên DB test.
 * Seed 3 sản phẩm (tên ASCII để ORDER BY name không phụ thuộc collation):
 *  - Pa: 2 biến thể, giá vốn LỆCH (100k/0) → uniformCost null, thiếu giá vốn, có biến thể low.
 *  - Pb: 2 biến thể, giá vốn ĐỒNG NHẤT 50k → uniformCost 50k, low (1 biến thể tồn 0), còn tồn.
 *  - Pc: 1 biến thể, giá vốn 0 + tồn 0 → thiếu giá vốn, hết hàng.
 */

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

  const now = new Date();
  const pa = await prisma.product.create({
    data: { pancakeId: "GP-Pa", name: "A San pham", categoryName: "Bộ thun", syncedAt: now },
  });
  const pb = await prisma.product.create({
    data: { pancakeId: "GP-Pb", name: "B San pham", categoryName: "Váy", syncedAt: now },
  });
  const pc = await prisma.product.create({
    data: { pancakeId: "GP-Pc", name: "C San pham", categoryName: null, syncedAt: now },
  });

  // Đơn để phân biệt "đã bán" vs "chưa bán" cho bộ lọc hành-động-được. Kênh dùng ref-data seed sẵn.
  const seedDon = async (variantIds: { pa2: string; pc1: string }) => {
    const donHopLe = await prisma.order.create({
      data: {
        pancakeId: "GP-ORD-OK", code: "GP-OK", channelId: "shopee", status: "COMPLETED",
        orderedAt: now, itemsTotal: 90000, syncedAt: now,
      },
    });
    const donHoan = await prisma.order.create({
      data: {
        pancakeId: "GP-ORD-RET", code: "GP-RET", channelId: "shopee", status: "RETURNED",
        orderedAt: now, itemsTotal: 120000, syncedAt: now,
      },
    });
    await prisma.orderItem.createMany({
      data: [
        { orderId: donHopLe.id, variantId: variantIds.pa2, sku: "GP-A-2", productName: "A San pham", quantity: 1, unitPrice: 90000 },
        { orderId: donHoan.id, variantId: variantIds.pc1, sku: "GP-C-1", productName: "C San pham", quantity: 1, unitPrice: 120000 },
      ],
    });
  };

  await prisma.variant.createMany({
    data: [
      { pancakeId: "GP-Va1", productId: pa.id, sku: "GP-A-1", label: "90/Đỏ", sellPrice: 200000, stock: 3, costPrice: 100000, lowStockThreshold: null, syncedAt: now },
      { pancakeId: "GP-Va2", productId: pa.id, sku: "GP-A-2", label: "90/Xanh", sellPrice: 90000, stock: 50, costPrice: 0, lowStockThreshold: null, syncedAt: now },
      { pancakeId: "GP-Vb1", productId: pb.id, sku: "GP-B-1", label: "100/Hồng", sellPrice: 150000, stock: 0, costPrice: 50000, lowStockThreshold: 10, syncedAt: now },
      { pancakeId: "GP-Vb2", productId: pb.id, sku: "GP-B-2", label: "110/Hồng", sellPrice: 150000, stock: 8, costPrice: 50000, lowStockThreshold: null, syncedAt: now },
      { pancakeId: "GP-Vc1", productId: pc.id, sku: "GP-C-1", label: "80/Vàng", sellPrice: 120000, stock: 0, costPrice: 0, lowStockThreshold: null, syncedAt: now },
    ],
  });

  const [va2, vc1] = await Promise.all([
    prisma.variant.findUniqueOrThrow({ where: { pancakeId: "GP-Va2" }, select: { id: true } }),
    prisma.variant.findUniqueOrThrow({ where: { pancakeId: "GP-Vc1" }, select: { id: true } }),
  ]);
  await seedDon({ pa2: va2.id, pc1: vc1.id });
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

describe("getProductListPage — KPI cấp sản phẩm", () => {
  it("đếm theo sản phẩm + giá trị tồn theo vốn", async () => {
    const { kpi } = await getProductListPage({ page: 1 });
    expect(kpi.totalProducts).toBe(3);
    expect(kpi.totalVariants).toBe(5);
    expect(kpi.missingCostProducts).toBe(2); // Pa (Va2=0), Pc (Vc1=0)
    expect(kpi.lowStockProducts).toBe(3); // Pa(Va1 3<=5), Pb(Vb1 0<=10), Pc(Vc1 0<=5)
    expect(kpi.stockValue).toBe(700000); // Va1 3×100k + Vb2 8×50k
    expect(kpi.productsWithoutCostInValue).toBe(1); // Pa (Va2 cost0 & tồn>0); Pc tồn 0 → bỏ
  });
});

describe("getProductListPage — gom biến thể + aggregate", () => {
  it("mỗi sản phẩm 1 dòng, đúng thứ tự tên + aggregate", async () => {
    const { products, total } = await getProductListPage({ page: 1 });
    expect(total).toBe(3);
    expect(products.map((p) => p.name)).toEqual(["A San pham", "B San pham", "C San pham"]);

    const pa = products[0];
    expect(pa.variantCount).toBe(2);
    expect(pa.sellPriceMin).toBe(90000);
    expect(pa.sellPriceMax).toBe(200000);
    expect(pa.totalStock).toBe(53);
    expect(pa.isLow).toBe(true);
    expect(pa.isOutOfStock).toBe(false);
    expect(pa.hasMissingCost).toBe(true);
    expect(pa.uniformCost).toBeNull(); // 100k vs 0 lệch nhau
    expect(pa.variants).toHaveLength(2);

    const pb = products[1];
    expect(pb.uniformCost).toBe(50000); // đồng nhất
    expect(pb.hasMissingCost).toBe(false);
    expect(pb.isLow).toBe(true); // Vb1 tồn 0 <= 10
    expect(pb.isOutOfStock).toBe(false); // tổng tồn 8

    const pc = products[2];
    expect(pc.variantCount).toBe(1);
    expect(pc.uniformCost).toBe(0);
    expect(pc.hasMissingCost).toBe(true);
    expect(pc.isOutOfStock).toBe(true); // tổng tồn 0
  });
});

describe("getProductListPage — filter + search", () => {
  it("lọc thiếu giá vốn (theo sản phẩm)", async () => {
    const { products, total } = await getProductListPage({ page: 1, missingCost: true });
    expect(total).toBe(2);
    expect(products.map((p) => p.name)).toEqual(["A San pham", "C San pham"]);
  });

  it("lọc sắp hết (theo sản phẩm)", async () => {
    const { total } = await getProductListPage({ page: 1, lowOnly: true });
    expect(total).toBe(3);
  });

  it("lọc ĐÃ BÁN mà thiếu giá vốn — chỉ tính đơn HỢP LỆ, hẹp hơn lọc thiếu-giá-vốn thường", async () => {
    // Đây là tập HÀNH ĐỘNG ĐƯỢC: nhập giá vốn cho nó thì số P&L đổi ngay, khác với biến thể chưa
    // bán ngày nào (nhập cũng không đổi con số nào). Pa bán trong đơn COMPLETED ⇒ vào; Pc chỉ bán
    // trong đơn RETURNED ⇒ RA (đúng định nghĩa đơn hợp lệ của pnl.ts: ∉ {RETURNED, CANCELLED}).
    const { products, total } = await getProductListPage({ page: 1, soldMissingCost: true });
    expect(total).toBe(1);
    expect(products.map((p) => p.name)).toEqual(["A San pham"]);
  });

  it("search theo tên sản phẩm", async () => {
    const { products } = await getProductListPage({ page: 1, q: "b san" });
    expect(products.map((p) => p.name)).toEqual(["B San pham"]);
  });

  it("search theo SKU biến thể vẫn hiện sản phẩm cha", async () => {
    const { products } = await getProductListPage({ page: 1, q: "gp-b-2" });
    expect(products.map((p) => p.name)).toEqual(["B San pham"]);
  });
});
