import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { getOrderDetail, getOrderListPage } from "@/lib/queries/orders";
import { prisma } from "@/lib/prisma";
import { seedReference, truncateBusinessTables } from "../helpers/test-db";

/**
 * Integration test cột "Mã sàn" trên `/don-hang` (DB test).
 *
 * `maSan` = `Order.pancakeId` — với đơn marketplace, Pancake dùng luôn mã đơn của sàn
 * làm `id`. Hai ca phải trả NULL (hiện "—") vì pancakeId KHÔNG phải mã sàn thật:
 *  - đơn bù từ bản sao kho (`backfilledFromMirror`): pancakeId là id mirror "AF…";
 *  - kênh ngoài sàn (website/facebook): pancakeId là id nội bộ Pancake.
 *
 * Seed CỐ Ý cho `code` ≠ `pancakeId` ở mọi đơn: nếu code lỡ trả nhầm field này
 * sang field kia thì assertion vỡ rõ (đối chứng không mù).
 */

const SHOPEE_MA_SAN = "MAU-DON-0001"; // dạng mã đơn Shopee thật (fixture ghi-chu-shape-thuc-te.md)
const TIKTOK_MA_SAN = "579172014854280645"; // dạng mã đơn TikTok 18 chữ số

const SEED = [
  { pancakeId: SHOPEE_MA_SAN, code: "91", channelId: "shopee", backfilledFromMirror: false },
  { pancakeId: TIKTOK_MA_SAN, code: "1234", channelId: "tiktok", backfilledFromMirror: false },
  // Đơn bù từ mirror kho: pancakeId giữ id mirror AF… (scripts/bu-don-shopee-tu-don-kho.ts).
  { pancakeId: "AF1942992175O21", code: "21", channelId: "shopee", backfilledFromMirror: true },
  // Kênh ngoài sàn: pancakeId là id nội bộ Pancake, không đối chiếu được với sàn nào.
  { pancakeId: "554433", code: "77", channelId: "website", backfilledFromMirror: false },
];

beforeAll(async () => {
  await seedReference();
  await truncateBusinessTables();

  const now = new Date();
  await prisma.order.createMany({
    data: SEED.map((o, i) => ({
      pancakeId: o.pancakeId,
      code: o.code,
      channelId: o.channelId,
      backfilledFromMirror: o.backfilledFromMirror,
      status: "COMPLETED" as const,
      orderedAt: new Date(2026, 0, 1 + i, 10, 0, 0),
      itemsTotal: 100_000,
      syncedAt: now,
    })),
  });
}, 60_000);

afterAll(async () => {
  await truncateBusinessTables();
  await prisma.$disconnect();
});

describe("getOrderListPage — cột Mã sàn", () => {
  it("đơn Shopee/TikTok thường: maSan = pancakeId (mã đơn bên sàn), KHÔNG phải code", async () => {
    const { rows } = await getOrderListPage({ page: 1 });
    const shopee = rows.find((r) => r.code === "91")!;
    const tiktok = rows.find((r) => r.code === "1234")!;
    expect(shopee.maSan).toBe(SHOPEE_MA_SAN);
    expect(tiktok.maSan).toBe(TIKTOK_MA_SAN);
  });

  it("đơn bù từ mirror kho (backfilledFromMirror): maSan = null, KHÔNG lộ id AF…", async () => {
    const { rows } = await getOrderListPage({ page: 1 });
    expect(rows.find((r) => r.code === "21")!.maSan).toBeNull();
  });

  it("kênh ngoài sàn (website): maSan = null", async () => {
    const { rows } = await getOrderListPage({ page: 1 });
    expect(rows.find((r) => r.code === "77")!.maSan).toBeNull();
  });
});

describe("getOrderListPage — tìm kiếm theo mã sàn", () => {
  it("q = trọn mã sàn Shopee → đúng 1 đơn", async () => {
    const { total, rows } = await getOrderListPage({ page: 1, q: SHOPEE_MA_SAN });
    expect(total).toBe(1);
    expect(rows[0].code).toBe("91");
  });

  it("q = một phần mã sàn TikTok → vẫn tìm ra (contains)", async () => {
    const { total, rows } = await getOrderListPage({ page: 1, q: "854280645" });
    expect(total).toBe(1);
    expect(rows[0].code).toBe("1234");
  });

  it("q = code vẫn tìm được như cũ (không mất đường tìm hiện có)", async () => {
    const { total, rows } = await getOrderListPage({ page: 1, q: "1234" });
    expect(total).toBe(1);
    expect(rows[0].maSan).toBe(TIKTOK_MA_SAN);
  });
});

describe("getOrderDetail — Mã sàn trong drawer", () => {
  it("đơn sàn thường mang maSan; đơn bù mirror thì null", async () => {
    const { rows } = await getOrderListPage({ page: 1 });
    const shopeeId = rows.find((r) => r.code === "91")!.id;
    const mirrorId = rows.find((r) => r.code === "21")!.id;

    const shopee = await getOrderDetail(shopeeId);
    const mirror = await getOrderDetail(mirrorId);
    expect(shopee!.maSan).toBe(SHOPEE_MA_SAN);
    expect(mirror!.maSan).toBeNull();
  });
});
