import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { giuKhoaLandDon } from "@/lib/bronze/khoa-land-don";
import { landRaw } from "@/lib/bronze/land-raw";
import { latestPayloads } from "@/lib/bronze/transform-raw-helpers";
import { xuLySuKienWebhook } from "@/lib/ingest/webhook-processor";
import { prisma } from "@/lib/prisma";

import { SHOP_SHOPEE, SHOP_TIKTOK } from "../helpers/shop-ids-fixture";
import { seedReference, truncateBusinessTables } from "../helpers/test-db";

/**
 * `landSeq` cấp từ sequence lúc INSERT. Dưới khoá `giuKhoaLandDon` hai lượt land cùng đơn TUẦN TỰ ⇒ lượt sau (kể cả
 * lượt đã MỞ transaction trước và phải xếp hàng chờ khoá) luôn mang số lớn hơn và đứng đầu, kể cả khi ép `fetchedAt`
 * bằng nhau. Một câu INSERT nhiều phần tử cấp số theo thứ tự trong trang. Khe sequence (rollback, trùng hash) không làm
 * sai thứ tự.
 */

const DON = (id: string, status: number, updatedAt?: string) => ({
  id,
  system_id: id,
  status,
  inserted_at: "2026-07-01T03:00:00.000000",
  ...(updatedAt ? { updated_at: updatedAt } : {}),
  order_sources_name: "Shopee",
  marketplace_id: "-3",
  total_price: 200000,
  total_discount: 0,
  fee_marketplace: 15000,
  items: [{ quantity: 2, discount_each_product: 0, variation_info: { display_id: "SKU-D1", name: "SP", retail_price: 100000 } }],
});
const trang = (...dons: object[]) => JSON.stringify({ success: true, data: dons });

/** Lượt land kiểu `/api/ingest/raw` (stream `orders`): transaction + khoá land đơn + `landRaw`. */
const landTrangApi = (shopId: string, payload: string) =>
  prisma.$transaction(async (tx) => {
    await giuKhoaLandDon(tx);
    return landRaw("orders", shopId, payload, undefined, tx);
  });

/**
 * Giữ khoá land đơn tới khi test gọi `nha()` — chặn mọi lượt land khác xếp hàng phía sau. Nhả bằng đồng bộ RÕ RÀNG
 * (sau khi `pg_locks` đã thấy đủ phiên chờ), không bằng thời gian cố định: DB chậm thì lượt chờ chưa kịp vào hàng.
 */
function giuKhoaChoToiKhiNha(): { xong: Promise<void>; nha: () => void } {
  let nha!: () => void;
  const choNha = new Promise<void>((r) => (nha = r));
  const xong = prisma.$transaction(
    async (tx) => {
      await giuKhoaLandDon(tx);
      await choNha;
    },
    { timeout: 30_000 },
  );
  return { xong, nha };
}

/**
 * Chờ tới khi khoá tư vấn land đơn ĐANG ĐƯỢC GIỮ bởi một phiên và có đúng `n` phiên XẾP HÀNG phía sau. Postgres cấp
 * khoá cho hàng chờ theo thứ tự vào hàng ⇒ thứ tự land của các lượt khởi chạy sau mỗi lần chờ là xác định.
 */
async function choSoPhienChoKhoa(n: number): Promise<void> {
  for (let i = 0; i < 300; i++) {
    const [{ giu, cho }] = await prisma.$queryRaw<{ giu: bigint; cho: bigint }[]>`
      SELECT count(*) FILTER (WHERE granted)::bigint AS giu, count(*) FILTER (WHERE NOT granted)::bigint AS cho
      FROM pg_locks
      WHERE locktype = 'advisory' AND classid = 0 AND objid = 260727001
        AND database = (SELECT oid FROM pg_database WHERE datname = current_database())`;
    if (Number(giu) === 1 && Number(cho) === n) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`Không thấy khoá land đơn đang giữ với ${n} phiên chờ`);
}

const dongCuaDon = (externalId: string) =>
  prisma.rawPancakeOrder.findMany({
    where: { externalId },
    orderBy: { landSeq: "asc" },
    select: { id: true, landSeq: true, fetchedAt: true, payload: true },
  });

/** Ép mọi dòng của đơn cùng `fetchedAt` và đảo uuid (bản land trước id lớn nhất) — chỉ còn `landSeq` phân xử. */
async function epTrungMocUuidNguoc(externalId: string): Promise<void> {
  const dong = await dongCuaDon(externalId);
  await prisma.$executeRaw`
    UPDATE "RawPancakeOrder" SET "fetchedAt" = (SELECT min("fetchedAt") FROM "RawPancakeOrder" WHERE "externalId" = ${externalId})
    WHERE "externalId" = ${externalId}`;
  for (const [i, d] of dong.entries()) {
    const idMoi = `${String(9 - i).repeat(8)}-0000-4000-8000-${String(i).padStart(12, "0")}`;
    await prisma.$executeRaw`UPDATE "RawPancakeOrder" SET "id" = ${idMoi} WHERE "id" = ${d.id}`;
  }
}

const trangThaiDauBang = async (externalId: string) => {
  const [dau] = await latestPayloads("RawPancakeOrder", { externalIds: [externalId] });
  return (dau.payload as { status: number }).status;
};

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

describe("landSeq dưới khoá land đơn", () => {
  it("API ↔ API: lượt xếp hàng chờ khoá land SAU ⇒ số lớn hơn, đứng đầu kể cả khi trùng fetchedAt", async () => {
    const chan = giuKhoaChoToiKhiNha();
    await choSoPhienChoKhoa(0);
    const thu1 = landTrangApi(SHOP_SHOPEE, trang(DON("DT-1", 3)));
    await choSoPhienChoKhoa(1);
    const thu2 = landTrangApi(SHOP_SHOPEE, trang(DON("DT-1", 4)));
    await choSoPhienChoKhoa(2);
    chan.nha();
    await Promise.all([chan.xong, thu1, thu2]);

    const dong = await dongCuaDon("DT-1");
    expect(dong.map((d) => (d.payload as { status: number }).status)).toEqual([3, 4]);
    expect(dong[1].fetchedAt.getTime()).toBeGreaterThanOrEqual(dong[0].fetchedAt.getTime());
    await epTrungMocUuidNguoc("DT-1");
    expect(await trangThaiDauBang("DT-1")).toBe(4);
  });

  it("webhook ↔ trang API: trang API land sau (cùng updated_at) ⇒ số lớn hơn, đứng đầu kể cả khi trùng fetchedAt", async () => {
    const X = "2026-07-01T06:30:00.000000";
    const id = "585229755054269001";
    const chan = giuKhoaChoToiKhiNha();
    await choSoPhienChoKhoa(0);
    const webhook = xuLySuKienWebhook({ shopId: SHOP_TIKTOK, payload: JSON.stringify({ type: "orders", ...DON(id, 3, X) }) });
    await choSoPhienChoKhoa(1);
    const api = landTrangApi(SHOP_TIKTOK, trang(DON(id, 4, X)));
    await choSoPhienChoKhoa(2);
    chan.nha();
    await Promise.all([chan.xong, webhook, api]);

    const dong = await dongCuaDon(id);
    expect(dong.map((d) => (d.payload as { status: number }).status)).toEqual([3, 4]);
    await epTrungMocUuidNguoc(id);
    expect(await trangThaiDauBang(id)).toBe(4);
  });

  it("trang API ↔ webhook mới hơn: webhook land sau ⇒ số lớn hơn", async () => {
    const X = "2026-07-01T06:30:00.000000";
    const Y = "2026-07-01T07:30:00.000000";
    const id = "585229755054269002";
    const chan = giuKhoaChoToiKhiNha();
    await choSoPhienChoKhoa(0);
    const api = landTrangApi(SHOP_TIKTOK, trang(DON(id, 3, X)));
    await choSoPhienChoKhoa(1);
    const webhook = xuLySuKienWebhook({ shopId: SHOP_TIKTOK, payload: JSON.stringify({ type: "orders", ...DON(id, 4, Y) }) });
    await choSoPhienChoKhoa(2);
    chan.nha();
    await Promise.all([chan.xong, api, webhook]);

    const dong = await dongCuaDon(id);
    expect(dong.map((d) => (d.payload as { status: number }).status)).toEqual([3, 4]);
  });

  it("một INSERT nhiều phần tử ⇒ landSeq tăng theo thứ tự trong trang", async () => {
    const ids = ["P-5", "P-1", "P-4", "P-2", "P-3", "P-9", "P-0"];
    await landRaw("orders", SHOP_SHOPEE, trang(...ids.map((i) => DON(i, 3))));
    const dong = await prisma.rawPancakeOrder.findMany({ orderBy: { landSeq: "asc" }, select: { externalId: true } });
    expect(dong.map((d) => d.externalId)).toEqual(ids);
  });

  it("khe sequence do rollback và do trùng hash (ON CONFLICT) không làm sai thứ tự", async () => {
    await landRaw("orders", SHOP_SHOPEE, trang(DON("K-1", 3), DON("K-2", 3)));
    // Rollback: lượt land tiêu số rồi cuộn lại.
    await expect(
      prisma.$transaction(async (tx) => {
        await giuKhoaLandDon(tx);
        await landRaw("orders", SHOP_SHOPEE, trang(DON("K-1", 5)), undefined, tx);
        throw new Error("cuộn lại");
      }),
    ).rejects.toThrow("cuộn lại");
    // Trùng hash: K-1 bản 3 đã có ⇒ không chèn nhưng vẫn tiêu số; K-1 bản 4 chèn sau.
    await landRaw("orders", SHOP_SHOPEE, trang(DON("K-1", 3), DON("K-1", 4)));

    const dong = await dongCuaDon("K-1");
    expect(dong.map((d) => (d.payload as { status: number }).status)).toEqual([3, 4]);
    const k2 = await dongCuaDon("K-2");
    expect(dong[1].landSeq - k2[0].landSeq).toBeGreaterThan(BigInt(1)); // có khe
    await epTrungMocUuidNguoc("K-1");
    expect(await trangThaiDauBang("K-1")).toBe(4);
  });
});
