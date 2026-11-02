import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { landRaw } from "@/lib/bronze/land-raw";
import { latestPayloads } from "@/lib/bronze/transform-raw-helpers";
import { prisma } from "@/lib/prisma";

import { SHOP_KHO, SHOP_SHOPEE } from "../helpers/shop-ids-fixture";

/**
 * Lần thấy lại một nội dung CŨ (A → B → A) ở `landRaw` — bảng không có mốc nội dung trong payload.
 *
 * Bronze khử trùng theo (khoá, hash): lần A thứ hai không chèn dòng nào (`landed 0`, `landedIds` rỗng — hợp đồng
 * giữ nguyên), nên trước đây bản đứng đầu theo `fetchedAt` vẫn là B mãi mãi dù nguồn đã quay về A. Nay `landRaw` ghi
 * `lanThayCuoi` cho dòng A (KHÔNG chạm payload/hash/fetchedAt) và trả khoá đó trong `reseenIds` để người gọi dựng lại.
 */

const body = (items: string) => `{"success":true,"data":[${items}]}`;
const sp = (id: string, gia: number) => `{"id":"${id}","name":"Váy","gia":${gia}}`;

async function dongCua(externalId: string) {
  return prisma.rawPancakeProduct.findMany({ where: { externalId }, orderBy: { fetchedAt: "asc" } });
}

beforeEach(async () => {
  await prisma.rawPancakeProduct.deleteMany();
  await prisma.rawPancakeOrder.deleteMany();
});
afterAll(async () => {
  await prisma.rawPancakeProduct.deleteMany();
  await prisma.rawPancakeOrder.deleteMany();
  await prisma.$disconnect();
});

describe("landRaw — lần thấy lại nội dung cũ (bảng có cột lần thấy)", () => {
  it("A100 → B200 → A100: không chèn dòng, A thành bản đứng đầu, reseenIds = khoá đó", async () => {
    const a1 = await landRaw("products", SHOP_KHO, body(sp("P-1", 100)));
    const b = await landRaw("products", SHOP_KHO, body(sp("P-1", 200)));
    const a2 = await landRaw("products", SHOP_KHO, body(sp("P-1", 100)));

    expect(a1).toMatchObject({ landed: 1, landedIds: ["P-1"], reseenIds: [] });
    expect(b).toMatchObject({ landed: 1, landedIds: ["P-1"], reseenIds: [] });
    // Hợp đồng `landedIds` giữ nguyên: lần A thứ hai KHÔNG chèn gì.
    expect(a2).toMatchObject({ landed: 0, landedIds: [], seenIds: ["P-1"], reseenIds: ["P-1"] });

    const rows = await dongCua("P-1");
    expect(rows).toHaveLength(2);
    const [dongA, dongB] = rows;
    expect(dongA.lanThayCuoi).not.toBeNull();
    expect(dongA.lanThayCuoi!.getTime()).toBeGreaterThan(dongB.fetchedAt.getTime());
    expect(dongB.lanThayCuoi).toBeNull();

    const [dau] = await latestPayloads("RawPancakeProduct", { shopId: SHOP_KHO, externalIds: ["P-1"] });
    expect((dau.payload as { gia: number }).gia).toBe(100);
    expect(dau.mocPhienBan.getTime()).toBe(dongA.lanThayCuoi!.getTime());
  });

  it("thấy lại lần nữa khi A ĐANG đứng đầu ⇒ không ghi gì (reseenIds rỗng, lanThayCuoi giữ nguyên)", async () => {
    await landRaw("products", SHOP_KHO, body(sp("P-1", 100)));
    await landRaw("products", SHOP_KHO, body(sp("P-1", 200)));
    await landRaw("products", SHOP_KHO, body(sp("P-1", 100)));
    const truoc = (await dongCua("P-1"))[0].lanThayCuoi;

    const lan4 = await landRaw("products", SHOP_KHO, body(sp("P-1", 100)));
    expect(lan4).toMatchObject({ landed: 0, landedIds: [], reseenIds: [] });
    expect((await dongCua("P-1"))[0].lanThayCuoi).toEqual(truoc);
  });

  it("A100 → A100 idempotent: landed 0, landedIds rỗng, reseenIds rỗng, payload/hash/fetchedAt bất biến", async () => {
    await landRaw("products", SHOP_KHO, body(sp("P-1", 100)));
    const truoc = await dongCua("P-1");
    const r = await landRaw("products", SHOP_KHO, body(sp("P-1", 100)));

    expect(r).toMatchObject({ landed: 0, landedIds: [], reseenIds: [] });
    const sau = await dongCua("P-1");
    expect(sau).toHaveLength(1);
    expect(sau[0]).toMatchObject({
      id: truoc[0].id,
      payloadHash: truoc[0].payloadHash,
      fetchedAt: truoc[0].fetchedAt,
      lanThayCuoi: null,
    });
  });

  it("trang có 2 phần tử GIỐNG HỆT (kể cả khi đang là bản cũ) ⇒ không lỗi cardinality, ghi một lần", async () => {
    await landRaw("products", SHOP_KHO, body(sp("P-1", 100)));
    await landRaw("products", SHOP_KHO, body(sp("P-1", 200)));

    const r = await landRaw("products", SHOP_KHO, body(`${sp("P-1", 100)},${sp("P-1", 100)}`));
    expect(r).toMatchObject({ landed: 0, reseenIds: ["P-1"] });
    expect(await dongCua("P-1")).toHaveLength(2);

    // Trang đầu tiên đã trùng phần tử: chèn một dòng, không ném.
    const moi = await landRaw("products", SHOP_KHO, body(`${sp("P-2", 5)},${sp("P-2", 5)}`));
    expect(moi).toMatchObject({ landed: 1, landedIds: ["P-2"], reseenIds: [] });
  });

  it("trang mang CẢ bản cũ lẫn bản mới cùng khoá ⇒ bản mới chèn đứng đầu, không ghi lần thấy cho bản cũ", async () => {
    await landRaw("products", SHOP_KHO, body(sp("P-1", 100)));
    await landRaw("products", SHOP_KHO, body(sp("P-1", 200)));

    const r = await landRaw("products", SHOP_KHO, body(`${sp("P-1", 100)},${sp("P-1", 300)}`));
    expect(r).toMatchObject({ landed: 1, landedIds: ["P-1"], reseenIds: [] });
    const [dau] = await latestPayloads("RawPancakeProduct", { shopId: SHOP_KHO, externalIds: ["P-1"] });
    expect((dau.payload as { gia: number }).gia).toBe(300);
  });

  it("trang mang ≥ 2 phiên bản ĐÃ CÓ của cùng khoá ⇒ chỉ phần tử đứng SAU CÙNG trong trang được ghi, đầu bảng ổn định", async () => {
    await landRaw("products", SHOP_KHO, body(sp("P-1", 100))); // A
    await landRaw("products", SHOP_KHO, body(sp("P-1", 200))); // B
    await landRaw("products", SHOP_KHO, body(sp("P-1", 300))); // C — đang đứng đầu
    const gia = async () =>
      ((await latestPayloads("RawPancakeProduct", { shopId: SHOP_KHO, externalIds: ["P-1"] }))[0].payload as {
        gia: number;
      }).gia;
    const lanThay = async (g: number) =>
      (await dongCua("P-1")).find((d) => (d.payload as { gia: number }).gia === g)?.lanThayCuoi ?? null;

    const r1 = await landRaw("products", SHOP_KHO, body(`${sp("P-1", 100)},${sp("P-1", 200)}`));
    expect(r1).toMatchObject({ landed: 0, reseenIds: ["P-1"] });
    expect(await gia()).toBe(200); // phần tử cuối trang
    expect(await lanThay(100)).toBeNull(); // A không được ghi — nếu ghi cả hai, bản đầu là may rủi

    // Gửi lại y trang đó: B đã đứng đầu ⇒ không ghi gì, đầu bảng KHÔNG lật về A.
    const truoc = await lanThay(200);
    const r2 = await landRaw("products", SHOP_KHO, body(`${sp("P-1", 100)},${sp("P-1", 200)}`));
    expect(r2.reseenIds).toEqual([]);
    expect(await gia()).toBe(200);
    expect(await lanThay(200)).toEqual(truoc);
    expect(await lanThay(100)).toBeNull();

    // Đảo thứ tự phần tử ⇒ phần tử cuối (A) thắng.
    await landRaw("products", SHOP_KHO, body(`${sp("P-1", 200)},${sp("P-1", 100)}`));
    expect(await gia()).toBe(100);
  });

  it("khoá của shop KHÁC trùng externalId không bị ghi lần thấy", async () => {
    await landRaw("products", SHOP_KHO, body(sp("P-1", 100)));
    await landRaw("products", SHOP_KHO, body(sp("P-1", 200)));
    await landRaw("products", SHOP_SHOPEE, body(sp("P-1", 100)));
    const r = await landRaw("products", SHOP_SHOPEE, body(sp("P-1", 100)));

    expect(r.reseenIds).toEqual([]);
    const kho = await prisma.rawPancakeProduct.findMany({ where: { shopId: SHOP_KHO } });
    expect(kho.every((d) => d.lanThayCuoi === null)).toBe(true);
  });
});

describe("landRaw — bảng NGOÀI danh sách lần thấy giữ hành vi cũ", () => {
  it("đơn Pancake A → B → A: reseenIds luôn rỗng (đơn có thứ tự riêng theo updated_at)", async () => {
    const don = (st: number) => body(`{"id":"ORD-1","status":${st}}`);
    await landRaw("orders", SHOP_SHOPEE, don(1));
    await landRaw("orders", SHOP_SHOPEE, don(2));
    const r = await landRaw("orders", SHOP_SHOPEE, don(1));
    expect(r).toMatchObject({ landed: 0, landedIds: [], reseenIds: [] });
  });
});
