import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";

// INGEST_SECRET phải set TRƯỚC khi import route (requireIngestSecret đọc process.env lúc chạy).
const SECRET = "test-ingest-secret";
process.env.INGEST_SECRET = SECRET;

import { POST } from "@/app/api/ingest/raw/route";
import { hasBronzeBacklog } from "@/lib/bronze/bronze-only";
import { landRaw } from "@/lib/bronze/land-raw";
import { transformFromRaw } from "@/lib/bronze/transform-from-raw";
import { prisma } from "@/lib/prisma";

/**
 * Integration Bronze hoá đơn quảng cáo TikTok → Silver `TiktokAdsHoaDon` (`hogikids_test`).
 * Kiểm: land MỌI loại (kể cả PROMOTION_ISSUED), khoá `transactionId` nguyên chuỗi (ghép "A|B"), id int64 dạng SỐ
 * JSON vẫn lossless (rút bằng SQL, không JSON.parse), idempotent + bản Bronze mới ghi đè, dòng hỏng chỉ `skipped`,
 * và CẢ HAI đường: trang ingest thường ngày (`/api/ingest/raw`) lẫn lượt dựng lại (quét cả bảng).
 */

const BC = "7129545797879726081";
const ADV = "7129548444015902722";

/** Một trang `/bc/account/transaction/get/` — `items` là các object JSON THÔ (giữ số int64 nguyên văn). */
const trang = (...items: string[]) =>
  `{"code":0,"message":"OK","data":{"transaction_list":[${items.join(",")}],"page_info":{"total_page":1}}}`;

const hd = ({
  id,
  loai = "BILL_PAYMENT",
  billing = "CASH",
  chieu = "POSITIVE",
  amount = "143000",
  luc = "2026-10-23 15:38:00",
  tz = "UTC+07:00",
  them = "",
}: {
  id: string;
  loai?: string;
  billing?: string;
  chieu?: string;
  amount?: string;
  luc?: string;
  tz?: string;
  them?: string;
}) =>
  `{"transaction_id":"${id}","transaction_type":"${loai}","billing_type":"${billing}","amount_type":"${chieu}",` +
  `"account_id":"${ADV}","bc_id":"${BC}","subtotal":130000,"tax_amount":13000,"amount":${amount},"currency":"VND",` +
  `"create_time":"${luc}","timezone":"${tz}"${them}}`;

async function cleanup(): Promise<void> {
  await prisma.tiktokAdsHoaDon.deleteMany();
  await prisma.rawTiktokBusinessInvoice.deleteMany();
  await prisma.syncLog.deleteMany({ where: { kind: "TIKTOK_ADS" } });
  await prisma.setting.deleteMany({ where: { key: "bronzeBacklogPending" } });
}

beforeEach(cleanup);
afterEach(() => {
  delete process.env.BRONZE_ONLY;
});
afterAll(async () => {
  await cleanup();
  await prisma.$disconnect();
});

describe("transform tiktokbusiness/invoice — lượt dựng lại (quét cả bảng)", () => {
  it("land mọi loại, khoá ghép nguyên chuỗi, int64 SỐ JSON lossless, tiền Int, giờ VN đúng instant", async () => {
    await landRaw(
      "tiktokbusiness/invoice",
      BC,
      trang(
        // payment_portfolio_id là SỐ JSON 19 chữ số: qua JSON.parse sẽ thành …205000.
        hd({ id: "7657315630890860807|7657315630890860999", them: `,"payment_portfolio_id":7553366094925204945,"invoice_id":"765732"` }),
        hd({ id: "PROMO-1", loai: "PROMOTION_ISSUED", billing: "CREDIT", amount: "1300750", luc: "2026-10-13 15:12:00" }),
        hd({ id: "OCP-1", loai: "ORDER_CREATION_PAYMENT", chieu: "NEGATIVE", amount: "\"226682\"" }),
      ),
    );

    const w: string[] = [];
    const stats = await transformFromRaw("tiktokbusiness/invoice", w);

    expect(stats.hoaDonAdsUpserted).toBe(3);
    expect(stats.skipped).toBe(0);
    const rows = await prisma.tiktokAdsHoaDon.findMany({ orderBy: { transactionId: "asc" } });
    expect(rows.map((r) => r.transactionId)).toEqual(["7657315630890860807|7657315630890860999", "OCP-1", "PROMO-1"]);

    const bill = rows[0];
    expect(bill).toMatchObject({
      bcId: BC,
      advertiserId: ADV,
      invoiceId: "765732",
      amount: 143_000,
      subtotal: 130_000,
      taxAmount: 13_000,
      transactionType: "BILL_PAYMENT",
      billingType: "CASH",
      amountType: "POSITIVE",
      paymentPortfolioId: "7553366094925204945",
    });
    expect(bill.createTime.toISOString()).toBe("2026-10-23T08:38:00.000Z");
    expect(rows[1]).toMatchObject({ amount: 226_682, amountType: "NEGATIVE", invoiceId: null, paymentPortfolioId: null });
    expect(rows[2]).toMatchObject({ transactionType: "PROMOTION_ISSUED", billingType: "CREDIT", amount: 1_300_750 });
  });

  it("idempotent: chạy 2 lần 1 dòng; TikTok sửa hoá đơn (bản Bronze mới) ⇒ ghi đè đúng dòng", async () => {
    await landRaw("tiktokbusiness/invoice", BC, trang(hd({ id: "TX1" })));
    await transformFromRaw("tiktokbusiness/invoice", []);
    await transformFromRaw("tiktokbusiness/invoice", []);
    expect(await prisma.tiktokAdsHoaDon.count()).toBe(1);

    await landRaw("tiktokbusiness/invoice", BC, trang(hd({ id: "TX1", amount: "121000" })));
    await transformFromRaw("tiktokbusiness/invoice", []);
    const rows = await prisma.tiktokAdsHoaDon.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0].amount).toBe(121_000);
  });

  it("dòng hỏng (timezone lạ, amount_type lạ) ⇒ skipped + cảnh báo nêu lý do, dòng lành vẫn ghi", async () => {
    await landRaw(
      "tiktokbusiness/invoice",
      BC,
      trang(hd({ id: "OK" }), hd({ id: "TZ", tz: "Asia/Ho_Chi_Minh" }), hd({ id: "CHIEU", chieu: "WEIRD" })),
    );
    const w: string[] = [];
    const stats = await transformFromRaw("tiktokbusiness/invoice", w);

    expect(stats.hoaDonAdsUpserted).toBe(1);
    expect(stats.skipped).toBe(2);
    expect(w.join(" ")).toMatch(/hoá đơn TikTok TZ: timezone lạ/);
    expect(w.join(" ")).toMatch(/hoá đơn TikTok CHIEU: amount_type/);
    expect((await prisma.tiktokAdsHoaDon.findMany()).map((r) => r.transactionId)).toEqual(["OK"]);
  });

  it("externalIds rỗng ⇒ 0 dòng (KHÔNG rơi về quét cả bảng)", async () => {
    await landRaw("tiktokbusiness/invoice", BC, trang(hd({ id: "TX1" })));
    const stats = await transformFromRaw("tiktokbusiness/invoice", [], { externalIds: [] });
    expect(stats.hoaDonAdsUpserted).toBe(0);
    expect(await prisma.tiktokAdsHoaDon.count()).toBe(0);
  });
});

describe("transform tiktokbusiness/invoice — đường ingest thường ngày (/api/ingest/raw)", () => {
  const post = (payload: string) =>
    POST(
      new Request("http://localhost/api/ingest/raw", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${SECRET}` },
        body: JSON.stringify({ stream: "tiktokbusiness/invoice", shopId: BC, payload }),
      }),
    );

  it("trang hoá đơn land ⇒ Silver có ngay, chỉ dựng đúng id vừa land", async () => {
    const res = await post(trang(hd({ id: "TX-A" }), hd({ id: "TX-B", luc: "2026-10-22 22:11:00" })));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.stats).toMatchObject({ mode: "land+transform", landed: 2, hoaDonAdsUpserted: 2 });
    expect((await prisma.tiktokAdsHoaDon.findMany({ orderBy: { transactionId: "asc" } })).map((r) => r.transactionId)).toEqual([
      "TX-A",
      "TX-B",
    ]);
  });

  it("hoá đơn bị BỎ (timezone lạ) ⇒ SyncLog ERROR + cờ backlog, HTTP vẫn 200, dòng lành vẫn ghi", async () => {
    const res = await post(trang(hd({ id: "TX-OK" }), hd({ id: "TX-TZ", tz: "Asia/Ho_Chi_Minh" })));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.loiSauKhiGhi).toMatch(/tiktokbusiness\/invoice.*1 record.*dư nợ thẻ/);
    expect(json.stats).toMatchObject({ hoaDonAdsUpserted: 1, skipped: 1 });
    const log = await prisma.syncLog.findFirstOrThrow({ where: { kind: "TIKTOK_ADS" }, orderBy: { startedAt: "desc" } });
    expect(log.status).toBe("ERROR");
    expect(await hasBronzeBacklog()).toBe(true);
    expect(await prisma.tiktokAdsHoaDon.count()).toBe(1);
  });

  it("trang lành ⇒ SyncLog OK, không bật cờ backlog (đối chứng)", async () => {
    const res = await post(trang(hd({ id: "TX-LANH" })));
    expect((await res.json()).loiSauKhiGhi).toBeUndefined();
    const log = await prisma.syncLog.findFirstOrThrow({ where: { kind: "TIKTOK_ADS" }, orderBy: { startedAt: "desc" } });
    expect(log.status).toBe("OK");
    expect(await hasBronzeBacklog()).toBe(false);
  });

  it("BRONZE_ONLY ⇒ chỉ land, Silver đứng yên (lượt dựng lại bù sau)", async () => {
    process.env.BRONZE_ONLY = "true";
    const res = await post(trang(hd({ id: "TX-BO" })));
    expect(res.status).toBe(200);
    expect(await prisma.rawTiktokBusinessInvoice.count()).toBe(1);
    expect(await prisma.tiktokAdsHoaDon.count()).toBe(0);

    delete process.env.BRONZE_ONLY;
    await transformFromRaw("tiktokbusiness/invoice", []);
    expect(await prisma.tiktokAdsHoaDon.count()).toBe(1);
  });
});
