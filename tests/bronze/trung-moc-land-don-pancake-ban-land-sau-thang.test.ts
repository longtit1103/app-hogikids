import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  demCanXem,
  dongDauCacBanCuChuaDongDau,
  ketCucHienTaiCuaDon,
  locDonChuaDongDau,
} from "@/lib/bronze/ket-cuc-silver";
import { landRaw } from "@/lib/bronze/land-raw";
import { transformFromRaw } from "@/lib/bronze/transform-from-raw";
import { latestPayloads } from "@/lib/bronze/transform-raw-helpers";
import { xuLySuKienWebhook } from "@/lib/ingest/webhook-processor";
import { prisma } from "@/lib/prisma";
import { doiChieuDonKhoVsSan } from "@/lib/reports/doi-chieu-don-kho";

import { SHOP_KHO, SHOP_SHOPEE, SHOP_TIKTOK } from "../helpers/shop-ids-fixture";
import { seedReference, truncateBusinessTables } from "../helpers/test-db";

/**
 * Hai phiên bản của CÙNG một đơn land TRÙNG `fetchedAt` tới mili-giây (TIMESTAMP(3)) — có thật khi hai lượt land tuần
 * tự dưới khoá cách nhau vài ms. Khi đó bản land SAU phải đứng đầu ở MỌI bộ chọn bản (dựng Silver, sổ kết cục, guard
 * webhook, đối chiếu kho), bất kể `id` (uuid ngẫu nhiên). Mỗi ca ÉP tổ hợp xấu nhất: cùng `fetchedAt`, id bản land
 * trước `ffffffff-…` (lớn hơn), bản land sau `00000000-…` — `landSeq` để nguyên như lúc land.
 */

const body = (items: string) => `{"success":true,"data":[${items}]}`;
const ID_TRUOC = "ffffffff-ffff-4fff-bfff-ffffffffffff";
const ID_SAU = "00000000-0000-4000-8000-000000000000";

const DON = (id: string, status: number, opts: { updatedAt?: string; khach?: boolean } = {}) =>
  JSON.stringify({
    id,
    system_id: id,
    status,
    inserted_at: "2026-07-01T10:00:00.000000",
    ...(opts.updatedAt ? { updated_at: opts.updatedAt } : {}),
    order_sources_name: "Shopee",
    marketplace_id: "-3",
    total_price: 200000,
    total_discount: 0,
    fee_marketplace: 15000,
    ...(opts.khach ? { customer: { name: "Chị Hoa" } } : {}),
    items: [{ quantity: 2, discount_each_product: 0, variation_info: { display_id: "SKU-T1", name: "SP", retail_price: 100000 } }],
  });

/** Ép hai dòng của đơn trùng `fetchedAt` + uuid ngược thứ tự land. Trả cặp (bản land trước, bản land sau). */
async function epTrungMoc(shopId: string, externalId: string): Promise<void> {
  const dong = await prisma.$queryRaw<{ id: string; landSeq: bigint }[]>`
    SELECT "id", "landSeq" FROM "RawPancakeOrder" WHERE "shopId" = ${shopId} AND "externalId" = ${externalId} ORDER BY "landSeq"`;
  expect(dong).toHaveLength(2);
  expect(dong[1].landSeq > dong[0].landSeq).toBe(true);
  await prisma.$executeRaw`
    UPDATE "RawPancakeOrder" SET "fetchedAt" = (
      SELECT min("fetchedAt") FROM "RawPancakeOrder" WHERE "shopId" = ${shopId} AND "externalId" = ${externalId})
    WHERE "shopId" = ${shopId} AND "externalId" = ${externalId}`;
  await prisma.$executeRaw`UPDATE "RawPancakeOrder" SET "id" = ${ID_TRUOC} WHERE "id" = ${dong[0].id}`;
  await prisma.$executeRaw`UPDATE "RawPancakeOrder" SET "id" = ${ID_SAU} WHERE "id" = ${dong[1].id}`;
  const [{ n }] = await prisma.$queryRaw<{ n: bigint }[]>`
    SELECT count(DISTINCT "fetchedAt")::bigint AS n FROM "RawPancakeOrder" WHERE "externalId" = ${externalId}`;
  expect(Number(n)).toBe(1);
}

/** Land hai bản (status 3 rồi 4) của đơn qua đúng đường `landRaw`, rồi ép trùng mốc. */
async function haiBanTrungMoc(externalId: string, opts: { truoc?: Parameters<typeof DON>[2]; sau?: Parameters<typeof DON>[2] } = {}) {
  await landRaw("orders", SHOP_SHOPEE, body(DON(externalId, 3, opts.truoc)));
  await landRaw("orders", SHOP_SHOPEE, body(DON(externalId, 4, opts.sau)));
  await epTrungMoc(SHOP_SHOPEE, externalId);
}

const datKetCuc = (id: string, ketCuc: string | null) =>
  prisma.rawPancakeOrder.update({ where: { id }, data: { silverOutcome: ketCuc } });

beforeAll(async () => {
  await seedReference();
}, 60_000);

beforeEach(async () => {
  await truncateBusinessTables();
  await prisma.rawPancakeOrder.deleteMany();
  await prisma.setting.deleteMany({ where: { key: "bronzeBacklogPending" } });
});

// Dọn cả SAU file — không để dòng kho thô / Silver của file này sống sang file chạy sau.
afterAll(async () => {
  await truncateBusinessTables();
  await prisma.rawPancakeOrder.deleteMany();
  await prisma.setting.deleteMany({ where: { key: "bronzeBacklogPending" } });
});

describe("trùng fetchedAt + uuid ngược ⇒ bản land SAU đứng đầu ở mọi bộ chọn bản", () => {
  it("latestPayloads — quét cả bảng lẫn theo externalIds", async () => {
    await haiBanTrungMoc("TM-1");
    const caBang = await latestPayloads("RawPancakeOrder", {});
    const theoDon = await latestPayloads("RawPancakeOrder", { shopId: SHOP_SHOPEE, externalIds: ["TM-1"] });
    expect(caBang.map((r) => r.id)).toEqual([ID_SAU]);
    expect(theoDon.map((r) => r.id)).toEqual([ID_SAU]);
    expect(typeof theoDon[0].landSeq).toBe("bigint");
  });

  it("dựng Silver từ kho thô ⇒ nội dung bản land sau; bản sau APPLIED, bản trước SUPERSEDED", async () => {
    await haiBanTrungMoc("TM-2");
    await transformFromRaw("orders", []);
    const o = await prisma.order.findUniqueOrThrow({ where: { pancakeId: "TM-2" } });
    expect(o.status).toBe("RETURNED");
    const sau = await prisma.rawPancakeOrder.findUniqueOrThrow({ where: { id: ID_SAU } });
    expect(o.rawLandSeq).toBe(sau.landSeq);
    expect(sau.silverOutcome).toBe("APPLIED");
    expect((await prisma.rawPancakeOrder.findUniqueOrThrow({ where: { id: ID_TRUOC } })).silverOutcome).toBe("SUPERSEDED");
  });

  it("sổ kết cục: đơn còn dở / kết cục hiện tại theo bản land sau", async () => {
    await haiBanTrungMoc("TM-3");
    await datKetCuc(ID_SAU, "APPLIED");
    await datKetCuc(ID_TRUOC, null);
    expect(await locDonChuaDongDau(SHOP_SHOPEE, ["TM-3"])).toEqual([]);
    expect(await ketCucHienTaiCuaDon([{ shopId: SHOP_SHOPEE, externalId: "TM-3" }])).toEqual([
      { shopId: SHOP_SHOPEE, externalId: "TM-3", silverOutcome: "APPLIED" },
    ]);
  });

  it("sổ kết cục: đếm cần xem theo bản land sau", async () => {
    await haiBanTrungMoc("TM-4");
    await datKetCuc(ID_SAU, "APPLIED");
    await datKetCuc(ID_TRUOC, "FAILED_SHAPE");
    expect(await demCanXem()).toBe(0);
  });

  it("sổ kết cục: đóng dấu SUPERSEDED đúng bản land TRƯỚC", async () => {
    await haiBanTrungMoc("TM-5");
    expect(await dongDauCacBanCuChuaDongDau()).toBe(1);
    expect((await prisma.rawPancakeOrder.findUniqueOrThrow({ where: { id: ID_TRUOC } })).silverOutcome).toBe("SUPERSEDED");
    expect((await prisma.rawPancakeOrder.findUniqueOrThrow({ where: { id: ID_SAU } })).silverOutcome).toBeNull();
  });

  it("guard land webhook (laSuKienCuHon) so với bản land sau", async () => {
    // Cùng updated_at X; bản land TRƯỚC có `customer`, bản land SAU không. Sự kiện mới hơn (Y > X) không mang
    // `customer`: so với bản land sau thì không thiếu field nào ⇒ land; so nhầm bản land trước thì bị nhường.
    const X = "2026-07-01T06:30:00.000000";
    const Y = "2026-07-01T07:00:00.000000";
    const id = "585229755054268077";
    const don = (status: number, updatedAt: string, khach: boolean) =>
      JSON.parse(DON(id, status, { updatedAt, khach })) as Record<string, unknown>;
    await landRaw("orders", SHOP_TIKTOK, body(JSON.stringify(don(3, X, true))));
    await landRaw("orders", SHOP_TIKTOK, body(JSON.stringify(don(4, X, false))));
    await epTrungMoc(SHOP_TIKTOK, id);
    const kq = await xuLySuKienWebhook({
      shopId: SHOP_TIKTOK,
      payload: JSON.stringify({ type: "orders", ...don(4, Y, false) }),
    });
    expect(kq.note ?? "").not.toMatch(/nhường bản API/);
    expect(await prisma.rawPancakeOrder.count({ where: { externalId: id } })).toBe(3);
  });

  it("đối chiếu bản sao kho đọc trạng thái bản land sau", async () => {
    const idSao = `AF${SHOP_SHOPEE}O7001`;
    const banSao = (statusName: string) =>
      JSON.stringify({
        id: idSao,
        status: 3,
        status_name: statusName,
        inserted_at: "2026-07-01T10:00:00.000000",
        order_sources_name: "Affiliate",
        marketplace_id: "-3",
        total_price: 200000,
        total_discount: 0,
        fee_marketplace: 0,
        cod: 200000,
        items: [],
      });
    await landRaw("orders", SHOP_KHO, body(banSao("returning")));
    await landRaw("orders", SHOP_KHO, body(banSao("delivered")));
    await epTrungMoc(SHOP_KHO, idSao);
    const kq = await doiChieuDonKhoVsSan();
    expect(kq.thieu.map((d) => [d.code, d.trangThaiKho])).toEqual([["7001", "delivered"]]);
  });
});
