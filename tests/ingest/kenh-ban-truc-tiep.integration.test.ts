import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { mapPancakeOrder } from "@/lib/ingest/pancake-mapping";
import { pancakeOrderSchema } from "@/lib/ingest/pancake-schemas";
import { upsertOneOrder, type UpsertStats } from "@/lib/ingest/pancake-upsert";
import { prisma } from "@/lib/prisma";

import { seedReference, truncateBusinessTables } from "../helpers/test-db";

/**
 * Đơn đầu tiên của kênh bán trực tiếp ĐÃ nằm trong Sổ dưới kênh `website` (dựng trước khi có kênh
 * mới). Lượt dựng lại từ CÙNG payload Bronze (cùng mốc nguồn) phải chuyển được sang `direct` và điền
 * `paidAtShop` — đây đúng là thao tác chạy trên prod sau deploy. Doanh thu không đổi một đồng.
 */

const MOC = new Date("2026-09-21T20:00:00Z");
const DON = {
  id: 777,
  system_id: 777,
  status: 3,
  status_name: "delivered",
  inserted_at: "2026-09-21T05:55:19.015402",
  order_sources_name: null,
  marketplace_id: null,
  received_at_shop: true,
  total_price: 559000,
  total_discount: 39000,
  shipping_fee: 0,
  fee_marketplace: 0,
  transfer_money: 520000,
  items: [
    { quantity: 1, discount_each_product: 0, variation_info: { display_id: "SKU-A", retail_price: 440000 } },
    { quantity: 1, discount_each_product: 0, variation_info: { display_id: "SKU-B", retail_price: 119000 } },
  ],
};
const CTX = { channels: {} };

/** Bộ đếm rỗng — test chỉ soi dòng Silver, không soi bộ đếm. Mọi trường là số 0. */
const stats = (): UpsertStats => new Proxy({} as UpsertStats, { get: (t, k) => (t as Record<string | symbol, number>)[k] ?? 0 });

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

describe("dựng lại đơn bán trực tiếp đã nằm ở kênh website", () => {
  it("cùng payload + cùng mốc nguồn ⇒ chuyển sang direct, điền paidAtShop, doanh thu giữ nguyên", async () => {
    const parsed = pancakeOrderSchema.parse(DON);
    // Bản Silver CŨ: dựng bằng mapping trước khi có kênh mới ⇒ website, paidAtShop 0.
    const cu = { ...mapPancakeOrder(parsed, CTX), channelId: "website", paidAtShop: 0 };
    await upsertOneOrder(cu, DON, stats(), [], MOC);
    const truoc = await prisma.order.findUniqueOrThrow({ where: { pancakeId: "777" } });
    expect(truoc.channelId).toBe("website");

    const w: string[] = [];
    await upsertOneOrder(mapPancakeOrder(parsed, CTX), DON, stats(), w, MOC);
    const sau = await prisma.order.findUniqueOrThrow({ where: { pancakeId: "777" } });
    expect(sau.channelId).toBe("direct");
    expect(sau.paidAtShop).toBe(520000);
    expect([sau.itemsTotal, sau.discount, sau.platformFeeEst]).toEqual([truoc.itemsTotal, truoc.discount, truoc.platformFeeEst]);
    expect(sau.itemsTotal - sau.discount).toBe(520000);
    expect(await prisma.order.count()).toBe(1);
  });
});

describe("cổng trùng pancakeId giữa hai shop", () => {
  it("đơn bán trực tiếp shop khác cùng id KHÔNG được đè đơn đang có — bỏ qua + cảnh báo", async () => {
    const donTiktok = { ...DON, shop_id: 100975192 };
    await upsertOneOrder(mapPancakeOrder(pancakeOrderSchema.parse(donTiktok), CTX), donTiktok, stats(), [], MOC);

    const donKho = { ...DON, shop_id: 714995134, total_price: 100000, total_discount: 0, transfer_money: 100000, items: [] };
    const w: string[] = [];
    const kq = await upsertOneOrder(mapPancakeOrder(pancakeOrderSchema.parse(donKho), CTX), donKho, stats(), w, MOC);

    expect(kq).toBe("CHAN");
    expect(w.some((x) => x.includes("ĐANG thuộc đơn của shop 100975192"))).toBe(true);
    const giu = await prisma.order.findUniqueOrThrow({ where: { pancakeId: "777" } });
    expect([giu.itemsTotal, giu.paidAtShop]).toEqual([559000, 520000]);
  });

  it("cùng shop ghi lại (dựng lại / webhook) vẫn đi qua bình thường", async () => {
    const don = { ...DON, shop_id: 100975192 };
    await upsertOneOrder(mapPancakeOrder(pancakeOrderSchema.parse(don), CTX), don, stats(), [], MOC);
    expect(await upsertOneOrder(mapPancakeOrder(pancakeOrderSchema.parse(don), CTX), don, stats(), [], MOC)).toBe("APPLIED");
  });
});
