import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

// INGEST_SECRET phải set TRƯỚC khi import route (requireIngestSecret đọc process.env lúc chạy).
const SECRET = "test-ingest-secret";
process.env.INGEST_SECRET = SECRET;

import { POST } from "@/app/api/ingest/raw/route";
import { landRaw, LoiThieuKhoaStreamTien } from "@/lib/bronze/land-raw";
import { BRONZE_STREAMS, type BronzeStream } from "@/lib/bronze/streams";
import { prisma } from "@/lib/prisma";

import { SHOP_SHOPEE, SHOP_TIKTOK_SHOP } from "../helpers/shop-ids-fixture";
import { seedReference, truncateBusinessTables } from "../helpers/test-db";

/**
 * Trang có MỘT PHẦN record thiếu khoá. Với stream thường (đơn, báo cáo ads…) land phần còn lại +
 * đếm `skippedNoId` là đủ. Với stream TIỀN thì không: record thiếu khoá chưa từng vào Bronze nên
 * dựng lại từ kho thô KHÔNG cứu được, mà cổng đỏ sau transform chỉ soi `skipped` (record đã land) ⇒
 * hoá đơn trừ thẻ / lệnh rút bank biến mất với SyncLog OK. Stream tiền phải từ chối CẢ TRANG (không
 * land gì — cửa sổ kéo lại của n8n land lại đủ khi nhà cung cấp sửa) và báo ERROR.
 */

const BC = "7129545797879726081";
const hoaDon = (txId: string | null) =>
  `{${txId === null ? "" : `"transaction_id":"${txId}",`}"transaction_type":"BILL_PAYMENT",` +
  `"bc_id":"${BC}","subtotal":130000,"tax_amount":13000,"amount":143000,"currency":"VND",` +
  `"billing_type":"CASH","create_time":"2026-06-16 15:02:54"}`;
const trangHoaDon = (...items: string[]) =>
  `{"code":0,"message":"OK","data":{"transaction_list":[${items.join(",")}],"page_info":{"total_page":1}}}`;

const trangPayment = (...items: string[]) =>
  `{"code":0,"message":"Success","data":{"payments":[${items.join(",")}]}}`;
const payment = (id: string | null) =>
  `{${id === null ? "" : `"id":"${id}",`}"status":"PAID","paid_time":1783094255,` +
  `"settlement_amount":{"value":"1800000","currency":"VND"}}`;

const ORDER = (id: string | null) =>
  `{${id === null ? "" : `"id":"${id}",`}"status":3,"inserted_at":"2026-07-01T10:00:00.000000",` +
  `"order_sources_name":"Shopee","marketplace_id":"-3","total_price":200000,"total_discount":0,` +
  `"fee_marketplace":15000,"items":[]}`;

const postRaw = (stream: string, shopId: string, payload: string) =>
  POST(
    new Request("http://localhost/api/ingest/raw", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${SECRET}` },
      body: JSON.stringify({ stream, shopId, payload }),
    })
  );

const donBang = async () => {
  await prisma.rawTiktokBusinessInvoice.deleteMany();
  await prisma.rawTiktokShopPayment.deleteMany();
  await prisma.rawPancakeOrder.deleteMany();
};

beforeAll(async () => {
  await seedReference();
}, 60_000);

beforeEach(async () => {
  await truncateBusinessTables();
  await donBang();
  await prisma.syncLog.deleteMany();
});

afterAll(donBang);

describe("registry — cờ stream tiền", () => {
  it("đúng 6 stream mang tiền thật (quỹ / nợ thẻ / tín dụng / tiền về) được khai laStreamTien", () => {
    const tien = (Object.keys(BRONZE_STREAMS) as BronzeStream[]).filter((s) => BRONZE_STREAMS[s].laStreamTien).sort();
    expect(tien).toEqual(
      [
        "shopee/wallet",
        "tiktok/payments",
        "tiktok/statement_transactions",
        "tiktok/statements",
        "tiktokbusiness/cost",
        "tiktokbusiness/invoice",
      ].sort()
    );
  });
});

describe("landRaw — stream tiền có record thiếu khoá", () => {
  it("2 hoá đơn, 1 thiếu transaction_id ⇒ TỪ CHỐI cả trang, 0 dòng Bronze", async () => {
    await expect(
      landRaw("tiktokbusiness/invoice", BC, trangHoaDon(hoaDon("7657315630890860807"), hoaDon(null)))
    ).rejects.toThrow(LoiThieuKhoaStreamTien);

    expect(await prisma.rawTiktokBusinessInvoice.count()).toBe(0);
  });

  it("thông điệp nói rõ số record thiếu khoá + stream", async () => {
    await expect(
      landRaw("tiktok/payments", SHOP_TIKTOK_SHOP, trangPayment(payment("P1"), payment(null), payment(null)))
    ).rejects.toThrow(/2 record thiếu khoá.*tiktok\/payments/);
    expect(await prisma.rawTiktokShopPayment.count()).toBe(0);
  });

  it("trang tiền đủ khoá ⇒ land bình thường", async () => {
    const r = await landRaw("tiktokbusiness/invoice", BC, trangHoaDon(hoaDon("7657315630890860807")));
    expect(r).toMatchObject({ landed: 1, skippedNoId: 0 });
  });

  it("stream KHÔNG phải tiền (đơn Pancake) 1 thiếu id ⇒ vẫn land phần còn lại + đếm skippedNoId", async () => {
    const r = await landRaw("orders", SHOP_SHOPEE, `{"success":true,"data":[${ORDER("ORD-TK-1")},${ORDER(null)}]}`);
    expect(r.landed).toBe(1);
    expect(r.skippedNoId).toBe(1);
    expect(await prisma.rawPancakeOrder.count()).toBe(1);
  });
});

describe("POST /api/ingest/raw — stream tiền thiếu khoá ⇒ SyncLog ERROR, HTTP 200", () => {
  it("hoá đơn TikTok 1/2 thiếu khoá ⇒ 200 + loiSauKhiGhi + SyncLog ERROR + 0 dòng Bronze", async () => {
    const res = await postRaw(
      "tiktokbusiness/invoice",
      BC,
      trangHoaDon(hoaDon("7657315630890860807"), hoaDon(null))
    );
    const json = await res.json();

    // 200 chứ không 500: n8n THỬ LẠI khi 5xx rồi ném, các trang sau của cùng lượt không được gửi nữa.
    expect(res.status).toBe(200);
    expect(json.stats.landed).toBe(0);
    expect(json.stats.skippedNoId).toBe(1);
    expect(json.loiSauKhiGhi).toContain("thiếu khoá");
    const log = await prisma.syncLog.findFirst({ orderBy: { startedAt: "desc" } });
    expect(log?.status).toBe("ERROR");
    expect(await prisma.rawTiktokBusinessInvoice.count()).toBe(0);
  });

  it("đơn Pancake 1 thiếu id ⇒ SyncLog OK, skippedNoId lên stats", async () => {
    const res = await postRaw("orders", SHOP_SHOPEE, `{"success":true,"data":[${ORDER("ORD-TK-2")},${ORDER(null)}]}`);
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.stats.landed).toBe(1);
    expect(json.stats.skippedNoId).toBe(1);
    expect(json.loiSauKhiGhi).toBeUndefined();
  });
});
