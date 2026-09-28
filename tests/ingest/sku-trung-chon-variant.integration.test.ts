import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { mapPancakeOrder } from "@/lib/ingest/pancake-mapping";
import { upsertOneOrder, type UpsertStats } from "@/lib/ingest/pancake-upsert";
import { prisma } from "@/lib/prisma";

import { seedReference, truncateBusinessTables } from "../helpers/test-db";

/**
 * MỘT SKU CÓ NHIỀU BIẾN THỂ — phép chọn phải XÁC ĐỊNH, vì nó quyết `OrderItem.variantId`, tức quyết
 * luôn giá vốn (COGS) của đơn.
 *
 * Trước đây truy vấn tra variant không có `ORDER BY`: Postgres trả theo thứ tự tuỳ lúc (phụ thuộc
 * kế hoạch truy vấn, thứ tự vật lý của heap sau VACUUM…) nên COGS của CÙNG một đơn có thể đổi giữa
 * hai lượt dựng lại mà không ai đụng vào dữ liệu — lãi gộp nhảy số không giải thích được.
 *
 * Luật đã chốt: ưu tiên biến thể ĐÃ CÓ giá vốn, hoà thì `id` nhỏ nhất. Chọn bản có giá vốn cũng là
 * chọn phía thận trọng cho tiền (thà COGS cao còn hơn coi hàng như miễn phí).
 */
const SKU_TRUNG = "SKU-TRUNG-1";

const DON = (id: string) => ({
  id,
  system_id: id,
  status: 3,
  status_name: "Đã giao",
  inserted_at: "2026-07-01T10:00:00.000000",
  updated_at: "2026-07-01T12:00:00.000000",
  status_history: [],
  order_sources_name: "Tiktok",
  marketplace_id: "-9",
  total_price: 200000,
  total_discount: 0,
  shipping_fee: 0,
  fee_marketplace: 10000,
  advanced_platform_fee: { payment_fee: 0 },
  customer: { name: "Chị Hoa" },
  // KHÔNG có `variation_info.variation_id` ⇒ buộc phải tra theo SKU (đúng đường của đơn sàn).
  items: [
    {
      quantity: 2,
      discount_each_product: 0,
      variation_info: { display_id: SKU_TRUNG, name: "Áo thun", retail_price: 100000 },
    },
  ],
});

/** Tạo 2 biến thể TRÙNG SKU; `idNho` là biến thể có `id` nhỏ hơn về mặt thứ tự chuỗi. */
async function taoHaiVariantTrungSku(giaVon: { idNho: number; idLon: number }): Promise<{
  idNho: string;
  idLon: string;
}> {
  const now = new Date();
  const p = await prisma.product.create({
    data: { pancakeId: "P-TRUNG", name: "SP trùng SKU", syncedAt: now },
  });
  const chung = { productId: p.id, sku: SKU_TRUNG, sellPrice: 100000, stock: 5, syncedAt: now };
  const a = await prisma.variant.create({
    data: { ...chung, id: "aaaa-variant", pancakeId: "V-A", label: "A", costPrice: giaVon.idNho },
  });
  const b = await prisma.variant.create({
    data: { ...chung, id: "bbbb-variant", pancakeId: "V-B", label: "B", costPrice: giaVon.idLon },
  });
  return { idNho: a.id, idLon: b.id };
}

async function ghiDon(id: string): Promise<{ variantId: string | null; canhBao: string[] }> {
  const stats: UpsertStats = {
    ordersUpserted: 0,
    productsUpserted: 0,
    variantsUpserted: 0,
    ordersSkippedMirror: 0,
    ordersSkippedStale: 0,
      ordersDiscardedGiuaChung: 0,
    skipped: 0,
    boQuaCoChuDich: 0,
    unknownStatusOrders: 0,
    settlementsUpserted: 0,
    adsUpserted: 0,
    paymentsUpserted: 0,
    shopeeUpserted: 0,
    adsExpensesUpserted: 0,
  };
  const canhBao: string[] = [];
  const raw = DON(id);
  const mo = mapPancakeOrder(raw as never, { channels: {} });
  await upsertOneOrder(mo, raw, stats, canhBao);
  const item = await prisma.orderItem.findFirst({ where: { sku: SKU_TRUNG } });
  return { variantId: item?.variantId ?? null, canhBao };
}

beforeAll(async () => {
  await seedReference();
}, 60_000);

beforeEach(async () => {
  await truncateBusinessTables();
});

describe("SKU trùng nhiều biến thể", () => {
  it("chọn biến thể CÓ giá vốn, kể cả khi bản không-giá-vốn có id nhỏ hơn", async () => {
    const { idLon } = await taoHaiVariantTrungSku({ idNho: 0, idLon: 60000 });

    const { variantId, canhBao } = await ghiDon("D-1");

    expect(variantId).toBe(idLon);
    expect(canhBao.some((c) => c.includes(SKU_TRUNG))).toBe(true); // vẫn phải KÊU để còn đi dọn dữ liệu
  });

  it("hoà giá vốn → lấy id nhỏ nhất (tất định, không phụ thuộc thứ tự DB)", async () => {
    const { idNho } = await taoHaiVariantTrungSku({ idNho: 50000, idLon: 50000 });

    expect((await ghiDon("D-2")).variantId).toBe(idNho);
  });

  it("chạy lại nhiều lần cho CÙNG một kết quả — dựng lại không làm COGS nhảy số", async () => {
    const { idLon } = await taoHaiVariantTrungSku({ idNho: 0, idLon: 60000 });

    for (let i = 0; i < 3; i++) {
      expect((await ghiDon("D-3")).variantId).toBe(idLon);
    }
  });
});
