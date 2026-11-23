import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { demKhopMocLandDon } from "@/lib/bronze/dem-khop-moc-land-don";
import { landRaw } from "@/lib/bronze/land-raw";
import { transformFromRaw } from "@/lib/bronze/transform-from-raw";
import { prisma } from "@/lib/prisma";

import { SHOP_SHOPEE } from "../helpers/shop-ids-fixture";
import { seedReference, truncateBusinessTables } from "../helpers/test-db";

/**
 * Bước kiểm chỉ-đọc `demKhopMocLandDon` trên dữ liệu đi qua ĐƯỜNG THẬT (`landRaw` → `transformFromRaw`):
 *  - Payload có số nguyên > 2^53 + số thực nhiều chữ số: kho thô giữ nguyên byte, `Order.raw` (ghi từ payload đã qua
 *    `JSON.parse` của JS) bị LÀM TRÒN — dữ liệu đã lưu lệch THẬT, hành vi có sẵn trước landSeq. Phép kiểm KHÔNG được coi đó
 *    là "Silver giữ bản khác" (`lechNoiDung`) — chỉ đếm vào nền `khongDoiChieuDuoc`. Đối chứng: định nghĩa cũ (raw ≠
 *    payload của dòng cặp mốc trỏ tới) báo lệch giả.
 *  - Silver giữ nội dung một bản KHÁC trong khi cặp mốc trỏ bản đứng đầu ⇒ `lechNoiDung` = 1 (so `jsonb` nguyên vẹn).
 *  - Hai bản trùng mili-giây mà đơn trỏ đúng mốc đó ⇒ `ungVienMoHo` liệt kê đủ các dòng, không chọn bản; xem hết theo
 *    trang bằng con trỏ.
 *  - Ca reviewer dựng (số > 2^53 + hai bản trùng mốc, đường thật): Silver đúng bản ⇒ qua; Silver bị đổi sang bản sai
 *    (RETURNED → COMPLETED) ⇒ BỊ PHÁT HIỆN; Silver không khớp bản nào / hai bản khác nhau thành giống nhau sau chuyển đổi
 *    JS ⇒ KHÔNG ĐỦ CĂN CỨ (không xanh im lặng).
 */

const SO_LON = "9007199254740993"; // 2^53 + 1 — JS đọc thành 9007199254740992
const SO_THUC = "0.12345678901234567890123";
/** Trang API dạng TEXT THÔ (không qua JSON.stringify) — đúng cách n8n gửi. */
const trangTho = (id: string, status: number, them = "") =>
  `{"success":true,"data":[{"id":"${id}","system_id":"${id}","shop_id":${SHOP_SHOPEE},"status":${status},` +
  `"inserted_at":"2026-07-01T03:00:00.000000","order_sources_name":"Shopee","marketplace_id":"-3",` +
  `"total_price":200000,"total_discount":0,"fee_marketplace":3000${them},"items":[{"quantity":2,` +
  `"discount_each_product":0,"variation_info":{"display_id":"SKU-DK","name":"SP","retail_price":100000}}]}]}`;

/** Định nghĩa CŨ của lệch nội dung (raw ≠ payload dòng cặp mốc trỏ tới) — chỉ để đối chứng. */
const LECH_NOI_DUNG_CU = `
  SELECT count(*)::bigint AS n FROM "Order" o
  JOIN "RawPancakeOrder" r ON r."externalId" = o."pancakeId" AND r."shopId" = o.raw->>'shop_id'
   AND r."fetchedAt" = o."rawFetchedAt" AND r."landSeq" = o."rawLandSeq"
  WHERE (o.raw - '_buTuDonKho') <> r.payload`;

const donKhoTho = async () => {
  await truncateBusinessTables();
  await prisma.rawPancakeOrder.deleteMany();
};

beforeAll(async () => {
  await seedReference();
}, 60_000);
beforeEach(donKhoTho);
afterAll(donKhoTho);

describe("bước kiểm chỉ-đọc landSeq trên dữ liệu thật", () => {
  it("số > 2^53 qua land → transform: Order.raw bị JS làm tròn (lệch thật) nhưng KHÔNG báo lệch nội dung", async () => {
    await landRaw("orders", SHOP_SHOPEE, trangTho("SL-1", 3, `,"so_lon":${SO_LON},"so_thuc":${SO_THUC}`));
    await transformFromRaw("orders", [], { shopId: SHOP_SHOPEE, externalIds: ["SL-1"] });

    // (a) Dữ liệu đã lưu lệch THẬT: kho thô nguyên byte, Order.raw làm tròn; bỏ hai trường số thì phần còn lại bằng.
    const [r] = await prisma.$queryRaw<{ b: string; o: string; bt: string; ot: string; bang: boolean; bangTru: boolean }[]>`
      SELECT r.payload->>'so_lon' b, o.raw->>'so_lon' o, r.payload->>'so_thuc' bt, o.raw->>'so_thuc' ot,
             o.raw = r.payload AS bang, (o.raw - 'so_lon' - 'so_thuc') = (r.payload - 'so_lon' - 'so_thuc') AS "bangTru"
      FROM "Order" o JOIN "RawPancakeOrder" r ON r."externalId" = o."pancakeId" WHERE o."pancakeId" = 'SL-1'`;
    expect(r).toEqual({ b: SO_LON, o: "9007199254740992", bt: SO_THUC, ot: "0.12345678901234568", bang: false, bangTru: true });

    // (b) Định nghĩa cũ của phép kiểm báo lệch GIẢ; định nghĩa mới không.
    const [{ n }] = await prisma.$queryRawUnsafe<{ n: bigint }[]>(LECH_NOI_DUNG_CU);
    expect(Number(n)).toBe(1);
    expect(await demKhopMocLandDon(prisma)).toMatchObject({
      tongDon: 1, khop: 1, moHo: 0, khongDoiChieuDuoc: 1, giaiThichDuoc: 1, lechBanKhac: 0, khongDuCanCu: 0,
      daDien: 1, lechCap: 0, lechNoiDung: 0,
    });
  });

  it("Silver giữ nội dung bản KHÁC trong khi cặp mốc trỏ bản đứng đầu ⇒ lechNoiDung = 1", async () => {
    await landRaw("orders", SHOP_SHOPEE, trangTho("SL-2", 3));
    await landRaw("orders", SHOP_SHOPEE, trangTho("SL-2", 4));
    await transformFromRaw("orders", [], { shopId: SHOP_SHOPEE, externalIds: ["SL-2"] });
    expect(await demKhopMocLandDon(prisma)).toMatchObject({ lechCap: 0, lechNoiDung: 0, khongDoiChieuDuoc: 0 });
    // Giả lập ảnh cũ dựng lại tay chọn bản kia: nội dung bản land trước, cặp mốc vẫn của bản đứng đầu.
    await prisma.$executeRaw`
      UPDATE "Order" SET raw = (SELECT payload FROM "RawPancakeOrder" WHERE "externalId" = 'SL-2' ORDER BY "landSeq" LIMIT 1)
      WHERE "pancakeId" = 'SL-2'`;
    expect(await demKhopMocLandDon(prisma)).toMatchObject({ lechCap: 0, lechNoiDung: 1, khongDoiChieuDuoc: 0 });
  });

  /** Hai bản (status 3 rồi 4) cùng số > 2^53, land qua đường thật, ép trùng mili-giây, dựng Silver ⇒ Silver = bản land sau. */
  async function haiBanSoLonTrungMoc(id: string, soLonA = SO_LON, soLonB = SO_LON, statusB = 4) {
    await landRaw("orders", SHOP_SHOPEE, trangTho(id, 3, `,"so_lon":${soLonA}`));
    await landRaw("orders", SHOP_SHOPEE, trangTho(id, statusB, `,"so_lon":${soLonB}`));
    await prisma.$executeRaw`
      UPDATE "RawPancakeOrder" SET "fetchedAt" = (SELECT min("fetchedAt") FROM "RawPancakeOrder" WHERE "externalId" = ${id})
      WHERE "externalId" = ${id}`;
    await transformFromRaw("orders", [], { shopId: SHOP_SHOPEE, externalIds: [id] });
  }

  /** Ghi `Order.raw` (+ status) bằng Prisma — đúng như một lượt ghi Silver từ payload đã qua JS. */
  async function ghiSilverTuBan(id: string, banThu: number, status: "COMPLETED" | "RETURNED") {
    const [d] = await prisma.$queryRaw<{ payload: object }[]>`
      SELECT payload FROM "RawPancakeOrder" WHERE "externalId" = ${id} ORDER BY "landSeq" OFFSET ${banThu} LIMIT 1`;
    await prisma.order.update({ where: { pancakeId: id }, data: { raw: d.payload, status } });
  }

  it("số > 2^53 + hai bản trùng mốc: (a) Silver ĐÚNG bản ⇒ qua", async () => {
    await haiBanSoLonTrungMoc("SL-A");
    const o = await prisma.order.findUniqueOrThrow({ where: { pancakeId: "SL-A" } });
    expect(o.status).toBe("RETURNED");
    expect(await demKhopMocLandDon(prisma)).toMatchObject({
      khongDoiChieuDuoc: 1, giaiThichDuoc: 1, lechBanKhac: 0, khongDuCanCu: 0, lechCap: 0, lechNoiDung: 0,
    });
  });

  it("số > 2^53 + hai bản trùng mốc: (b) Silver bị đổi RETURNED → COMPLETED (bản sai) ⇒ BỊ PHÁT HIỆN", async () => {
    await haiBanSoLonTrungMoc("SL-B");
    await ghiSilverTuBan("SL-B", 0, "COMPLETED");
    expect(await demKhopMocLandDon(prisma)).toMatchObject({
      khongDoiChieuDuoc: 1, giaiThichDuoc: 0, lechBanKhac: 1, khongDuCanCu: 0, lechCap: 0, lechNoiDung: 1,
    });
  });

  it("số > 2^53 + hai bản trùng mốc: (c) Silver không khớp bản nào ⇒ KHÔNG ĐỦ CĂN CỨ", async () => {
    await haiBanSoLonTrungMoc("SL-C");
    await prisma.$executeRaw`UPDATE "Order" SET raw = raw || '{"fee_marketplace": 1}'::jsonb WHERE "pancakeId" = 'SL-C'`;
    expect(await demKhopMocLandDon(prisma)).toMatchObject({
      giaiThichDuoc: 0, lechBanKhac: 0, khongDuCanCu: 1, lechCap: 0, lechNoiDung: 0,
      donKhongDuCanCu: [{ pancakeId: "SL-C", lyDo: "khong-khop-ban-nao" }],
    });
  });

  it("(d) hai bản KHÁC nhau chỉ ở chữ số đã mất qua JS ⇒ giống nhau sau chuyển đổi ⇒ KHÔNG ĐỦ CĂN CỨ", async () => {
    // 9007199254740992 và 9007199254740993 khác nhau trong kho thô, cùng thành 9007199254740992 qua JS; cùng status.
    await haiBanSoLonTrungMoc("SL-D", "9007199254740992", SO_LON, 3);
    expect(await prisma.rawPancakeOrder.count({ where: { externalId: "SL-D" } })).toBe(2);
    expect(await demKhopMocLandDon(prisma)).toMatchObject({
      giaiThichDuoc: 0, lechBanKhac: 0, khongDuCanCu: 1,
      donKhongDuCanCu: [{ pancakeId: "SL-D", lyDo: "va-cham-2-ban-sau-chuyen-doi-js" }],
    });
  });

  it("ứng viên mơ hồ xem HẾT theo trang: khoá sắp xếp xác định, không trùng không sót", async () => {
    for (const id of ["PG-3", "PG-1", "PG-2"]) {
      await landRaw("orders", SHOP_SHOPEE, trangTho(id, 3));
      await landRaw("orders", SHOP_SHOPEE, trangTho(id, 4));
      await prisma.$executeRaw`
        UPDATE "RawPancakeOrder" SET "fetchedAt" = (SELECT min("fetchedAt") FROM "RawPancakeOrder" WHERE "externalId" = ${id})
        WHERE "externalId" = ${id}`;
      await transformFromRaw("orders", [], { shopId: SHOP_SHOPEE, externalIds: [id] });
    }
    const trang1 = await demKhopMocLandDon(prisma, { gioiHan: 2 });
    expect(trang1.moHo).toBe(3);
    expect(trang1.ungVienMoHo.map((u) => u.pancakeId)).toEqual(["PG-1", "PG-2"]);
    expect(trang1.ungVienTrangSau).toBe("PG-2");
    const trang2 = await demKhopMocLandDon(prisma, { gioiHan: 2, sauDon: trang1.ungVienTrangSau! });
    expect(trang2.ungVienMoHo.map((u) => u.pancakeId)).toEqual(["PG-3"]);
    expect(trang2.ungVienTrangSau).toBeNull();
    for (const u of [...trang1.ungVienMoHo, ...trang2.ungVienMoHo]) expect(u.dong).toHaveLength(2);
  });

  it("hai bản trùng mili-giây mà đơn trỏ đúng mốc đó ⇒ ứng viên mơ hồ liệt kê đủ dòng, không chọn bản", async () => {
    await landRaw("orders", SHOP_SHOPEE, trangTho("SL-3", 3));
    await landRaw("orders", SHOP_SHOPEE, trangTho("SL-3", 4));
    await prisma.$executeRaw`
      UPDATE "RawPancakeOrder" SET "fetchedAt" = (SELECT min("fetchedAt") FROM "RawPancakeOrder" WHERE "externalId" = 'SL-3')
      WHERE "externalId" = 'SL-3'`;
    await transformFromRaw("orders", [], { shopId: SHOP_SHOPEE, externalIds: ["SL-3"] });
    const dem = await demKhopMocLandDon(prisma);
    expect(dem.moHo).toBe(1);
    const ids = (await prisma.rawPancakeOrder.findMany({ where: { externalId: "SL-3" }, select: { id: true } }))
      .map((d) => d.id)
      .sort();
    expect(dem.ungVienMoHo.map((u) => [u.pancakeId, u.dong.map((d) => d.id).sort()])).toEqual([["SL-3", ids]]);
    expect(dem.ungVienMoHo[0].dong.map((d) => d.status).sort()).toEqual(["3", "4"]);
  });
});
