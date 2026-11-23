import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { landRaw } from "@/lib/bronze/land-raw";
import { transformFromRaw } from "@/lib/bronze/transform-from-raw";
import { mapPancakeOrder } from "@/lib/ingest/pancake-mapping";
import { pancakeOrderSchema } from "@/lib/ingest/pancake-schemas";
import { upsertOneOrder, type UpsertStats } from "@/lib/ingest/pancake-upsert";
import { prisma } from "@/lib/prisma";

import { tinhChecksumDon } from "../helpers/checksum-don-pancake";
import { SHOP_SHOPEE } from "../helpers/shop-ids-fixture";
import { seedReference, truncateBusinessTables } from "../helpers/test-db";

/**
 * CAS ghi Silver đơn Pancake theo CẶP mốc land (`rawFetchedAt`, `rawLandSeq`), SAU guard `updated_at`:
 *  - `CU_HON` chặn, `MOI_HON` ghi (bỏ mốc land) — ưu tiên `updated_at` giữ nguyên;
 *  - `BANG`/`KHONG_SO_DUOC`: ghi khi `rawFetchedAt` NULL / cũ hơn, hoặc bằng mà `rawLandSeq` NULL / ≤ số mới.
 * Mọi ca dùng dòng kho thô THẬT (land qua `landRaw`) rồi ép hai bản cùng `fetchedAt` — đúng ca trùng mili-giây.
 */

const X = "2026-07-01T06:30:00.000000";
const Y = "2026-07-01T07:30:00.000000";

const DON = (id: string, status: number, fee: number, updatedAt?: string) => ({
  id,
  system_id: id,
  status,
  inserted_at: "2026-07-01T03:00:00.000000",
  ...(updatedAt ? { updated_at: updatedAt } : {}),
  order_sources_name: "Shopee",
  marketplace_id: "-3",
  total_price: 200000,
  total_discount: 0,
  fee_marketplace: fee,
  items: [{ quantity: 2, discount_each_product: 0, variation_info: { display_id: "SKU-C1", name: "SP", retail_price: 100000 } }],
});

type Ban = { id: string; fetchedAt: Date; landSeq: bigint; payload: Record<string, unknown> };

/** Land hai bản (A trước, B sau) của đơn, ép cùng `fetchedAt`. Trả [A, B] đọc lại từ DB. */
async function haiBanCungMoc(id: string, a: Record<string, unknown>, b: Record<string, unknown>): Promise<[Ban, Ban]> {
  await landRaw("orders", SHOP_SHOPEE, JSON.stringify({ success: true, data: [a] }));
  await landRaw("orders", SHOP_SHOPEE, JSON.stringify({ success: true, data: [b] }));
  await prisma.$executeRaw`
    UPDATE "RawPancakeOrder" SET "fetchedAt" = (SELECT min("fetchedAt") FROM "RawPancakeOrder" WHERE "externalId" = ${id})
    WHERE "externalId" = ${id}`;
  const rows = await prisma.rawPancakeOrder.findMany({
    where: { externalId: id },
    orderBy: { landSeq: "asc" },
    select: { id: true, fetchedAt: true, landSeq: true, payload: true },
  });
  expect(rows).toHaveLength(2);
  expect(rows[0].fetchedAt.getTime()).toBe(rows[1].fetchedAt.getTime());
  return rows.map((r) => ({ ...r, payload: r.payload as Record<string, unknown> })) as [Ban, Ban];
}

const statsRong = (): UpsertStats =>
  ({
    ordersUpserted: 0,
    ordersSkippedMirror: 0,
    ordersSkippedStale: 0,
    ordersDiscardedGiuaChung: 0,
    skipped: 0,
    boQuaCoChuDich: 0,
    unknownStatusOrders: 0,
  }) as UpsertStats;

/** Ghi Silver từ MỘT bản kho thô, đúng như transform: mốc nguồn = cặp mốc land của dòng, đóng dấu lên dòng. */
const ghi = (b: Ban) =>
  upsertOneOrder(
    mapPancakeOrder(pancakeOrderSchema.parse(b.payload), { channels: {} }),
    b.payload,
    statsRong(),
    [],
    { fetchedAt: b.fetchedAt, landSeq: b.landSeq },
    { rawRowId: b.id },
  );

/**
 * Bỏ dấu kết cục của dòng — giả lập lượt dựng của dòng đó chạy MUỘN (trước khi bị đóng `SUPERSEDED`). Không có bước
 * này thì sổ kết cục (đúng như thiết kế) huỷ lượt ghi của bản đã bị đóng dấu trước khi CAS kịp nói gì.
 */
const moLaiKetCuc = (b: Ban) => prisma.rawPancakeOrder.update({ where: { id: b.id }, data: { silverOutcome: null } });
const docDon = (id: string) => prisma.order.findUniqueOrThrow({ where: { pancakeId: id } });
const ketCuc = async (b: Ban) => (await prisma.rawPancakeOrder.findUniqueOrThrow({ where: { id: b.id } })).silverOutcome;

beforeAll(async () => {
  await seedReference();
}, 60_000);

beforeEach(async () => {
  await truncateBusinessTables();
  await prisma.rawPancakeOrder.deleteMany();
});

// Dọn cả SAU file — không để dòng kho thô / Silver của file này sống sang file chạy sau.
afterAll(async () => {
  await truncateBusinessTables();
  await prisma.rawPancakeOrder.deleteMany();
});

describe("CAS ghi Silver đơn theo cặp mốc land", () => {
  it("ghi so le cùng mốc: B (số lớn) ghi trước, A tới muộn ⇒ A SUPERSEDED, Silver giữ B", async () => {
    const [a, b] = await haiBanCungMoc("CAS-1", DON("CAS-1", 3, 16000, X), DON("CAS-1", 4, 5839, X));
    expect(await ghi(b)).toBe("APPLIED");
    // Dấu bản dưới của B có thể chưa kịp đóng lên A (`FOR UPDATE SKIP LOCKED`, hoặc đường ghi không đóng dấu như
    // script bù đơn) — khi đó CHỈ CAS cặp mốc land chặn được A.
    await moLaiKetCuc(a);
    expect(await ghi(a)).toBe("SUPERSEDED");
    const o = await docDon("CAS-1");
    expect([o.status, o.platformFeeEst, o.rawLandSeq]).toEqual(["RETURNED", 5839, b.landSeq]);
    expect(await ketCuc(a)).toBe("SUPERSEDED");
  });

  it("thứ tự ngược: A ghi trước rồi B ⇒ B đè A", async () => {
    const [a, b] = await haiBanCungMoc("CAS-2", DON("CAS-2", 3, 16000, X), DON("CAS-2", 4, 5839, X));
    expect(await ghi(a)).toBe("APPLIED");
    expect(await ghi(b)).toBe("APPLIED");
    const o = await docDon("CAS-2");
    expect([o.status, o.platformFeeEst, o.rawLandSeq]).toEqual(["RETURNED", 5839, b.landSeq]);
  });

  it("ưu tiên updated_at: A mới hơn mà số nhỏ hơn ⇒ A thắng và ghi rawLandSeq của A; B cũ hơn bị chặn dù số lớn", async () => {
    const [a, b] = await haiBanCungMoc("CAS-3", DON("CAS-3", 4, 5839, Y), DON("CAS-3", 3, 16000, X));
    expect(a.landSeq < b.landSeq).toBe(true);
    expect(await ghi(b)).toBe("APPLIED");
    expect(await ghi(a)).toBe("APPLIED"); // MOI_HON — bỏ điều kiện mốc land
    let o = await docDon("CAS-3");
    expect([o.status, o.rawLandSeq]).toEqual(["RETURNED", a.landSeq]);
    // Lượt dựng muộn của B (dòng chưa đóng dấu) — guard `updated_at` trả CU_HON.
    await moLaiKetCuc(b);
    expect(await ghi(b)).toBe("SUPERSEDED"); // CU_HON
    o = await docDon("CAS-3");
    expect([o.status, o.platformFeeEst, o.rawLandSeq]).toEqual(["RETURNED", 5839, a.landSeq]);
  });

  it("chạy lại CÙNG phiên bản (song song + lặp) ⇒ luỹ đẳng, không ném, kết cục giữ APPLIED", async () => {
    const [, b] = await haiBanCungMoc("CAS-4", DON("CAS-4", 3, 16000, X), DON("CAS-4", 4, 5839, X));
    expect(await ghi(b)).toBe("APPLIED");
    expect(await Promise.all([ghi(b), ghi(b)])).toEqual(["APPLIED", "APPLIED"]);
    expect(await ghi(b)).toBe("APPLIED");
    expect(await ketCuc(b)).toBe("APPLIED");
    const o = await docDon("CAS-4");
    expect([o.status, o.rawLandSeq]).toEqual(["RETURNED", b.landSeq]);
  });

  it("rawLandSeq NULL (đơn có trước cột) ⇒ luật cũ nhận bản cùng mốc, rồi số được điền", async () => {
    const [a, b] = await haiBanCungMoc("CAS-5", DON("CAS-5", 3, 16000, X), DON("CAS-5", 4, 5839, X));
    expect(await ghi(b)).toBe("APPLIED");
    await prisma.order.update({ where: { pancakeId: "CAS-5" }, data: { rawLandSeq: null } });
    await moLaiKetCuc(a);
    expect(await ghi(a)).toBe("APPLIED");
    const o = await docDon("CAS-5");
    expect([o.status, o.rawLandSeq]).toEqual(["COMPLETED", a.landSeq]);
  });

  it("rawFetchedAt NULL ⇒ ghi", async () => {
    const [a, b] = await haiBanCungMoc("CAS-6", DON("CAS-6", 3, 16000, X), DON("CAS-6", 4, 5839, X));
    expect(await ghi(b)).toBe("APPLIED");
    await prisma.order.update({ where: { pancakeId: "CAS-6" }, data: { rawFetchedAt: null, rawLandSeq: null } });
    await moLaiKetCuc(a);
    expect(await ghi(a)).toBe("APPLIED");
    const o = await docDon("CAS-6");
    expect([o.status, o.rawFetchedAt?.getTime(), o.rawLandSeq]).toEqual(["COMPLETED", a.fetchedAt.getTime(), a.landSeq]);
  });

  it("dựng lại từ kho thô ⇒ đúng bản đứng đầu; C1–C3 bằng lượt dựng sạch, rawLandSeq = số bản đứng đầu", async () => {
    const [a, b] = await haiBanCungMoc("CAS-7", DON("CAS-7", 3, 16000, X), DON("CAS-7", 4, 5839, X));
    await transformFromRaw("orders", []);
    const sach = await tinhChecksumDon(prisma);
    expect((await docDon("CAS-7")).rawLandSeq).toBe(b.landSeq);

    // Làm lệch Silver: ép bản A vào qua nhánh luật cũ (rawLandSeq NULL) — rồi dựng lại cả bảng.
    await prisma.order.update({ where: { pancakeId: "CAS-7" }, data: { rawLandSeq: null } });
    await moLaiKetCuc(a);
    await ghi(a);
    expect((await docDon("CAS-7")).status).toBe("COMPLETED");
    await prisma.rawPancakeOrder.updateMany({ data: { silverOutcome: null, silverProcessedAt: null } });

    await transformFromRaw("orders", []);
    const sau = await tinhChecksumDon(prisma);
    expect([sau.c1, sau.c2, sau.c3, sau.banDau]).toEqual([sach.c1, sach.c2, sach.c3, sach.banDau]);
    const o = await docDon("CAS-7");
    expect([o.status, o.rawLandSeq]).toEqual(["RETURNED", b.landSeq]);
  });
});
