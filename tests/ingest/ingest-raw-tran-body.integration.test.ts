import { beforeAll, beforeEach, describe, expect, it } from "vitest";

// INGEST_SECRET phải set TRƯỚC khi import route (requireIngestSecret đọc process.env lúc chạy).
const SECRET = "test-ingest-secret";
process.env.INGEST_SECRET = SECRET;

import { POST } from "@/app/api/ingest/raw/route";
import { prisma } from "@/lib/prisma";

import { SHOP_TIKTOK } from "../helpers/shop-ids-fixture";
import { seedReference, truncateBusinessTables } from "../helpers/test-db";

/**
 * Trần thân request `/api/ingest/raw` — 10MB theo BYTE UTF-8, áp TRƯỚC khi đọc trọn body.
 *
 * Vượt trần ⇒ 413, không dựng body vào RAM, không đụng DB (không SyncLog, không Bronze). Hợp lệ ⇒
 * text tới tầng land Y HỆT byte n8n gửi, kể cả khi body tới theo nhiều chunk và ký tự tiếng Việt
 * (đa byte) bị chẻ giữa hai chunk — int64 trong payload phải giữ nguyên từng chữ số.
 */
const TRAN = 10_000_000;
const AUTH = { "content-type": "application/json", authorization: `Bearer ${SECRET}` };

const luong = (chunks: Uint8Array[]): ReadableStream<Uint8Array> =>
  new ReadableStream<Uint8Array>({
    start(c) {
      for (const ch of chunks) c.enqueue(ch);
      c.close();
    },
  });

/** `duplex` bắt buộc khi body là ReadableStream (undici) — chưa có trong kiểu RequestInit của lib.dom. */
const goi = (body: BodyInit, headers: Record<string, string> = AUTH) =>
  POST(new Request("http://localhost/api/ingest/raw", { method: "POST", headers, body, duplex: "half" } as RequestInit));

beforeAll(async () => {
  await seedReference();
}, 60_000);

beforeEach(async () => {
  await truncateBusinessTables();
  await prisma.syncLog.deleteMany();
  await prisma.rawPancakeOrder.deleteMany();
});

describe("POST /api/ingest/raw — trần body theo byte", () => {
  it("Content-Length khai 10MB+1 ⇒ 413, không SyncLog, không Bronze", async () => {
    const body = JSON.stringify({ stream: "orders", shopId: SHOP_TIKTOK, payload: "x".repeat(TRAN) });
    const res = await goi(body, { ...AUTH, "content-length": String(TRAN + 1) });

    expect(res.status).toBe(413);
    expect((await res.json()).error).toContain("vượt trần");
    expect(await prisma.syncLog.count()).toBe(0);
    expect(await prisma.rawPancakeOrder.count()).toBe(0);
  });

  it("KHÔNG có Content-Length (chunked) mà body 10MB+1 byte ⇒ 413, không SyncLog", async () => {
    const vo = new TextEncoder().encode(`{"stream":"orders","shopId":"${SHOP_TIKTOK}","payload":"`);
    const duoi = new TextEncoder().encode(`"}`);
    const giua = new Uint8Array(TRAN + 1 - vo.length - duoi.length).fill(0x78); // 'x'
    const res = await goi(luong([vo, giua, duoi]));

    expect(res.status).toBe(413);
    expect(await prisma.syncLog.count()).toBe(0);
  });

  it("body hợp lệ tới theo TỪNG BYTE ⇒ land đúng nguyên văn (tiếng Việt + int64)", async () => {
    const ID = "585140898791786238";
    const TEN = "Chị Hoà — bé gái 🎀";
    const payload =
      `{"success":true,"data":[{"id":"${ID}","system_id":"${ID}","partner_id":585140898791786238,` +
      `"status":3,"status_name":"x","inserted_at":"2026-07-01T10:00:00.000000",` +
      `"updated_at":"2026-07-01T12:00:00.000000","status_history":[],` +
      `"order_sources_name":"Tiktok","marketplace_id":"-9","total_price":200000,"total_discount":0,` +
      `"shipping_fee":0,"fee_marketplace":5839,"advanced_platform_fee":{"payment_fee":0},` +
      `"customer":{"name":"${TEN}"},"items":[{"quantity":2,"discount_each_product":0,` +
      `"variation_info":{"display_id":"SKU-TRAN-1","name":"Áo thun","retail_price":100000}}]}]}`;
    const bytes = new TextEncoder().encode(JSON.stringify({ stream: "orders", shopId: SHOP_TIKTOK, payload }));
    const res = await goi(luong(Array.from(bytes, (b) => Uint8Array.of(b))));

    expect(res.status, await res.clone().text()).toBe(200);
    const [dong] = await prisma.$queryRaw<{ id: string; ten: string; partner: string }[]>`
      SELECT "externalId" AS id, payload->'customer'->>'name' AS ten, payload->>'partner_id' AS partner
      FROM "RawPancakeOrder"`;
    expect(dong).toEqual({ id: ID, ten: TEN, partner: "585140898791786238" });
  });

  it("JSON hợp lệ nhưng không phải object (null) ⇒ 400 invalid json, không nổ 500", async () => {
    const res = await goi("null");
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid json");
  });
});
