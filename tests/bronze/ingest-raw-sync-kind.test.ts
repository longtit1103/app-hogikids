import { readFileSync } from "node:fs";
import path from "node:path";

import { beforeAll, beforeEach, describe, expect, it } from "vitest";

// INGEST_SECRET phải set TRƯỚC khi import route (requireIngestSecret đọc process.env lúc chạy).
const SECRET = "test-ingest-secret";
process.env.INGEST_SECRET = SECRET;

import { POST } from "@/app/api/ingest/raw/route";
import { SHOP_SHOPEE, SHOP_TIKTOK_SHOP } from "../helpers/shop-ids-fixture";
import { prisma } from "@/lib/prisma";

import { seedReference, truncateBusinessTables } from "../helpers/test-db";

/**
 * SyncLog PHẢI tách theo NGUỒN.
 *
 * Trước đây route ghi kind=PANCAKE cho MỌI stream: nightly TikTok (phí/đối soát) chạy OK sẽ đẻ hàng
 * chục log PANCAKE status=OK ⇒ badge "Đồng bộ lúc…" trên /don-hang, empty-state dashboard và nút
 * "Đồng bộ ngay" đều báo XANH trong khi luồng DOANH THU Pancake có thể đã chết nhiều ngày — và log
 * Pancake/ads thật bị đẩy khỏi danh sách 10 dòng gần nhất.
 */

const ORDER = `{"success":true,"data":[{"id":"ORD-KIND-1","status":3,"inserted_at":"2026-07-01T10:00:00.000000",
  "order_sources_name":"Shopee","marketplace_id":"-3","total_price":100000,"total_discount":0,"fee_marketplace":0,
  "items":[{"quantity":1,"discount_each_product":0,
    "variation_info":{"display_id":"SKU-K1","name":"SP","retail_price":100000}}]}]}`;

const STATEMENTS = `{"code":0,"message":"Success","data":{"statements":[
  {"id":"7639761649183852289","statement_time":1778803200,"settlement_amount":"159902","currency":"VND"}]}}`;

/** Payload THẬT đã gột PII (fixture Task 1) — dùng đúng envelope sàn trả, không bịa. */
const F = (ten: string) =>
  readFileSync(path.join(process.cwd(), "tests/fixtures/tiktokshop/analytics", ten), "utf8");
const GMVMAX_ITEM = () =>
  readFileSync(path.join(process.cwd(), "tests/fixtures/tiktokbusiness/gmvmax-item.json"), "utf8");

const post = (stream: string, shopId: string, payload: string) =>
  POST(
    new Request("http://localhost/api/ingest/raw", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${SECRET}` },
      body: JSON.stringify({ stream, shopId, payload }),
    })
  );

beforeAll(async () => {
  await seedReference(); // kênh/danh mục cho bước transform của stream Pancake
}, 60_000);

beforeEach(async () => {
  await truncateBusinessTables();
  await prisma.syncLog.deleteMany();
  await prisma.rawPancakeOrder.deleteMany();
  await prisma.rawTiktokShopStatement.deleteMany();
  await prisma.rawTiktokBusinessReport.deleteMany();
  await prisma.rawTiktokShopAnalyticsLive.deleteMany();
  await prisma.rawTiktokBusinessGmvMaxItem.deleteMany();
  await prisma.rawTiktokShopAffiliateOrder.deleteMany();
});

/** Dòng SKU affiliate ĐÃ LÀM PHẲNG — đúng shape workflow gửi (khuôn field từ fixture Task 1). */
const AFFILIATE_PHANG = `{"code":0,"message":"Success","data":{"total_count":1,"next_page_token":"","orders":[
  {"_don_id":"583585276075082966","_create_time":1776497985,"_ngay":"2026-04-18",
   "sku_id":"1731910824361625259","product_id":"1731910711337911979","quantity":1,
   "price":{"amount":"204700","currency":"VND"},"content_type":"VIDEO","creator_username":"creator_1"}]}}`;

describe("POST /api/ingest/raw — kind của SyncLog theo NGUỒN", () => {
  it("stream tiktok/* → SyncLog kind=TIKTOK_SHOP (KHÔNG sơn xanh trạng thái Pancake)", async () => {
    const res = await post("tiktok/statements", SHOP_TIKTOK_SHOP, STATEMENTS);
    expect(res.status).toBe(200);

    const logs = await prisma.syncLog.findMany();
    expect(logs).toHaveLength(1);
    expect(logs[0].kind).toBe("TIKTOK_SHOP");
    expect(logs[0].status).toBe("OK");

    // Chốt chặn cốt lõi: UI đọc kind=PANCAKE + status=OK để báo "đơn vẫn về".
    expect(await prisma.syncLog.count({ where: { kind: "PANCAKE" } })).toBe(0);
  });

  /**
   * BẪY: `"tiktokbusiness/report".startsWith("tiktok/")` là FALSE → luật cũ ném nó về PANCAKE.
   * Chi tiêu quảng cáo chạy OK sẽ "sơn xanh" trạng thái Pancake, che việc Pancake đã chết.
   */
  it("stream tiktokbusiness/* → kind=TIKTOK_ADS (KHÔNG rơi nhầm về PANCAKE)", async () => {
    const BAO_CAO = `{"code":0,"message":"OK","data":{"list":[
      {"dimensions":{"campaign_id":"1864314018521233","stat_time_day":"2026-05-20 00:00:00"},
       "metrics":{"campaign_name":"GMV Max","cost":81617}}]}}`;

    const res = await post("tiktokbusiness/report", "7129548444015902722", BAO_CAO);
    expect(res.status).toBe(200);

    const logs = await prisma.syncLog.findMany();
    expect(logs).toHaveLength(1);
    expect(logs[0].kind).toBe("TIKTOK_ADS");
    expect(await prisma.syncLog.count({ where: { kind: "PANCAKE" } })).toBe(0);
  });

  it("stream Pancake → SyncLog kind=PANCAKE (hành vi cũ giữ nguyên)", async () => {
    const res = await post("orders", SHOP_SHOPEE, ORDER);
    expect(res.status).toBe(200);

    const logs = await prisma.syncLog.findMany();
    expect(logs).toHaveLength(1);
    expect(logs[0].kind).toBe("PANCAKE");
  });

  /**
   * BẪY THỨ TỰ: `"tiktok/analytics_lives".startsWith("tiktok/")` cũng TRUE. Nhánh `tiktok/analytics_`
   * PHẢI đứng TRƯỚC nhánh `tiktok/` trong chuỗi ternary — đảo lại thì lượt analytics 02:30 chạy OK sẽ
   * ghi kind=TIKTOK_SHOP và "sơn xanh" trạng thái tài chính 02:00 vừa chết, mà không test nào đỏ.
   * Đây là ĐIỂM HỎNG DUY NHẤT của luật kind mới nên phải có lưới riêng.
   */
  it("stream tiktok/analytics_* → kind=TIKTOK_SHOP_ANALYTICS (KHÔNG sơn xanh luồng phí/đối soát)", async () => {
    // `analytics_lives` cố ý KHÔNG khai `chapNhanNgay` nên không cần tham số `ngay`.
    const res = await post("tiktok/analytics_lives", SHOP_TIKTOK_SHOP, F("shop-lives.json"));
    expect(res.status).toBe(200);

    const logs = await prisma.syncLog.findMany();
    expect(logs).toHaveLength(1);
    expect(logs[0].kind).toBe("TIKTOK_SHOP_ANALYTICS");
    expect(logs[0].status).toBe("OK");

    // Chốt chặn cốt lõi: hai dòng này đứng cạnh nhau trên cùng màn hình.
    expect(await prisma.syncLog.count({ where: { kind: "TIKTOK_SHOP" } })).toBe(0);
    expect(await prisma.syncLog.count({ where: { kind: "PANCAKE" } })).toBe(0);
  });

  /**
   * P3: `"tiktok/affiliate_orders".startsWith("tiktok/")` cũng TRUE — cùng bẫy thứ tự với nhánh
   * analytics ở trên. Gom/sắp lại chuỗi ternary làm stream này rơi xuống `tiktok/` thì mỗi trang
   * affiliate 02:30 ghi kind=TIKTOK_SHOP status=OK, "sơn xanh" luồng phí/đối soát tiền 02:00 vừa
   * chết — suite Bronze gọi thẳng landRaw nên CHỈ lưới này đi qua route và bắt được (review 28/08).
   */
  it("stream tiktok/affiliate_orders → kind=TIKTOK_SHOP_ANALYTICS (KHÔNG sơn xanh luồng phí/đối soát)", async () => {
    const res = await post("tiktok/affiliate_orders", SHOP_TIKTOK_SHOP, AFFILIATE_PHANG);
    expect(res.status).toBe(200);

    const logs = await prisma.syncLog.findMany();
    expect(logs).toHaveLength(1);
    expect(logs[0].kind).toBe("TIKTOK_SHOP_ANALYTICS");
    expect(logs[0].status).toBe("OK");
    expect(await prisma.rawTiktokShopAffiliateOrder.count()).toBe(1);

    expect(await prisma.syncLog.count({ where: { kind: "TIKTOK_SHOP" } })).toBe(0);
    expect(await prisma.syncLog.count({ where: { kind: "PANCAKE" } })).toBe(0);
  });

  it("stream tiktokbusiness/gmvmax_item → kind=TIKTOK_ADS (cùng lượt với campaign-level)", async () => {
    const res = await post("tiktokbusiness/gmvmax_item", "7129548444015902722", GMVMAX_ITEM());
    expect(res.status).toBe(200);

    const logs = await prisma.syncLog.findMany();
    expect(logs).toHaveLength(1);
    expect(logs[0].kind).toBe("TIKTOK_ADS");
    expect(await prisma.syncLog.count({ where: { kind: "TIKTOK_SHOP_ANALYTICS" } })).toBe(0);
  });

  it("shopId nhầm hệ (id Pancake cho stream tiktok/*) → 500 + SyncLog ERROR đúng kind, KHÔNG land", async () => {
    const res = await post("tiktok/statements", "100975192", STATEMENTS);
    expect(res.status).toBe(500);

    const logs = await prisma.syncLog.findMany();
    expect(logs[0].kind).toBe("TIKTOK_SHOP");
    expect(logs[0].status).toBe("ERROR");
    expect(await prisma.rawTiktokShopStatement.count()).toBe(0);
  });
});
