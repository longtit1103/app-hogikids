import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";

// INGEST_SECRET phải set TRƯỚC khi import route (requireIngestSecret đọc process.env lúc chạy).
const SECRET = "test-ingest-secret";
process.env.INGEST_SECRET = SECRET;

import { POST } from "@/app/api/ingest/raw/route";
import { hasBronzeBacklog } from "@/lib/bronze/bronze-only";
import { landRaw } from "@/lib/bronze/land-raw";
import { transformFromRaw } from "@/lib/bronze/transform-from-raw";
import { bocAnhChupChiPhiTiktok } from "@/lib/ingest/tiktok-ads-tin-dung-mapping";
import { prisma } from "@/lib/prisma";

/**
 * Integration Bronze ảnh chụp chi phí TikTok (`tiktokbusiness/cost`) → Silver `TiktokAdsTinDung` (`hogikids_test`).
 * Kiểm: land ẢNH CHỤP NGÀY qua cơ chế `ngay` (khoá = bc_id + ngày), advertiser_id int64 dạng SỐ JSON vẫn lossless,
 * tiền SỐ ÂM của API (đo thật 24/10) ⇒ Silver dương, CỘNG nhiều dòng cùng advertiser, ảnh chụp NHIỀU TRANG, VAT tháng
 * đo từ hoá đơn (mặc định 10%), idempotent, ảnh chụp mới GỠ advertiser đã biến mất, body lỗi KHÔNG land, và CẢ HAI
 * đường: trang ingest thường ngày (`/api/ingest/raw`) lẫn lượt dựng lại.
 */

const BC = "7129545797879726081";
// Viết dạng SỐ JSON trong fixture: qua JSON.parse sẽ thành …903000 — Silver phải giữ đúng …902722.
const ADV = "7129548444015902722";
const ADV2 = "7090000000000000001";
/** Advertiser có trong ảnh chụp của BC nhưng CHƯA TỪNG có báo cáo chi tiêu (`RawTiktokBusinessReport`). */
const ADV_LAC = "7090000000000000999";
const NGAY = "2026-10-14";
const NGAY_LUC = new Date("2026-10-14T00:00:00+07:00");

/** Một dòng `cost_list` — tiền là SỐ JSON CÓ DẤU như API thật (chi phí âm). `adv` viết dạng SỐ JSON (int64). */
const dong = (adv: string, grant: number, cash: number, amount: number) =>
  `{"advertiser_id":${adv},"amount":${amount},"cash_amount":${cash},"grant_amount":${grant},"tax_amount":0,"currency":"VND"}`;

/** Envelope THÔ `/bc/account/cost/get/` một trang. `requestId` đổi mỗi lần gọi như TikTok thật. */
const envelope = (requestId: string, ...items: string[]) => trangThu(requestId, 1, 1, items.length, ...items);
/** Một trang của ảnh chụp nhiều trang — `tongDong` = `total_number` TikTok báo cho CẢ ảnh chụp (giống nhau mọi trang). */
const trangThu = (requestId: string, page: number, tongTrang: number, tongDong: number, ...items: string[]) =>
  `{"code":0,"message":"OK","request_id":"${requestId}","data":{"cost_list":[${items.join(",")}],` +
  `"transaction_summary":{},"page_info":{"page":${page},"page_size":50,"total_number":${tongDong},"total_page":${tongTrang}}}}`;

/** Đúng body thật ngày 20/10 (controller đo 24/10): advertiser_id CHUỖI, tiền SỐ ÂM. */
const BODY_THAT_2010 =
  `{"code":0,"message":"OK","request_id":"that-2010","data":{"cost_list":[{"advertiser_id":"${ADV}",` +
  `"advertiser_name":"Hogikids","amount":-995050,"cash_amount":-750294,"currency":"VND","grant_amount":-244756,` +
  `"tax_amount":-75029}],"page_info":{"page":1,"page_size":10,"total_number":1,"total_page":1}}}`;

/** Đúng body đo thật 24/10 ngày KHÔNG chi tiêu (15/07, 20/07, 05/08/2026): `cost_list` rỗng, `total_page` 0. */
const BODY_RONG_THAT =
  `{"code":0,"message":"OK","request_id":"rong-that","data":{"cost_list":[],` +
  `"page_info":{"page":1,"page_size":50,"total_number":0,"total_page":0}}}`;

const landNgay = (text: string | string[], ngay = NGAY) =>
  landRaw("tiktokbusiness/cost", BC, bocAnhChupChiPhiTiktok(text), undefined, undefined, undefined, ngay);

/** Một trang hoá đơn — để đo VAT tháng (BILL_PAYMENT subtotal/tax). */
const trangHoaDon = (subtotal: number, tax: number) =>
  `{"code":0,"message":"OK","data":{"transaction_list":[{"transaction_id":"VAT-1","transaction_type":"BILL_PAYMENT",` +
  `"billing_type":"CASH","amount_type":"POSITIVE","account_id":"${ADV}","bc_id":"${BC}","subtotal":${subtotal},` +
  `"tax_amount":${tax},"amount":${subtotal + tax},"currency":"VND","create_time":"2026-10-14 10:00:00",` +
  `"timezone":"UTC+07:00"}],"page_info":{"total_page":1}}}`;

let soBaoCao = 0;
/**
 * Advertiser "đã có trong sổ chi phí": một dòng Bronze báo cáo chi tiêu (`shopId` = advertiser_id). Transform chỉ
 * nhận tín dụng của advertiser có báo cáo — payload không quan trọng.
 */
async function coBaoCao(...advs: string[]): Promise<void> {
  await prisma.rawTiktokBusinessReport.createMany({
    data: advs.map((a) => {
      soBaoCao += 1;
      return { shopId: a, externalId: `auction:c${soBaoCao}:2026-10-14`, payloadHash: `bao-cao-${soBaoCao}`, payload: {} };
    }),
  });
}

async function cleanup(): Promise<void> {
  await prisma.tiktokAdsTinDung.deleteMany();
  await prisma.rawTiktokBusinessCost.deleteMany();
  await prisma.rawTiktokBusinessReport.deleteMany();
  await prisma.tiktokAdsHoaDon.deleteMany();
  await prisma.rawTiktokBusinessInvoice.deleteMany();
  await prisma.syncLog.deleteMany({ where: { kind: "TIKTOK_ADS" } });
  await prisma.setting.deleteMany({ where: { key: "bronzeBacklogPending" } });
}

beforeEach(async () => {
  await cleanup();
  await coBaoCao(ADV, ADV2);
});
afterEach(() => {
  delete process.env.BRONZE_ONLY;
});
afterAll(async () => {
  await cleanup();
  await prisma.$disconnect();
});

describe("land tiktokbusiness/cost — ảnh chụp ngày", () => {
  it("một ngày = MỘT dòng Bronze, khoá = ngày, shopId = bc_id", async () => {
    const r = await landNgay(envelope("r1", dong(ADV, -9000, -121000, -130000), dong(ADV, -4000, 0, -4000)));
    expect(r).toMatchObject({ landed: 1, skippedNoId: 0, landedIds: [NGAY] });
    const rows = await prisma.rawTiktokBusinessCost.findMany();
    expect(rows.map((x) => [x.shopId, x.externalId])).toEqual([[BC, NGAY]]);
  });

  it("body LỖI (code ≠ 0) bọc vào mảng vẫn KHÔNG land — không đè ảnh chụp thật", async () => {
    await expect(landNgay(`{"code":40002,"message":"finance permission","data":{}}`)).rejects.toThrow(
      /rút được 0 khoá/,
    );
    expect(await prisma.rawTiktokBusinessCost.count()).toBe(0);
  });

  it("thiếu `ngay` ⇒ ném (record không mang ngày, khoá sẽ trùng mọi ngày)", async () => {
    await expect(
      landRaw("tiktokbusiness/cost", BC, bocAnhChupChiPhiTiktok(envelope("r1"))),
    ).rejects.toThrow(/thiếu 'ngay'/);
  });
});

describe("transform tiktokbusiness/cost — lượt dựng lại (quét cả bảng)", () => {
  it("body THẬT 20/10 (tiền số âm) ⇒ Silver dương, grantGomVat = round(244.756 × 1,1)", async () => {
    await landNgay(BODY_THAT_2010, "2026-10-20");
    const stats = await transformFromRaw("tiktokbusiness/cost", []);
    expect(stats).toMatchObject({ skipped: 0, tinDungAdsUpserted: 1 });
    expect(await prisma.tiktokAdsTinDung.findFirstOrThrow()).toMatchObject({
      advertiserId: ADV,
      grantExVat: 244_756,
      cashExVat: 750_294,
      amountExVat: 995_050,
      grantGomVat: 269_232,
    });
  });

  it("API trả số DƯƠNG (TikTok hoàn) ⇒ Silver ÂM, ghi được (không có CHECK ≥ 0)", async () => {
    await landNgay(envelope("r1", dong(ADV, 5000, 0, 5000)));
    const stats = await transformFromRaw("tiktokbusiness/cost", []);
    expect(stats.skipped).toBe(0);
    expect(await prisma.tiktokAdsTinDung.findFirstOrThrow()).toMatchObject({ grantExVat: -5_000, grantGomVat: -5_500 });
  });

  it("ảnh chụp NHIỀU TRANG ⇒ cộng dòng mọi trang; thiếu trang ⇒ bỏ cả ảnh chụp", async () => {
    await landNgay([
      trangThu("r1", 1, 2, 3, dong(ADV, -9000, -121000, -130000)),
      trangThu("r1", 2, 2, 3, dong(ADV, -4000, 0, -4000), dong(ADV2, -1000, 0, -1000)),
    ]);
    const stats = await transformFromRaw("tiktokbusiness/cost", []);
    expect(stats.skipped).toBe(0);
    const rows = await prisma.tiktokAdsTinDung.findMany({ orderBy: { advertiserId: "asc" } });
    expect(rows.map((r) => [r.advertiserId, r.grantExVat])).toEqual([
      [ADV2, 1_000],
      [ADV, 13_000],
    ]);

    await landNgay([trangThu("r2", 1, 2, 2, dong(ADV, -1, -1, -2))], "2026-10-15");
    const w: string[] = [];
    const lan2 = await transformFromRaw("tiktokbusiness/cost", w);
    expect(lan2.skipped).toBe(1);
    expect(w.join(" ")).toMatch(/có 2 trang mà chỉ land 1/);
  });

  it("CỘNG dòng cùng advertiser, advertiser_id lossless, VAT mặc định 10% khi chưa có hoá đơn", async () => {
    await landNgay(
      envelope("r1", dong(ADV, -9000, -121000, -130000), dong(ADV, -4000, 0, -4000), dong(ADV2, 0, -35880, -35880)),
    );
    const w: string[] = [];
    const stats = await transformFromRaw("tiktokbusiness/cost", w);

    expect(stats.tinDungAdsUpserted).toBe(2);
    expect(stats.skipped).toBe(0);
    const rows = await prisma.tiktokAdsTinDung.findMany({ orderBy: { advertiserId: "asc" } });
    expect(rows.map((r) => r.advertiserId)).toEqual([ADV2, ADV]);
    expect(rows[1]).toMatchObject({
      bcId: BC,
      grantExVat: 13_000,
      cashExVat: 121_000,
      amountExVat: 134_000,
      grantGomVat: 14_300,
    });
    expect(rows[1].ngay.toISOString()).toBe(NGAY_LUC.toISOString());
    expect(rows[1].raw).toHaveLength(2);
    expect(rows[0]).toMatchObject({ grantExVat: 0, grantGomVat: 0, cashExVat: 35_880 });
  });

  it("VAT tháng đo từ hoá đơn trong kho thô (8%) — cùng hàm với lượt dựng lại Expense", async () => {
    await landRaw("tiktokbusiness/invoice", BC, trangHoaDon(100_000, 8_000));
    await landNgay(envelope("r1", dong(ADV, -13000, 0, -13000)));
    await transformFromRaw("tiktokbusiness/cost", []);
    const row = await prisma.tiktokAdsTinDung.findFirstOrThrow();
    expect(row.grantGomVat).toBe(14_040);
  });

  it("idempotent; ảnh chụp mới hơn ghi đè số và GỠ advertiser đã biến khỏi ảnh chụp", async () => {
    await landNgay(envelope("r1", dong(ADV, -9000, -121000, -130000), dong(ADV2, -1000, 0, -1000)));
    await transformFromRaw("tiktokbusiness/cost", []);
    await transformFromRaw("tiktokbusiness/cost", []);
    expect(await prisma.tiktokAdsTinDung.count()).toBe(2);

    // TikTok chỉnh hồi tố: ADV đổi số, ADV2 không còn trong ảnh chụp ngày đó.
    await landNgay(envelope("r2", dong(ADV, -5000, -125000, -130000)));
    const stats = await transformFromRaw("tiktokbusiness/cost", []);
    expect(stats.tinDungAdsUpserted).toBe(1);
    const rows = await prisma.tiktokAdsTinDung.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ advertiserId: ADV, grantExVat: 5_000, grantGomVat: 5_500 });
  });

  it("ảnh chụp mới bỏ hẳn cost_list (ngày không còn chi) ⇒ gỡ mọi dòng của BC ngày đó, ngày khác giữ nguyên", async () => {
    await landNgay(envelope("r1", dong(ADV, -9000, -121000, -130000)));
    await landNgay(envelope("r1", dong(ADV, -7000, 0, -7000)), "2026-10-15");
    await transformFromRaw("tiktokbusiness/cost", []);
    expect(await prisma.tiktokAdsTinDung.count()).toBe(2);

    await landNgay(`{"code":0,"message":"OK","request_id":"r3","data":{"page_info":{"total_page":1,"total_number":0}}}`);
    await transformFromRaw("tiktokbusiness/cost", []);
    const rows = await prisma.tiktokAdsTinDung.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0].ngay.toISOString()).toBe(new Date("2026-10-15T00:00:00+07:00").toISOString());
  });

  it("ngày không chi tiêu: body THẬT total_page 0 + cost_list [] ⇒ ảnh chụp hợp lệ, gỡ số cũ, skipped 0", async () => {
    await landNgay(envelope("r1", dong(ADV, -9000, -121000, -130000)));
    await landNgay(envelope("r1", dong(ADV, -7000, 0, -7000)), "2026-10-15");
    await transformFromRaw("tiktokbusiness/cost", []);
    expect(await prisma.tiktokAdsTinDung.count()).toBe(2);

    const w: string[] = [];
    await landNgay(BODY_RONG_THAT);
    const stats = await transformFromRaw("tiktokbusiness/cost", w);
    expect(stats.skipped).toBe(0);
    expect(w.join(" ")).not.toMatch(/Bỏ qua ảnh chụp/);
    const rows = await prisma.tiktokAdsTinDung.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0].ngay.toISOString()).toBe(new Date("2026-10-15T00:00:00+07:00").toISOString());
  });

  it("total_page 0 mà cost_list CÓ dòng ⇒ skipped, số cũ giữ nguyên", async () => {
    await landNgay(envelope("r1", dong(ADV, -9000, -121000, -130000)));
    await transformFromRaw("tiktokbusiness/cost", []);
    await landNgay(trangThu("r2", 1, 0, 1, dong(ADV, -1, -1, -2)));
    const w: string[] = [];
    const stats = await transformFromRaw("tiktokbusiness/cost", w);
    expect(stats.skipped).toBe(1);
    expect(w.join(" ")).toMatch(/total_page 0 mà cost_list có 1 dòng/);
    expect((await prisma.tiktokAdsTinDung.findFirstOrThrow()).grantExVat).toBe(9_000);
  });

  it("ảnh chụp hỏng (một dòng thiếu grant) ⇒ skipped + cảnh báo, số cũ của ngày đó giữ nguyên", async () => {
    await landNgay(envelope("r1", dong(ADV, -9000, -121000, -130000)));
    await transformFromRaw("tiktokbusiness/cost", []);
    await landNgay(
      envelope("r2", dong(ADV, -1, -1, -2), `{"advertiser_id":"${ADV2}","amount":-5,"cash_amount":-5,"currency":"VND"}`),
    );
    const w: string[] = [];
    const stats = await transformFromRaw("tiktokbusiness/cost", w);
    expect(stats.skipped).toBe(1);
    expect(w.join(" ")).toMatch(/ảnh chụp chi phí TikTok .* thiếu grant_amount/);
    expect((await prisma.tiktokAdsTinDung.findFirstOrThrow()).grantExVat).toBe(9_000);
  });

  it("trang báo total_number mà vắng cost_list ⇒ skipped, KHÔNG gỡ tín dụng cũ của ngày đó", async () => {
    await landNgay(envelope("r1", dong(ADV, -9000, -121000, -130000)));
    await transformFromRaw("tiktokbusiness/cost", []);
    await landNgay(`{"code":0,"message":"OK","request_id":"r2","data":{"page_info":{"page":1,"total_page":1,"total_number":5}}}`);
    const w: string[] = [];
    const stats = await transformFromRaw("tiktokbusiness/cost", w);
    expect(stats.skipped).toBe(1);
    expect(w.join(" ")).toMatch(/thiếu dòng \(0\/5\)/);
    expect((await prisma.tiktokAdsTinDung.findFirstOrThrow()).grantExVat).toBe(9_000);
  });

  it("2 trang land đủ mà Σ dòng < total_number ⇒ skipped, số cũ giữ nguyên", async () => {
    await landNgay(envelope("r1", dong(ADV, -9000, -121000, -130000)));
    await transformFromRaw("tiktokbusiness/cost", []);
    await landNgay([
      trangThu("r2", 1, 2, 4, dong(ADV, -1, -1, -2)),
      trangThu("r2", 2, 2, 4, dong(ADV2, -1, -1, -2)),
    ]);
    const w: string[] = [];
    const stats = await transformFromRaw("tiktokbusiness/cost", w);
    expect(stats.skipped).toBe(1);
    expect(w.join(" ")).toMatch(/thiếu dòng \(2\/4\)/);
    const rows = await prisma.tiktokAdsTinDung.findMany();
    expect(rows.map((r) => [r.advertiserId, r.grantExVat])).toEqual([[ADV, 9_000]]);
  });

  it("externalIds rỗng ⇒ 0 dòng (KHÔNG rơi về quét cả bảng)", async () => {
    await landNgay(envelope("r1", dong(ADV, -9000, -121000, -130000)));
    const stats = await transformFromRaw("tiktokbusiness/cost", [], { externalIds: [] });
    expect(stats.tinDungAdsUpserted).toBe(0);
    expect(await prisma.tiktokAdsTinDung.count()).toBe(0);
  });
});

describe("transform tiktokbusiness/cost — chỉ nhận advertiser đã có báo cáo chi tiêu", () => {
  it("advertiser chưa từng có báo cáo ⇒ KHÔNG ghi tín dụng (không trừ vào ads advertiser khác), cảnh báo + đếm, skipped 0", async () => {
    await landNgay(envelope("r1", dong(ADV, -9000, -121000, -130000), dong(ADV_LAC, -39561, 0, -39561)));
    const w: string[] = [];
    const stats = await transformFromRaw("tiktokbusiness/cost", w);
    expect(stats).toMatchObject({ skipped: 0, tinDungAdsUpserted: 1, tinDungAdvertiserNgoaiSo: 1 });
    const rows = await prisma.tiktokAdsTinDung.findMany();
    expect(rows.map((r) => r.advertiserId)).toEqual([ADV]);
    expect(w.join(" ")).toContain(ADV_LAC);
  });

  it("dòng Silver CŨ của advertiser lạc (đã ghi trước khi lọc) ⇒ lượt kế GỠ; advertiser có báo cáo giữ nguyên", async () => {
    await prisma.tiktokAdsTinDung.create({
      data: {
        advertiserId: ADV_LAC,
        bcId: BC,
        ngay: NGAY_LUC,
        grantExVat: 39_561,
        cashExVat: 0,
        amountExVat: 39_561,
        grantGomVat: 43_517,
        raw: [],
      },
    });
    await landNgay(envelope("r1", dong(ADV, -9000, -121000, -130000), dong(ADV_LAC, -39561, 0, -39561)));
    await transformFromRaw("tiktokbusiness/cost", []);
    const rows = await prisma.tiktokAdsTinDung.findMany();
    expect(rows.map((r) => [r.advertiserId, r.grantExVat])).toEqual([[ADV, 9_000]]);
  });

  it("advertiser lạc có báo cáo từ lượt sau ⇒ tín dụng của nó được ghi (ảnh chụp theo ngày tự bù)", async () => {
    await landNgay(envelope("r1", dong(ADV, -9000, -121000, -130000), dong(ADV_LAC, -39561, 0, -39561)));
    await transformFromRaw("tiktokbusiness/cost", []);
    expect(await prisma.tiktokAdsTinDung.count()).toBe(1);

    await coBaoCao(ADV_LAC);
    const w: string[] = [];
    const stats = await transformFromRaw("tiktokbusiness/cost", w);
    expect(stats).toMatchObject({ skipped: 0, tinDungAdsUpserted: 2 });
    expect(stats).not.toHaveProperty("tinDungAdvertiserNgoaiSo");
    const rows = await prisma.tiktokAdsTinDung.findMany({ orderBy: { advertiserId: "asc" } });
    expect(rows.map((r) => [r.advertiserId, r.grantExVat])).toEqual([
      [ADV_LAC, 39_561],
      [ADV, 9_000],
    ]);
  });

  it("đường ingest: advertiser lạc chỉ là cảnh báo — SyncLog OK, không bật cờ backlog", async () => {
    const res = await POST(
      new Request("http://localhost/api/ingest/raw", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${SECRET}` },
        body: JSON.stringify({
          stream: "tiktokbusiness/cost",
          shopId: BC,
          payload: bocAnhChupChiPhiTiktok(envelope("r1", dong(ADV_LAC, -39561, 0, -39561))),
          ngay: NGAY,
        }),
      }),
    );
    expect(res.status).toBe(200);
    expect((await res.json()).loiSauKhiGhi).toBeUndefined();
    const log = await prisma.syncLog.findFirstOrThrow({ where: { kind: "TIKTOK_ADS" }, orderBy: { startedAt: "desc" } });
    expect(log.status).toBe("OK");
    expect(await hasBronzeBacklog()).toBe(false);
    expect(await prisma.tiktokAdsTinDung.count()).toBe(0);
  });
});

describe("transform tiktokbusiness/cost — đường ingest thường ngày (/api/ingest/raw)", () => {
  const post = (body: Record<string, unknown>) =>
    POST(
      new Request("http://localhost/api/ingest/raw", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${SECRET}` },
        body: JSON.stringify({ stream: "tiktokbusiness/cost", shopId: BC, ...body }),
      }),
    );

  it("ảnh chụp land kèm `ngay` ⇒ Silver có ngay", async () => {
    const res = await post({ payload: bocAnhChupChiPhiTiktok(envelope("r1", dong(ADV, -9000, -121000, -130000))), ngay: NGAY });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.stats).toMatchObject({ mode: "land+transform", landed: 1, tinDungAdsUpserted: 1 });
    expect(await prisma.tiktokAdsTinDung.findFirstOrThrow()).toMatchObject({ advertiserId: ADV, grantGomVat: 9_900 });
  });

  it("ảnh chụp bị BỎ (dòng thiếu grant_amount) ⇒ SyncLog ERROR + cờ backlog, HTTP vẫn 200", async () => {
    const hong = `{"advertiser_id":"${ADV}","amount":-5,"cash_amount":-5,"currency":"VND"}`;
    const res = await post({ payload: bocAnhChupChiPhiTiktok(envelope("r1", hong)), ngay: NGAY });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.loiSauKhiGhi).toMatch(/tiktokbusiness\/cost.*1 record.*tín dụng TikTok tặng/);
    const log = await prisma.syncLog.findFirstOrThrow({ where: { kind: "TIKTOK_ADS" }, orderBy: { startedAt: "desc" } });
    expect(log.status).toBe("ERROR");
    expect(await hasBronzeBacklog()).toBe(true);
    expect(await prisma.tiktokAdsTinDung.count()).toBe(0);
  });

  it("ảnh chụp thiếu dòng (total_number 5, vắng cost_list) ⇒ SyncLog ERROR + cờ backlog, số cũ giữ, HTTP 200", async () => {
    await post({ payload: bocAnhChupChiPhiTiktok(envelope("r1", dong(ADV, -9000, -121000, -130000))), ngay: NGAY });
    expect(await prisma.tiktokAdsTinDung.count()).toBe(1);
    const thieu = `{"code":0,"message":"OK","request_id":"r2","data":{"page_info":{"page":1,"total_page":1,"total_number":5}}}`;
    const res = await post({ payload: bocAnhChupChiPhiTiktok(thieu), ngay: NGAY });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.loiSauKhiGhi).toMatch(/tiktokbusiness\/cost.*1 record/);
    const log = await prisma.syncLog.findFirstOrThrow({ where: { kind: "TIKTOK_ADS" }, orderBy: { startedAt: "desc" } });
    expect(log.status).toBe("ERROR");
    expect(await hasBronzeBacklog()).toBe(true);
    expect((await prisma.tiktokAdsTinDung.findFirstOrThrow()).grantExVat).toBe(9_000);
  });

  it("ngày không chi tiêu (body thật total_page 0) ⇒ SyncLog OK, không bật cờ backlog, gỡ số cũ", async () => {
    await post({ payload: bocAnhChupChiPhiTiktok(envelope("r1", dong(ADV, -9000, -121000, -130000))), ngay: NGAY });
    expect(await prisma.tiktokAdsTinDung.count()).toBe(1);
    const res = await post({ payload: bocAnhChupChiPhiTiktok(BODY_RONG_THAT), ngay: NGAY });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.loiSauKhiGhi).toBeUndefined();
    const log = await prisma.syncLog.findFirstOrThrow({ where: { kind: "TIKTOK_ADS" }, orderBy: { startedAt: "desc" } });
    expect(log.status).toBe("OK");
    expect(await hasBronzeBacklog()).toBe(false);
    expect(await prisma.tiktokAdsTinDung.count()).toBe(0);
  });

  it("ảnh chụp lành ⇒ SyncLog OK, không bật cờ backlog (đối chứng)", async () => {
    const res = await post({ payload: bocAnhChupChiPhiTiktok(envelope("r1", dong(ADV, -9000, -121000, -130000))), ngay: NGAY });
    expect((await res.json()).loiSauKhiGhi).toBeUndefined();
    const log = await prisma.syncLog.findFirstOrThrow({ where: { kind: "TIKTOK_ADS" }, orderBy: { startedAt: "desc" } });
    expect(log.status).toBe("OK");
    expect(await hasBronzeBacklog()).toBe(false);
  });

  it("thiếu `ngay` ⇒ 400, không land gì", async () => {
    const res = await post({ payload: bocAnhChupChiPhiTiktok(envelope("r1")) });
    expect(res.status).toBe(400);
    expect(await prisma.rawTiktokBusinessCost.count()).toBe(0);
  });

  it("BRONZE_ONLY ⇒ chỉ land, Silver đứng yên (lượt dựng lại bù sau)", async () => {
    process.env.BRONZE_ONLY = "true";
    const res = await post({ payload: bocAnhChupChiPhiTiktok(envelope("r1", dong(ADV, -9000, -121000, -130000))), ngay: NGAY });
    expect(res.status).toBe(200);
    expect(await prisma.rawTiktokBusinessCost.count()).toBe(1);
    expect(await prisma.tiktokAdsTinDung.count()).toBe(0);

    delete process.env.BRONZE_ONLY;
    await transformFromRaw("tiktokbusiness/cost", []);
    expect(await prisma.tiktokAdsTinDung.count()).toBe(1);
  });
});
