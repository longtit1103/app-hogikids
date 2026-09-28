import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

// INGEST_SECRET phải set TRƯỚC khi import route (requireIngestSecret đọc process.env lúc chạy).
const SECRET = "test-ingest-secret";
process.env.INGEST_SECRET = SECRET;

import { POST } from "@/app/api/ingest/raw/route";
import { prisma } from "@/lib/prisma";

import { seedReference, truncateBusinessTables } from "../helpers/test-db";

/**
 * Chế độ BRONZE_ONLY: raw vẫn land, Silver ĐỨNG YÊN.
 * Dùng khi định nghĩa Silver chưa chốt — kéo dữ liệu về trước, dựng bảng nghiệp vụ sau.
 */

const ORDER = `{
  "id":"ORD-BO-1","status":3,"inserted_at":"2026-07-01T10:00:00.000000",
  "order_sources_name":"Shopee","marketplace_id":"-3",
  "total_price":200000,"total_discount":0,"fee_marketplace":15000,
  "items":[{"quantity":2,"discount_each_product":0,
    "variation_info":{"display_id":"SKU-T1","name":"SP","retail_price":100000}}]}`;

const post = () =>
  POST(
    new Request("http://localhost/api/ingest/raw", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${SECRET}` },
      body: JSON.stringify({
        stream: "orders",
        shopId: "1942992175",
        payload: `{"success":true,"data":[${ORDER}]}`,
      }),
    })
  );

beforeAll(async () => {
  await seedReference();
}, 60_000);

beforeEach(async () => {
  await truncateBusinessTables();
  await prisma.rawPancakeOrder.deleteMany();
  // Cờ backlog (xem src/lib/bronze/bronze-only.ts BACKLOG_KEY) sống trong bảng Setting,
  // ngoài phạm vi truncateBusinessTables() — không xoá thì cờ sống sót giữa các lần chạy
  // và test backlog bên dưới có thể pass vì lý do sai (cờ cũ còn đó, không phải test vừa bật).
  await prisma.setting.deleteMany({ where: { key: "bronzeBacklogPending" } });
  delete process.env.BRONZE_ONLY;
});

afterEach(() => {
  delete process.env.BRONZE_ONLY;
});

describe("BRONZE_ONLY", () => {
  it("bật ⇒ Bronze có dòng mới, Silver KHÔNG đổi", async () => {
    process.env.BRONZE_ONLY = "true";

    const res = await post();
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.stats.mode).toBe("bronze-only");
    expect(await prisma.rawPancakeOrder.count()).toBe(1); // raw ĐÃ land
    expect(await prisma.order.count()).toBe(0); // Silver đứng yên
  });

  it("KHÔNG set ⇒ hành vi cũ y nguyên (land + transform)", async () => {
    const res = await post();
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.stats.mode).toBe("land+transform");
    expect(await prisma.rawPancakeOrder.count()).toBe(1);
    expect(await prisma.order.findUnique({ where: { pancakeId: "ORD-BO-1" } })).not.toBeNull();
  });

  // "false" là chuỗi TRUTHY trong JS — ép boolean sẽ bật nhầm chế độ và Silver ngừng cập nhật âm thầm.
  it.each(["false", "0", "no", ""])("BRONZE_ONLY=%j ⇒ vẫn transform (không dính bẫy truthy)", async (v) => {
    process.env.BRONZE_ONLY = v;

    const json = await (await post()).json();

    expect(json.stats.mode).toBe("land+transform");
    expect(await prisma.order.count()).toBe(1);
  });

  it("bật ⇒ Silver dựng lại được từ Bronze sau đó (không mất dữ liệu)", async () => {
    process.env.BRONZE_ONLY = "true";
    await post();
    expect(await prisma.order.count()).toBe(0);

    // Cùng payload, chạy lại ở chế độ thường: raw trùng hash (landed=0) nhưng Silver phải dựng được.
    delete process.env.BRONZE_ONLY;
    const { transformFromRaw } = await import("@/lib/bronze/transform-from-raw");
    const stats = await transformFromRaw("orders", []);

    expect(stats.ordersUpserted).toBe(1);
    expect(await prisma.order.findUnique({ where: { pancakeId: "ORD-BO-1" } })).not.toBeNull();
  });

  /**
   * Lỗ hổng MẤT DOANH THU ÂM THẦM (nay đã bịt): đơn land lúc chỉ-land, khi tắt công tắc kéo lại
   * sẽ TRÙNG HASH ⇒ không land lại ⇒ transform theo trang dựng 0 dòng. Đơn "yên vị" không bao giờ
   * vào Silver mà SyncLog vẫn OK.
   *
   * Dòng Bronze land trong đợt chỉ-land nằm ở trạng thái "chưa xong" (chưa đóng dấu kết cục), nên
   * lượt kéo lại nhận ra và dựng nốt — dù `landed` vẫn là 0. Cờ backlog toàn cục vẫn kêu cho tới
   * khi rebuild toàn bảng chạy: nó nói "có thể còn thứ khác chưa dựng" (stream khác, trang khác),
   * còn dấu theo từng dòng mới trả lời chính xác cho từng đơn.
   */
  it("tắt công tắc sau đợt chỉ-land ⇒ lượt kéo lại TỰ DỰNG NỐT, vẫn giữ cảnh báo backlog", async () => {
    process.env.BRONZE_ONLY = "true";
    await post();

    delete process.env.BRONZE_ONLY;
    const json = await (await post()).json(); // kéo lại đúng đơn đó: hash trùng

    expect(json.stats.landed).toBe(0); // dedupe → KHÔNG land lại
    expect(await prisma.order.count()).toBe(1); // nhưng đơn ĐÃ vào Silver: bẫy đã đóng
    expect(json.stats.warnings.some((w: string) => w.includes("BACKLOG"))).toBe(true);
  });

  it("rebuild toàn bảng ⇒ Silver bù xong, hết cảnh báo backlog", async () => {
    process.env.BRONZE_ONLY = "true";
    await post();
    delete process.env.BRONZE_ONLY;

    const { rebuildFromRaw } = await import("@/lib/bronze/rebuild");
    const stats = await rebuildFromRaw([]);
    expect(stats.ordersUpserted).toBe(1);

    const json = await (await post()).json();
    expect(json.stats.warnings.some((w: string) => w.includes("BACKLOG"))).toBe(false);
  });
});
