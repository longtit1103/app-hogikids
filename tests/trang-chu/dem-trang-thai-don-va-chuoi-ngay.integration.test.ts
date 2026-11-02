import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { prisma } from "@/lib/prisma";
import { computeDailySeries } from "@/lib/reports/daily-series";
import { calcPnl } from "@/lib/reports/pnl";
import { chiaChiPhi } from "@/lib/trang-chu/chia-chi-phi";
import { demTrangThaiDon } from "@/lib/trang-chu/dem-trang-thai-don";

import { seedReference, truncateBusinessTables } from "../helpers/test-db";

/**
 * Trang chủ đọc ba nguồn số cùng kỳ: `calcPnl` (thẻ), `computeDailySeries` (biểu đồ ngày), `demTrangThaiDon`
 * (tròn đơn). Chúng phải khớp nhau trên DB THẬT (`hogikids_test`) — lệch biên kỳ (quên `endOfDay`) hay quên
 * một vế chi phí ở chuỗi ngày là trang chủ lệch tab Lãi/Lỗ mà không màn nào báo. Kỳ cố định 10/2026, giờ VN.
 */

const RANGE = { from: new Date(2026, 9, 1), to: new Date(2026, 9, 31) };
const NGAY = (d: number, h = 9) => new Date(`2026-10-${String(d).padStart(2, "0")}T${String(h).padStart(2, "0")}:00:00+07:00`);
const NGOAI_KY = new Date("2026-11-01T08:00:00+07:00");

beforeAll(async () => {
  await seedReference();
}, 60_000);

beforeEach(async () => {
  await truncateBusinessTables();
});

afterAll(async () => {
  await truncateBusinessTables();
  await prisma.$disconnect();
});

async function seed(): Promise<void> {
  const sp = await prisma.product.create({ data: { pancakeId: "TC-SP-1", name: "Áo trang chủ", syncedAt: NGAY(1) } });
  const bt = await prisma.variant.create({
    data: { pancakeId: "TC-BT-1", productId: sp.id, sku: "TC-1", label: "M", costPrice: 120_000, syncedAt: NGAY(1) },
  });

  const don = (
    id: string,
    status: "PENDING" | "SHIPPING" | "COMPLETED" | "RETURNED" | "CANCELLED",
    orderedAt: Date,
    extra: { returnedFee?: number } = {}
  ) =>
    prisma.order.create({
      data: {
        pancakeId: id,
        code: id,
        channelId: id.endsWith("T") ? "tiktok" : "shopee",
        status,
        orderedAt,
        syncedAt: orderedAt,
        itemsTotal: 400_000,
        discount: 20_000,
        platformFeeEst: 40_000,
        ...extra,
        items: {
          create: [{ variantId: bt.id, sku: "TC-1", productName: "Áo trang chủ", quantity: 2, unitPrice: 200_000 }],
        },
      },
    });

  await don("TC-1S", "PENDING", NGAY(3));
  await don("TC-2T", "SHIPPING", NGAY(10));
  await don("TC-3S", "COMPLETED", NGAY(10, 22));
  await don("TC-4S", "COMPLETED", NGAY(31, 21)); // 21h ngày cuối kỳ — bẫy quên endOfDay
  await don("TC-5S", "RETURNED", NGAY(12), { returnedFee: 15_000 });
  await don("TC-6T", "CANCELLED", NGAY(20), { returnedFee: 5_000 });
  await don("TC-7S", "COMPLETED", NGOAI_KY); // ngoài kỳ — không được đếm

  const chiPhi = (ngay: Date, categoryId: string, amount: number, adsSource: string | null = null) => ({
    date: ngay,
    categoryId,
    adsSource,
    channelId: adsSource === "TIKTOK_ADS" ? "tiktok" : null,
    description: `trang chủ ${categoryId}`,
    amount,
  });
  await prisma.expense.createMany({
    data: [
      chiPhi(new Date("2026-10-10T00:00:00+07:00"), "ads", 90_000, "TIKTOK_ADS"),
      chiPhi(NGAY(5), "ads", 50_000, "META"),
      chiPhi(NGAY(6), "shipping", 12_000),
      chiPhi(NGAY(7), "packaging", 8_000),
      chiPhi(NGAY(8), "return_bom", 4_000),
      chiPhi(NGAY(1), "fixed", 300_000),
      chiPhi(NGAY(15), "interest", 25_000),
      chiPhi(NGAY(16), "other", 6_000),
      chiPhi(NGAY(17), "purchase", 9_000_000), // Nhập hàng — dòng tiền, không vào chi phí
      chiPhi(NGOAI_KY, "fixed", 777_000),
    ],
  });
  await prisma.thuNhap.create({
    data: { date: NGAY(18), kind: "LAI_TIET_KIEM", amount: 33_000, description: "Lãi sổ trang chủ" },
  });
  await prisma.tiktokAdsTinDung.create({
    data: {
      ngay: new Date("2026-10-10T00:00:00+07:00"),
      advertiserId: "TC-ADV",
      bcId: "TC-BC",
      grantExVat: 30_000,
      cashExVat: 60_000,
      amountExVat: 90_000,
      grantGomVat: 32_400,
    },
  });
}

describe("demTrangThaiDon — tròn đơn khớp calcPnl cùng kỳ", () => {
  it("Σ mọi trạng thái = orderCount + returnBomOrderCount; đủ 5 khoá; đơn ngoài kỳ không đếm", async () => {
    await seed();
    const [dem, b] = await Promise.all([demTrangThaiDon(RANGE), calcPnl(RANGE)]);
    expect(dem).toEqual({ PENDING: 1, SHIPPING: 1, COMPLETED: 2, RETURNED: 1, CANCELLED: 1 });
    const tong = Object.values(dem).reduce((s, n) => s + n, 0);
    expect(tong).toBe(b.orderCount + b.returnBomOrderCount);
  });

  it("kỳ rỗng ⇒ đủ 5 khoá, mọi số 0", async () => {
    expect(await demTrangThaiDon(RANGE)).toEqual({ PENDING: 0, SHIPPING: 0, COMPLETED: 0, RETURNED: 0, CANCELLED: 0 });
  });
});

describe("computeDailySeries — chiPhi + orderCount theo ngày khớp cả kỳ", () => {
  it("Σ chiPhi ngày = chiaChiPhi(calcPnl).chiPhi; Σ orderCount = orderCount; Σ netProfit = netProfit", async () => {
    await seed();
    const [series, b] = await Promise.all([computeDailySeries(RANGE), calcPnl(RANGE)]);
    // Fixture phải phủ đủ vế, nếu không đồng nhất xanh giả.
    expect(b.cogs).toBeGreaterThan(0);
    expect(b.adsTinDungTang).toBe(32_400);
    expect(b.financialIncome).toBe(33_000);
    expect(b.returnedOrderFee).toBe(20_000);

    const sum = (f: (p: (typeof series)[number]) => number) => series.reduce((s, p) => s + f(p), 0);
    expect(series).toHaveLength(31);
    expect(sum((p) => p.chiPhi)).toBe(chiaChiPhi(b).chiPhi);
    expect(sum((p) => p.orderCount)).toBe(b.orderCount);
    expect(sum((p) => p.netProfit)).toBe(b.netProfit);
    expect(sum((p) => p.revenue)).toBe(b.revenue);
    expect(series.find((p) => p.date === "2026-10-31")?.orderCount).toBe(1);
  });
});
