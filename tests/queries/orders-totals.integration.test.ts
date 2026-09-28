import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { getOrderListPage } from "@/lib/queries/orders";
import { prisma } from "@/lib/prisma";
import { seedReference, truncateBusinessTables } from "../helpers/test-db";

/**
 * Integration test dải tổng đối chiếu P&L trên `/don-hang` (DB test).
 *
 * Điểm chặn quan trọng nhất: `totals` phải tính trên TOÀN BỘ đơn khớp bộ lọc,
 * KHÔNG phải 20 dòng của trang đang xem — sai kiểu này nhìn vẫn "có số" nên
 * không ai phát hiện, mà mục đích đối chiếu với dòng P&L thì mất sạch.
 *
 * Seed 25 đơn (PAGE_SIZE = 20 → chắc chắn có trang 2):
 *  - i = 0..19 : kênh shopee, COMPLETED, ngày 2026-01-01 → 2026-01-20
 *  - i = 20..24: kênh tiktok, CANCELLED, ngày 2026-01-21 → 2026-01-25
 * Tiền tăng dần theo i để mọi tập con có tổng khác nhau (lọc sai là lộ ngay).
 *
 * `returnedFee` seed CỐ Ý lệch khỏi `platformFeeEst` theo 2 chiều để bắt được
 * cả 2 loại bug (review PR #37 — trước đó `totals.platformFeeEst` là Σ thô,
 * lẫn cả returnedFee thật lẫn platformFeeEst tạm của đơn hoàn/hủy):
 *  - COMPLETED (hợp lệ): returnedFee = số RẤT lệch (777_777) — không được dùng,
 *    nếu code lỡ đọc returnedFee cho đơn hợp lệ thì assertion vỡ rõ.
 *  - CANCELLED (hoàn/hủy): returnedFee ≠ platformFeeEst — nếu code lỡ dùng lại
 *    platformFeeEst (bug cũ) cho nhóm này thì tổng cũng lệch rõ.
 */

type SeedOrder = {
  i: number;
  itemsTotal: number;
  platformFeeEst: number;
  returnedFee: number;
  discount: number;
  channelId: string;
  status: "COMPLETED" | "CANCELLED";
  orderedAt: Date;
};

const SEED: SeedOrder[] = Array.from({ length: 25 }, (_, i) => ({
  i,
  itemsTotal: 100_000 + i * 1_000,
  platformFeeEst: 10_000 + i * 100,
  returnedFee: i < 20 ? 777_777 : 3_000 + i * 100,
  discount: 1_000 + i * 10,
  channelId: i < 20 ? "shopee" : "tiktok",
  status: i < 20 ? ("COMPLETED" as const) : ("CANCELLED" as const),
  // Giờ VN (TZ đã ghim trong tests/setup.ts) — 10h sáng để không chạm biên ngày.
  orderedAt: new Date(2026, 0, 1 + i, 10, 0, 0),
}));

/**
 * Σ thủ công trên tập seed — cố ý KHÔNG đi qua prisma.groupBy để làm đối chứng
 * độc lập. `platformFee` mirror công thức `sumPnlPlatformFee`: đơn CANCELLED
 * dùng returnedFee (sàn giữ thật), còn lại dùng platformFeeEst.
 */
function sumOf(orders: SeedOrder[]) {
  return {
    itemsTotal: orders.reduce((s, o) => s + o.itemsTotal, 0),
    platformFee: orders.reduce((s, o) => s + (o.status === "CANCELLED" ? o.returnedFee : o.platformFeeEst), 0),
    discount: orders.reduce((s, o) => s + o.discount, 0),
  };
}

beforeAll(async () => {
  await seedReference();
  await truncateBusinessTables();

  const now = new Date();
  await prisma.order.createMany({
    data: SEED.map((o) => ({
      pancakeId: `OT-${o.i}`,
      code: `OT-${o.i}`,
      channelId: o.channelId,
      status: o.status,
      orderedAt: o.orderedAt,
      customerName: `Khach ${o.i}`,
      itemsTotal: o.itemsTotal,
      platformFeeEst: o.platformFeeEst,
      returnedFee: o.returnedFee,
      discount: o.discount,
      syncedAt: now,
    })),
  });
}, 60_000);

afterAll(async () => {
  await truncateBusinessTables();
  await prisma.$disconnect();
});

describe("getOrderListPage — totals theo bộ lọc", () => {
  it("totals khớp Σ thủ công trên toàn bộ tập seed", async () => {
    const { total, rows, totals } = await getOrderListPage({ page: 1 });
    expect(total).toBe(25);
    expect(rows).toHaveLength(20); // PAGE_SIZE
    expect(totals).toEqual(sumOf(SEED));
    // Giá trị tường minh: 25 đơn, Σ tăng dần theo i — platformFee = Σ platformFeeEst
    // của 20 đơn COMPLETED (219.000) + Σ returnedFee của 5 đơn CANCELLED (26.000).
    expect(totals).toEqual({ itemsTotal: 2_800_000, platformFee: 245_000, discount: 28_000 });
  });

  it("totals KHÔNG đổi khi sang trang khác (tổng theo bộ lọc, không theo trang)", async () => {
    const p1 = await getOrderListPage({ page: 1 });
    const p2 = await getOrderListPage({ page: 2 });

    expect(p2.rows).toHaveLength(5); // trang 2 chỉ còn 5 đơn (5 đơn CŨ nhất — sắp xếp desc)…
    expect(p2.rows.map((r) => r.code)).toEqual(["OT-4", "OT-3", "OT-2", "OT-1", "OT-0"]);
    expect(p2.totals).toEqual(p1.totals); // …nhưng tổng vẫn của cả 25 đơn
    expect(p2.totals).toEqual(sumOf(SEED));
    // Chốt chặn: nếu ai đó cộng theo trang thì tổng trang 2 sẽ tụt xuống còn Σ của 5 dòng đó.
    expect(p2.totals.itemsTotal).not.toBe(sumOf(SEED.filter((o) => o.i <= 4)).itemsTotal);
  });

  it("từng dòng mang platformFeeEst + discount đúng theo đơn", async () => {
    // Sắp xếp mới nhất trước → OT-24 (ngày lớn nhất) nằm đầu trang 1.
    const { rows } = await getOrderListPage({ page: 1 });
    const row = rows.find((r) => r.code === "OT-24");
    const seeded = SEED.find((o) => o.i === 24)!;
    expect(row).toBeDefined();
    expect(row!.itemsTotal).toBe(seeded.itemsTotal);
    expect(row!.platformFeeEst).toBe(seeded.platformFeeEst);
    expect(row!.discount).toBe(seeded.discount);
  });
});

describe("getOrderListPage — totals tôn trọng bộ lọc", () => {
  it("lọc trạng thái", async () => {
    const expected = SEED.filter((o) => o.status === "COMPLETED");
    const { total, totals } = await getOrderListPage({ page: 1, statuses: ["COMPLETED"] });
    expect(total).toBe(expected.length);
    expect(totals).toEqual(sumOf(expected));
    expect(totals.itemsTotal).toBeLessThan(sumOf(SEED).itemsTotal);
  });

  it("lọc kênh", async () => {
    const expected = SEED.filter((o) => o.channelId === "tiktok");
    const { total, totals } = await getOrderListPage({ page: 1, channels: ["tiktok"] });
    expect(total).toBe(expected.length);
    expect(totals).toEqual(sumOf(expected));
  });

  it("lọc khoảng ngày", async () => {
    const from = new Date(2026, 0, 1, 0, 0, 0);
    const to = new Date(2026, 0, 5, 23, 59, 59);
    const expected = SEED.filter((o) => o.orderedAt >= from && o.orderedAt <= to);
    const { total, totals } = await getOrderListPage({ page: 1, from, to });
    expect(total).toBe(5);
    expect(totals).toEqual(sumOf(expected));
  });

  it("bộ lọc không khớp đơn nào → totals = 0 (không phải null)", async () => {
    const { total, totals } = await getOrderListPage({ page: 1, q: "khong-ton-tai-xyz" });
    expect(total).toBe(0);
    expect(totals).toEqual({ itemsTotal: 0, platformFee: 0, discount: 0 });
  });
});
