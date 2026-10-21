import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { prisma } from "@/lib/prisma";
import { calcPnl, computeChannelPnl } from "@/lib/reports/pnl";

import { seedReference, truncateBusinessTables } from "./helpers/test-db";

/**
 * Danh sách kênh của trang /kenh chỉ được gồm kênh THỰC SỰ có phát sinh dưới lăng kính kênh.
 *
 * Chi phí Nhập hàng (dòng tiền), Cố định và Lãi vay (chi phí chung của cả shop) KHÔNG BAO GIỜ được
 * phân bổ về kênh — `calcPnlCore` đã loại chúng khi có `channelId`. Nếu câu dò danh sách kênh vẫn đếm
 * chúng, một kênh chỉ có loại chi phí ấy hiện ra như một thẻ toàn số 0: chủ shop tưởng kênh đó có hoạt
 * động mà P&L kênh lại trống trơn.
 *
 * Kèm phép đo số P&L (toàn shop + từng kênh) để chắc việc dùng chung danh sách danh mục không làm
 * xê dịch một đồng nào của công thức. Kỳ cố định 6/2026, neo giờ VN.
 */

const RANGE = { from: new Date(2026, 5, 1), to: new Date(2026, 5, 30) };
const IN_RANGE = new Date(2026, 5, 15);

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

/**
 * Shopee: 1 đơn (gộp 417.500 sau phí sàn 62.500 + voucher 20.000, không dòng hàng ⇒ COGS 0) + đóng gói
 * 10.000 + cố định 200.000 gắn kênh. TikTok: chỉ vận chuyển 40.000 gắn kênh. Facebook / Website / Bán
 * trực tiếp: CHỈ có chi phí loại không phân bổ kênh (cố định / nhập hàng / lãi vay).
 */
async function seedKy(): Promise<void> {
  await prisma.order.create({
    data: {
      pancakeId: "KENH-DON-1",
      code: "KD1",
      channelId: "shopee",
      status: "COMPLETED",
      orderedAt: IN_RANGE,
      syncedAt: IN_RANGE,
      itemsTotal: 500_000,
      discount: 20_000,
      platformFeeEst: 62_500,
    },
  });
  const chi = (categoryId: string, channelId: string, amount: number) => ({
    date: IN_RANGE,
    categoryId,
    channelId,
    amount,
    description: `${categoryId} gắn ${channelId}`,
  });
  await prisma.expense.createMany({
    data: [
      chi("packaging", "shopee", 10_000),
      chi("fixed", "shopee", 200_000),
      chi("shipping", "tiktok", 40_000),
      chi("fixed", "facebook", 1_000_000),
      chi("purchase", "website", 5_000_000),
      chi("interest", "direct", 300_000),
    ],
  });
}

describe("computeChannelPnl — danh sách kênh", () => {
  it("kênh CHỈ có chi phí Nhập hàng / Cố định / Lãi vay KHÔNG hiện; kênh có đơn hoặc chi phí kênh vẫn hiện", async () => {
    await seedKy();

    const kenh = await computeChannelPnl(RANGE);

    expect(kenh.map((k) => k.channelId)).toEqual(["shopee", "tiktok"]);
    expect(kenh.find((k) => k.channelId === "shopee")?.netProfit).toBe(407_500);
    expect(kenh.find((k) => k.channelId === "tiktok")?.netProfit).toBe(-40_000);
  });
});

describe("calcPnl — số không đổi", () => {
  it("toàn shop: Nhập hàng không vào P&L; cố định + lãi vay vẫn trừ đủ", async () => {
    await seedKy();

    const b = await calcPnl(RANGE);

    expect(b).toMatchObject({
      revenue: 500_000,
      grossProfit: 417_500,
      packaging: 10_000,
      shipping: 40_000,
      fixed: 1_200_000,
      interest: 300_000,
      other: 0,
      netProfit: 417_500 - 10_000 - 40_000 - 1_200_000 - 300_000,
    });
  });

  it("lăng kính kênh: cố định / lãi vay / nhập hàng gắn kênh KHÔNG phân bổ về kênh", async () => {
    await seedKy();

    expect(await calcPnl(RANGE, { channelId: "shopee" })).toMatchObject({
      grossProfit: 417_500,
      packaging: 10_000,
      fixed: 0,
      interest: 0,
      netProfit: 407_500,
    });
    for (const channelId of ["facebook", "website", "direct"]) {
      expect(await calcPnl(RANGE, { channelId })).toMatchObject({
        revenue: 0,
        fixed: 0,
        interest: 0,
        other: 0,
        netProfit: 0,
      });
    }
  });
});
