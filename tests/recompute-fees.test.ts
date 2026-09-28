import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { countRecomputableOrders, recomputeFeesInRange } from "@/lib/actions/settings-channels";
import { prisma } from "@/lib/prisma";
import { seedReference, truncateBusinessTables } from "./helpers/test-db";

/**
 * HÀNG RÀO bất biến #1 (`hogikids_test`, DB thật): "Tính lại phí kỳ này" CHỈ
 * đụng đơn kênh không có phí sàn thật (Facebook/Website). Đơn Shopee/TikTok
 * mang phí THẬT `fee_marketplace` PHẢI byte-identical sau recompute. `requireUser`
 * + `revalidatePath` mock (không có request scope trong vitest) — xem ads-import.test.ts.
 */
vi.mock("@/lib/session", () => ({
  requireUser: vi.fn(async () => "test-user-id"),
}));
vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

// Kỳ cố định 07/2026, tách khỏi ngày chạy. `to` = 00:00 ngày cuối — action tự
// endOfDay nên đơn 15/07 trong kỳ, đơn 15/08 ngoài kỳ.
const RANGE = { from: new Date(2026, 6, 1), to: new Date(2026, 6, 31) };
const IN_RANGE = new Date(2026, 6, 15); // 15/07/2026
const OUT_OF_RANGE = new Date(2026, 7, 15); // 15/08/2026

const SHOPEE_REAL_FEE = 12_345; // phí THẬT Pancake — không được đụng
const FB_ITEMS_TOTAL = 200_000;
const OUT_FB_FEE = 777; // phí đơn ngoài kỳ — không được đụng

beforeAll(async () => {
  await seedReference();
}, 60_000);

beforeEach(async () => {
  await truncateBusinessTables();
  // facebook: 3% + 1% = 4% (seedReference để facebook 0/0 → set lại cho test).
  await prisma.channel.update({
    where: { id: "facebook" },
    data: { platformFeePct: 3, paymentFeePct: 1 },
  });
});

afterAll(async () => {
  await prisma.$disconnect();
});

async function seedOrders(): Promise<void> {
  await prisma.order.createMany({
    data: [
      // Shopee: phí THẬT — recompute PHẢI bỏ qua.
      {
        pancakeId: "RC-SHOPEE", code: "S1", channelId: "shopee", status: "COMPLETED",
        orderedAt: IN_RANGE, syncedAt: IN_RANGE, itemsTotal: 100_000, platformFeeEst: SHOPEE_REAL_FEE,
      },
      // Facebook: phí ước tính — recompute PHẢI cập nhật (0 → 4% × 200k = 8000).
      {
        pancakeId: "RC-FB", code: "F1", channelId: "facebook", status: "COMPLETED",
        orderedAt: IN_RANGE, syncedAt: IN_RANGE, itemsTotal: FB_ITEMS_TOTAL, platformFeeEst: 0,
      },
      // Facebook NGOÀI kỳ — không được đụng.
      {
        pancakeId: "RC-FB-OUT", code: "F2", channelId: "facebook", status: "COMPLETED",
        orderedAt: OUT_OF_RANGE, syncedAt: OUT_OF_RANGE, itemsTotal: 300_000, platformFeeEst: OUT_FB_FEE,
      },
    ],
  });
}

async function feeOf(pancakeId: string): Promise<number> {
  const o = await prisma.order.findUniqueOrThrow({ where: { pancakeId } });
  return o.platformFeeEst;
}

describe("recomputeFeesInRange — hàng rào phí thật + idempotent", () => {
  it("bỏ qua đơn Shopee (giữ phí THẬT), cập nhật đơn Facebook, updated=1", async () => {
    await seedOrders();

    const res = await recomputeFeesInRange(RANGE);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.updated).toBe(1);

    // BẤT BIẾN: phí thật Shopee KHÔNG bị chạm.
    expect(await feeOf("RC-SHOPEE")).toBe(SHOPEE_REAL_FEE);
    // Facebook = round(200000 × 4 / 100) = 8000.
    expect(await feeOf("RC-FB")).toBe(Math.round((FB_ITEMS_TOTAL * 4) / 100));
    expect(await feeOf("RC-FB")).toBe(8000);
    // Đơn ngoài kỳ nguyên vẹn.
    expect(await feeOf("RC-FB-OUT")).toBe(OUT_FB_FEE);
  });

  it("chạy lần 2 → updated=0 (idempotent), giá trị không đổi", async () => {
    await seedOrders();

    const first = await recomputeFeesInRange(RANGE);
    expect(first.ok && first.data.updated).toBe(1);

    const second = await recomputeFeesInRange(RANGE);
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.data.updated).toBe(0);

    expect(await feeOf("RC-SHOPEE")).toBe(SHOPEE_REAL_FEE);
    expect(await feeOf("RC-FB")).toBe(8000);
    expect(await feeOf("RC-FB-OUT")).toBe(OUT_FB_FEE);
  });
});

describe("countRecomputableOrders — chỉ đếm đơn không phí thật trong kỳ", () => {
  it("đếm 1 (đơn Facebook trong kỳ); bỏ Shopee và đơn ngoài kỳ", async () => {
    await seedOrders();
    const res = await countRecomputableOrders(RANGE);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.count).toBe(1);
  });
});
