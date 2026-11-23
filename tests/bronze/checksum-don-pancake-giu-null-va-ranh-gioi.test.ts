import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { prisma } from "@/lib/prisma";

import { tinhChecksumDon } from "../helpers/checksum-don-pancake";
import { seedReference, truncateBusinessTables } from "../helpers/test-db";

/**
 * Checksum dữ liệu đơn (`tests/helpers/checksum-don-pancake.ts`) phải phân biệt hai bộ khác nhau mà `concat_ws` (bản
 * cũ) coi là BẰNG: NULL đổi chỗ giữa hai cột liền kề, và dấu phẩy nằm trong giá trị. Ca thật trên `Order`:
 * `statusChangedAt` (timestamp) đứng ngay trước `customerName` (text) — (NULL, "<mốc>") và ("<mốc>", NULL) cho cùng
 * chuỗi `concat_ws`.
 */

/** C1 bản CŨ (concat_ws) — chỉ để đối chứng. */
const C1_CONCAT_WS = `
  SELECT md5(coalesce(string_agg(x, '|' ORDER BY x), '')) AS v FROM (
    SELECT concat_ws(',', "pancakeId", code, "channelId", status, "orderedAt", "statusChangedAt", "customerName",
           "itemsTotal", "shipFeeCustomer", discount, "platformFeeEst", "returnedFee", "paidAtShop",
           "backfilledFromMirror") x FROM "Order") t`;

const c1Cu = async () => (await prisma.$queryRawUnsafe<{ v: string }[]>(C1_CONCAT_WS))[0].v;

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

describe("checksum đơn giữ vị trí NULL và ranh giới trường", () => {
  it("NULL đổi chỗ giữa statusChangedAt và customerName: concat_ws coi BẰNG, row()::text phân biệt", async () => {
    const moc = new Date("2026-07-01T03:00:00.000Z");
    const [{ chu }] = await prisma.$queryRaw<{ chu: string }[]>`SELECT ${moc}::timestamp::text AS chu`;
    await prisma.order.create({
      data: {
        pancakeId: "CK-1", code: "CK-1", channelId: "shopee", status: "COMPLETED", orderedAt: moc, syncedAt: moc,
        statusChangedAt: null, customerName: chu,
      },
    });
    const cuA = await c1Cu();
    const moiA = (await tinhChecksumDon(prisma)).c1;
    await prisma.order.update({ where: { pancakeId: "CK-1" }, data: { statusChangedAt: moc, customerName: null } });
    const cuB = await c1Cu();
    const moiB = (await tinhChecksumDon(prisma)).c1;
    expect(cuA).toBe(cuB); // bản cũ MÙ
    expect(moiA).not.toBe(moiB);
  });

  it("dấu phẩy trong giá trị và chuỗi rỗng vs NULL", async () => {
    const [r] = await prisma.$queryRaw<{ cuPhay: boolean; moiPhay: boolean; cuRong: boolean; moiRong: boolean }[]>`
      SELECT concat_ws(',', 'a,b', 'c') = concat_ws(',', 'a', 'b,c') AS "cuPhay",
             row('a,b', 'c')::text = row('a', 'b,c')::text AS "moiPhay",
             concat_ws(',', 'a', '', 'b') = concat_ws(',', 'a', NULL, 'b') AS "cuRong",
             row('a', ''::text, 'b')::text = row('a', NULL::text, 'b')::text AS "moiRong"`;
    expect(r).toEqual({ cuPhay: true, moiPhay: false, cuRong: false, moiRong: false });
  });
});
