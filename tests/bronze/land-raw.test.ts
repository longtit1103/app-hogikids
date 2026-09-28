import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { landRaw } from "@/lib/bronze/land-raw";
import { SHOP_KHO, SHOP_SHOPEE, SHOP_TIKTOK, SHOP_TIKTOK_SHOP } from "../helpers/shop-ids-fixture";
import { prisma } from "@/lib/prisma";

import { seedReference, truncateBusinessTables } from "../helpers/test-db";

/**
 * `461168615117802872` > Number.MAX_SAFE_INTEGER (9007199254740991).
 * `JSON.parse` trong JS làm tròn thành `461168615117802900` → hỏng khoá.
 * Test này là chốt chặn: nếu ai đó lỡ parse payload bằng JS, nó đỏ.
 */
const BIG = "461168615117802872";

/** Response Pancake thật: mảng bọc trong `data`. */
const body = (items: string) => `{"success":true,"data":[${items}]}`;

beforeAll(async () => {
  await seedReference();
}, 60_000);

beforeEach(async () => {
  await truncateBusinessTables();
  await prisma.rawPancakeInventoryHistory.deleteMany();
  await prisma.rawPancakeOrder.deleteMany();
});

describe("landRaw", () => {
  it("giữ NGUYÊN id int64 (JS parse sẽ hỏng thành …900)", async () => {
    await landRaw("inventory_histories", "714995134", body(`{"id":${BIG},"avg_price":1000}`));

    const rows = await prisma.rawPancakeInventoryHistory.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0].externalId).toBe(BIG); // ĐÚNG …872, không phải …900
    expect(rows[0].externalId).not.toBe("461168615117802900");
  });

  it("land 2 lần cùng payload → dedupe, chỉ 1 dòng", async () => {
    const b = body(`{"id":"ORD-1","status":3}`);

    const r1 = await landRaw("orders", "1942992175", b);
    const r2 = await landRaw("orders", "1942992175", b);

    expect(r1.landed).toBe(1);
    expect(r2.landed).toBe(0); // trùng hash → không ghi
    expect(await prisma.rawPancakeOrder.count()).toBe(1);
  });

  it("landedIds = externalId của dòng THỰC SỰ chèn (trùng hash → rỗng)", async () => {
    const r1 = await landRaw("orders", "1942992175", body(`{"id":"A"},{"id":"B"}`));
    const r2 = await landRaw("orders", "1942992175", body(`{"id":"A"},{"id":"B"}`)); // y hệt

    expect([...r1.landedIds].sort()).toEqual(["A", "B"]);
    expect(r2.landedIds).toEqual([]); // DO NOTHING không RETURNING → transform không quét lại
  });

  it("gắn syncLogId vào dòng raw (cột lineage)", async () => {
    const log = await prisma.syncLog.create({ data: { kind: "PANCAKE", status: "RUNNING" } });

    await landRaw("orders", "1942992175", body(`{"id":"ORD-LINEAGE"}`), log.id);

    const row = await prisma.rawPancakeOrder.findFirst({ where: { externalId: "ORD-LINEAGE" } });
    expect(row?.syncLogId).toBe(log.id);
  });

  it("payload ĐỔI → ghi bản mới (giữ lịch sử thay đổi)", async () => {
    await landRaw("orders", "1942992175", body(`{"id":"ORD-1","status":3}`));
    const r2 = await landRaw("orders", "1942992175", body(`{"id":"ORD-1","status":4}`));

    expect(r2.landed).toBe(1);
    const rows = await prisma.rawPancakeOrder.findMany({ where: { externalId: "ORD-1" } });
    expect(rows).toHaveLength(2); // 2 phiên bản
  });

  it("land NHIỀU record trong 1 lần gọi", async () => {
    const r = await landRaw("orders", "1942992175", body(`{"id":"A"},{"id":"B"},{"id":"C"}`));

    expect(r.landed).toBe(3);
    expect(await prisma.rawPancakeOrder.count()).toBe(3);
  });

  it("stream lạ → throw, không đụng DB", async () => {
    await expect(landRaw("khong-ton-tai" as never, "1", body(`{"id":"X"}`))).rejects.toThrow();

    expect(await prisma.rawPancakeOrder.count()).toBe(0);
  });

  it("record thiếu id → bị bỏ nhưng ĐƯỢC ĐẾM, không im lặng", async () => {
    const r = await landRaw("orders", "1942992175", body(`{"id":"A"},{"no_id":true}`));

    expect(r.landed).toBe(1);
    expect(r.skippedNoId).toBe(1);
    expect(await prisma.rawPancakeOrder.count()).toBe(1);
  });

  it("envelope LỖI (không có mảng data) → throw, KHÔNG im lặng, DB 0 dòng", async () => {
    await expect(
      landRaw("orders", "1942992175", `{"success":false,"message":"api key het han"}`)
    ).rejects.toThrow(/data/i);

    expect(await prisma.rawPancakeOrder.count()).toBe(0);
  });
});

/**
 * Hai hệ đánh số shop cùng tên "TikTok" (Pancake `100975192` vs TikTok Shop Open API
 * `7494544063361551019`) → điền nhầm `CONFIG.shopId` trong n8n là chuyện dễ xảy ra. Bronze
 * append-only: một lần backfill nhầm nằm vĩnh viễn trên DB, không lỗi, SyncLog vẫn OK.
 */
describe("landRaw — shopId phải thuộc `shops` của stream", () => {
  it("shop TikTok Shop gửi vào stream Pancake → THROW, DB 0 dòng", async () => {
    await expect(
      landRaw("orders", SHOP_TIKTOK_SHOP, body(`{"id":"ORD-SAI-SHOP"}`))
    ).rejects.toThrow(/không hợp lệ cho stream "orders"/);

    expect(await prisma.rawPancakeOrder.count()).toBe(0);
  });

  it("shop TikTok bên PANCAKE gửi vào stream tiktok/* → THROW, DB 0 dòng", async () => {
    await expect(
      landRaw("tiktok/statements", SHOP_TIKTOK, `{"code":0,"data":{"statements":[{"id":"1"}]}}`)
    ).rejects.toThrow(/không hợp lệ cho stream "tiktok\/statements"/);

    expect(await prisma.rawTiktokShopStatement.count()).toBe(0);
  });

  it("stream chỉ có ở shop kho (purchases) + shop Shopee → THROW", async () => {
    await expect(landRaw("purchases", SHOP_SHOPEE, body(`{"id":"PO-1"}`))).rejects.toThrow(
      /chỉ nhận: 714995134/
    );
  });

  it("shop ĐÚNG → vẫn land bình thường (guard không chặn nhầm)", async () => {
    const r = await landRaw("purchases", SHOP_KHO, body(`{"id":"PO-OK"}`));
    expect(r.landed).toBe(1);
    await prisma.rawPancakePurchase.deleteMany();
  });
});
