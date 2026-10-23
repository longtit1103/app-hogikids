import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { Prisma } from "@/generated/prisma/client";
import { transformFromRaw } from "@/lib/bronze/transform-from-raw";
import { xuLySuKienWebhook } from "@/lib/ingest/webhook-processor";
import { prisma } from "@/lib/prisma";

import { SHOP_TIKTOK } from "../helpers/shop-ids-fixture";
import { seedReference, truncateBusinessTables } from "../helpers/test-db";

/**
 * Guard land của webhook (`laSuKienCuHon`) phải so sự kiện với BẢN ĐỨNG ĐẦU theo thứ tự phiên bản chung
 * — đúng bản Silver đang phản ánh — chứ không phải dòng Bronze land gần nhất.
 *
 * Ca đo được: A (API, mốc X, phí THẬT 5.839 sau đối soát) đã dựng; trang API cũ B (mốc W < X) land muộn
 * và nằm dưới A. Sự kiện E cùng mốc X mang phí TẠM 16.000: so với B thì X > W ⇒ land, mà cùng mốc X
 * với A + land muộn hơn ⇒ E đứng đầu ⇒ Silver 5.839 → 16.000, lượt API sau trùng hash nên không tự lành.
 */
const X = "2026-07-01T06:30:00.123456";
const W = "2026-07-01T05:00:00.000000";
const SAU_X = "2026-07-01T07:00:00.000000";

const DON = (id: string, fee: number, status: number, updatedAt: string) => ({
  id,
  system_id: id,
  status,
  status_name: "x",
  inserted_at: "2026-07-01T03:00:00.000000",
  updated_at: updatedAt,
  status_history: [],
  order_sources_name: "Tiktok",
  marketplace_id: "-9",
  total_price: 200000,
  total_discount: 0,
  shipping_fee: 0,
  fee_marketplace: fee,
  cod: 0,
  advanced_platform_fee: { payment_fee: 0 },
  customer: { name: "Chị Hoa" },
  items: [
    {
      quantity: 2,
      discount_each_product: 0,
      variation_info: { display_id: "SKU-TT-1", name: "Áo thun", retail_price: 100000 },
    },
  ],
});

async function chenVaDung(id: string, payload: object, hash: string, fetchedAt: Date): Promise<void> {
  await prisma.rawPancakeOrder.create({
    data: {
      shopId: SHOP_TIKTOK,
      externalId: id,
      payloadHash: hash,
      payload: payload as Prisma.InputJsonValue,
      fetchedAt,
    },
  });
  await transformFromRaw("orders", [], { externalIds: [id], shopId: SHOP_TIKTOK });
}

/** A đã đối soát (mốc X) rồi trang cũ B (mốc W) land muộn — Silver giữ A. */
async function dungAvaB(id: string): Promise<void> {
  await chenVaDung(id, DON(id, 5839, 4, X), `wh-dd-a-${id}`, new Date(Date.now() - 120_000));
  await chenVaDung(id, DON(id, 16000, 3, W), `wh-dd-b-${id}`, new Date(Date.now() - 60_000));
  const o = await prisma.order.findUniqueOrThrow({ where: { pancakeId: id } });
  expect(o.platformFeeEst).toBe(5839);
}

const suKien = (payload: object) =>
  xuLySuKienWebhook({ shopId: SHOP_TIKTOK, payload: JSON.stringify({ type: "orders", ...payload }) });

beforeAll(async () => {
  await seedReference();
}, 60_000);

beforeEach(async () => {
  await truncateBusinessTables();
  await prisma.rawPancakeOrder.deleteMany();
  // Cờ backlog Bronze là trạng thái toàn cục trong `Setting`: còn bật (test khác để lại, hoặc DB CI
  // chạy thứ tự khác) thì sự kiện bị guard chặn được báo "cần xem" kèm lời nhắc dựng lại thay vì
  // "cũ hơn" — test này đo guard, không đo backlog, nên hạ cờ trước từng ca.
  await prisma.setting.deleteMany({ where: { key: "bronzeBacklogPending" } });
});

describe("guard land webhook so với bản đứng đầu", () => {
  it("sự kiện CÙNG mốc với bản đứng đầu ⇒ không land dù mới hơn dòng land gần nhất; Silver giữ phí thật", async () => {
    const id = "585229755054268001";
    await dungAvaB(id);

    const kq = await suKien(DON(id, 16000, 4, X));

    expect(kq.processedAs).toBe("don-hang-cu-hon");
    expect(await prisma.rawPancakeOrder.count({ where: { externalId: id } })).toBe(2);
    const o = await prisma.order.findUniqueOrThrow({ where: { pancakeId: id } });
    expect(o.platformFeeEst).toBe(5839);
  });

  it("sự kiện mốc MỚI HƠN bản đứng đầu vẫn land và dựng (guard không chặn oan)", async () => {
    const id = "585229755054268002";
    await dungAvaB(id);

    const kq = await suKien(DON(id, 7000, 4, SAU_X));

    expect(kq.processedAs).toBe("don-hang");
    expect(await prisma.rawPancakeOrder.count({ where: { externalId: id } })).toBe(3);
    const o = await prisma.order.findUniqueOrThrow({ where: { pancakeId: id } });
    expect(o.platformFeeEst).toBe(7000);
  });
});
