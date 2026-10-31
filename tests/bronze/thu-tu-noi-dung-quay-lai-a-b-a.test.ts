import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

// INGEST_SECRET phải set TRƯỚC khi import route (requireIngestSecret đọc process.env lúc chạy).
const SECRET = "test-ingest-secret";
process.env.INGEST_SECRET = SECRET;

import { POST } from "@/app/api/ingest/raw/route";
import { hasBronzeBacklog } from "@/lib/bronze/bronze-only";
import { landRaw } from "@/lib/bronze/land-raw";
import { rebuildFromRaw } from "@/lib/bronze/rebuild";
import { transformFromRaw } from "@/lib/bronze/transform-from-raw";
import { docDeXuatGiaVon } from "@/lib/gia-von/doc-de-xuat-gia-von";
import { KEY_NO_PHAI_TRA_TU_NGAY } from "@/lib/no-phai-tra/cong-bat-no-phai-tra";
import { prisma } from "@/lib/prisma";
import { quangCaoTheoChienDich } from "@/lib/reports/marketing/quang-cao-chien-dich";

import { SHOP_KHO } from "../helpers/shop-ids-fixture";
import { seedReference, truncateBusinessTables } from "../helpers/test-db";

/**
 * Nguồn trả LẠI đúng nội dung cũ (A100 → B200 → A100) ở 3 stream không có mốc nội dung trong payload: sản phẩm
 * Pancake (shop kho), báo cáo ads Meta, báo cáo ads TikTok Business. Bronze khử trùng theo hash nên lần A thứ hai
 * không chèn dòng; trước bản vá bản đứng đầu theo `fetchedAt` kẹt ở B mãi ⇒ Silver/màn đọc ra 200 trong khi nguồn nói
 * 100. Soi CẢ head lẫn nơi tiêu thụ: Silver sản phẩm + đề xuất giá vốn (đường ingest thường ngày + quét cả bảng); ads
 * chỉ dựng `Expense` ở lượt dựng lại nên soi lượt dựng lại + màn /marketing.
 */

const post = (stream: string, shopId: string, payload: string) =>
  POST(
    new Request("http://localhost/api/ingest/raw", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${SECRET}` },
      body: JSON.stringify({ stream, shopId, payload }),
    }),
  );

const SP_ID = "a9c1e2f0-0000-4000-8000-00000000a0b1";
const BT_ID = "a9c1e2f0-0000-4000-8000-00000000b0b1";
/** Sản phẩm shop kho: giá bán + giá vốn bình quân đi theo "phiên bản" (A = 100k, B = 200k). */
const sanPham = (nghin: number) =>
  `{"success":true,"data":[{"id":"${SP_ID}","name":"Váy hè","variations":[{"id":"${BT_ID}",` +
  `"display_id":"SKU-ABA","retail_price":${nghin * 1000 + 50_000},"remain_quantity":5,` +
  `"average_imported_price":${nghin * 1000}}]}]}`;

const ACT = "act_415299582336742";
const NGAY = "2026-05-20";
const KY = { from: new Date("2026-05-01T00:00:00+07:00"), to: new Date("2026-05-31T00:00:00+07:00") };
/** Dòng insights Meta — chi tiêu + lượt hiển thị đi theo phiên bản. */
const meta = (nghin: number) =>
  `{"data":[{"spend":"${nghin * 1000}","campaign_id":"M1","campaign_name":"Váy hè","account_currency":"VND",` +
  `"date_start":"${NGAY}","date_stop":"${NGAY}","impressions":"${nghin * 10}","clicks":"${nghin}"}],` +
  `"paging":{"cursors":{"after":"x"}}}`;

const ADV = "7090000000000000001";
/** Dòng GMV Max TikTok Business — chi tiêu + số đơn sàn đi theo phiên bản. */
const tiktok = (nghin: number, don: number) =>
  `{"code":0,"message":"OK","data":{"list":[{"metrics":{"cost":"${nghin * 1000}","orders":"${don}",` +
  `"campaign_name":"GMV toàn shop"},"dimensions":{"campaign_id":"G1","stat_time_day":"${NGAY} 00:00:00"}}],` +
  `"page_info":{"total_page":1}}}`;

const dungLaiAds = (stream: "meta/report" | "tiktokbusiness/report") =>
  transformFromRaw(stream, [], { rebuild: true, mocNoPhaiTra: null });

async function cleanup(): Promise<void> {
  await truncateBusinessTables();
  await prisma.rawPancakeProduct.deleteMany();
  await prisma.rawMetaAdsReport.deleteMany();
  await prisma.rawTiktokBusinessReport.deleteMany();
  await prisma.rawTiktokBusinessInvoice.deleteMany();
  // Mốc Nợ phải trả sót từ suite khác sẽ cắt chi phí ads ngày cũ khỏi lượt dựng lại — test này không soi luật đó.
  await prisma.setting.deleteMany({ where: { key: { in: ["bronzeBacklogPending", KEY_NO_PHAI_TRA_TU_NGAY] } } });
}

beforeAll(async () => {
  await seedReference();
}, 60_000);
beforeEach(cleanup);
afterAll(async () => {
  await cleanup();
  await prisma.$disconnect();
});

describe("A100 → B200 → A100 — sản phẩm shop kho", () => {
  it("đường ingest thường ngày dựng lại đúng khoá thấy lại ⇒ Silver + đề xuất giá vốn theo A", async () => {
    expect((await post("products", SHOP_KHO, sanPham(100))).status).toBe(200);
    // Chủ shop sửa tay giá vốn (APP-OWNED) để đề xuất "theo Pancake" có gì để so.
    await prisma.variant.update({ where: { pancakeId: BT_ID }, data: { costPrice: 50_000 } });
    expect((await post("products", SHOP_KHO, sanPham(200))).status).toBe(200);
    expect((await prisma.variant.findUniqueOrThrow({ where: { pancakeId: BT_ID } })).sellPrice).toBe(250_000);

    const res = await post("products", SHOP_KHO, sanPham(100));
    const json = await res.json();
    // Hợp đồng land: không chèn dòng mới; nhưng khoá thấy lại vẫn được dựng (và được hạch toán — không backlog oan).
    expect(json.stats).toMatchObject({ landed: 0, productsUpserted: 1, skipped: 0 });
    expect(await hasBronzeBacklog()).toBe(false);

    const bt = await prisma.variant.findUniqueOrThrow({ where: { pancakeId: BT_ID } });
    expect(bt.sellPrice).toBe(150_000);
    expect(bt.costPrice).toBe(50_000); // APP-OWNED không bị chạm

    const { deXuat } = await docDeXuatGiaVon("theo-pancake");
    expect(deXuat.map((d) => d.giaDeXuat)).toEqual([100_000]);
  });

  it("quét cả bảng (đường dựng lại) cũng chọn A", async () => {
    await post("products", SHOP_KHO, sanPham(100));
    await post("products", SHOP_KHO, sanPham(200));
    await landRaw("products", SHOP_KHO, sanPham(100)); // chỉ land, không qua route ⇒ Silver còn ở B
    expect((await prisma.variant.findUniqueOrThrow({ where: { pancakeId: BT_ID } })).sellPrice).toBe(250_000);

    await transformFromRaw("products", []);
    expect((await prisma.variant.findUniqueOrThrow({ where: { pancakeId: BT_ID } })).sellPrice).toBe(150_000);
  });

  it("A100 → A100 idempotent: không chèn, không dựng lại thừa", async () => {
    await post("products", SHOP_KHO, sanPham(100));
    const json = await (await post("products", SHOP_KHO, sanPham(100))).json();
    expect(json.stats).toMatchObject({ landed: 0, productsUpserted: 0, skipped: 0 });
    expect(await prisma.rawPancakeProduct.count()).toBe(1);
    expect(await hasBronzeBacklog()).toBe(false);
  });
});

describe("A100 → B200 → A100 — báo cáo ads Meta", () => {
  it("lượt dựng lại Expense + màn /marketing đọc A", async () => {
    await landRaw("meta/report", ACT, meta(100));
    await dungLaiAds("meta/report");
    const soA = (await prisma.expense.findUniqueOrThrow({ where: { refId: `META:${NGAY}:M1` } })).amount;

    await landRaw("meta/report", ACT, meta(200));
    const lanA2 = await landRaw("meta/report", ACT, meta(100));
    expect(lanA2).toMatchObject({ landed: 0, landedIds: [], reseenIds: [`M1:${NGAY}`] });

    await dungLaiAds("meta/report");
    expect((await prisma.expense.findUniqueOrThrow({ where: { refId: `META:${NGAY}:M1` } })).amount).toBe(soA);

    const r = await quangCaoTheoChienDich(KY);
    const c = r.chienDich.find((x) => x.nguon === "META");
    expect(c?.hienThi).toBe(1_000);
    expect(c?.click).toBe(100);
  });
});

describe("lượt dựng lại toàn bộ (rebuildFromRaw) sau A → B → A", () => {
  it("chọn A ở cả 3 stream, chạy hai lần liên tiếp cùng kết quả", async () => {
    await post("products", SHOP_KHO, sanPham(100));
    await post("products", SHOP_KHO, sanPham(200));
    await landRaw("products", SHOP_KHO, sanPham(100));
    await landRaw("meta/report", ACT, meta(100));
    await landRaw("meta/report", ACT, meta(200));
    await landRaw("meta/report", ACT, meta(100));
    await landRaw("tiktokbusiness/report", ADV, tiktok(100, 1));
    await landRaw("tiktokbusiness/report", ADV, tiktok(200, 2));
    await landRaw("tiktokbusiness/report", ADV, tiktok(100, 1));

    const chup = async () => ({
      bienThe: await prisma.variant.findMany({
        select: { pancakeId: true, sellPrice: true, stock: true, costPrice: true },
        orderBy: { pancakeId: "asc" },
      }),
      chiPhi: await prisma.expense.findMany({
        select: { refId: true, amount: true, date: true, source: true },
        orderBy: { refId: "asc" },
      }),
    });

    await rebuildFromRaw([]);
    const lan1 = await chup();
    await rebuildFromRaw([]);
    const lan2 = await chup();

    expect(lan2).toEqual(lan1);
    expect(lan1.bienThe.map((b) => b.sellPrice)).toEqual([150_000]);
    const meta1 = lan1.chiPhi.find((c) => c.refId === `META:${NGAY}:M1`);
    expect(meta1?.amount).toBe(110_000); // 100.000 chưa VAT × 1,1 — bản A, không phải 220.000 của B
  });
});

describe("A100 → B200 → A100 — báo cáo ads TikTok Business (GMV Max)", () => {
  it("lượt dựng lại Expense + số đơn sàn trên /marketing đọc A", async () => {
    await landRaw("tiktokbusiness/report", ADV, tiktok(100, 1));
    await dungLaiAds("tiktokbusiness/report");
    const soA = (await prisma.expense.findUniqueOrThrow({ where: { refId: `TIKTOK_ADS:${NGAY}:G1` } })).amount;

    await landRaw("tiktokbusiness/report", ADV, tiktok(200, 2));
    const lanA2 = await landRaw("tiktokbusiness/report", ADV, tiktok(100, 1));
    expect(lanA2).toMatchObject({ landed: 0, landedIds: [], reseenIds: [`G1:${NGAY}`] });

    await dungLaiAds("tiktokbusiness/report");
    expect((await prisma.expense.findUniqueOrThrow({ where: { refId: `TIKTOK_ADS:${NGAY}:G1` } })).amount).toBe(soA);

    const r = await quangCaoTheoChienDich(KY);
    const c = r.chienDich.find((x) => x.nguon === "TIKTOK_ADS");
    expect(c?.donSan).toBe(1);
  });
});
