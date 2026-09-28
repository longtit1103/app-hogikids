import { beforeEach, describe, expect, it, vi } from "vitest";

// INGEST_SECRET phải có TRƯỚC khi route chạy (requireIngestSecret đọc process.env lúc gọi).
const SECRET = "test-ingest-secret";
process.env.INGEST_SECRET = SECRET;

/**
 * `ngay` — trường CỘNG THÊM của hợp đồng `landRaw()` / `POST /api/ingest/raw`, dành cho stream mà
 * record KHÔNG mang trường ngày nào (analytics TikTok Shop: mỗi record là TỔNG cả cửa sổ). Thiếu
 * `ngay` thì khoá rút ra giống hệt nhau ở mọi cửa sổ ⇒ lượt hôm sau đè lượt hôm trước, chuỗi ngày
 * biến mất mà KHÔNG một dòng log nào đỏ.
 *
 * Hai lời khai suite này khoá:
 *  1. Với stream khai `chapNhanNgay`, `_ngay` được gắn vào record TRƯỚC khi rút khoá và trước khi
 *     băm ⇒ nó nằm TRONG `externalId`, TRONG `payload` lưu, và TRONG `payloadHash`.
 *  2. Với stream CŨ (không khai), hành vi không đổi MỘT BIT — khoá và hash phải trùng khít giá trị
 *     đo được trước khi có tham số này; và người gọi lỡ truyền `ngay` thì phải THROW chứ không được
 *     âm thầm đổi khoá của 45.480 dòng Bronze đang sống (append-only: land nhầm là nằm vĩnh viễn).
 *
 * VÌ SAO MOCK REGISTRY: 5 stream analytics thật (`tiktok/analytics_*`, `tiktokbusiness/gmvmax_item`)
 * và 5 bảng Bronze của chúng thuộc Task 4 — commit sau, có migration riêng. Suite này khoá CƠ CHẾ
 * trên đúng đường ghi thật (SQL thật, bảng Bronze thật, Postgres thật) bằng cách bật cờ
 * `chapNhanNgay` + `idExpr` ghép ngày cho một stream land-only đã có bảng (`tiktok/orders` — registry
 * ghi rõ "hôm nay không workflow nào populate"). Mock chỉ sống trong file này; Task 4 có suite riêng
 * chạy trên stream analytics thật.
 */
vi.mock("@/lib/bronze/streams", async (importOriginal) => {
  const goc = await importOriginal<typeof import("@/lib/bronze/streams")>();
  return {
    ...goc,
    BRONZE_STREAMS: {
      ...goc.BRONZE_STREAMS,
      "tiktok/orders": {
        ...goc.BRONZE_STREAMS["tiktok/orders"],
        chapNhanNgay: true,
        // Khoá ghép NGÀY + id — đúng khuôn Task 4 dùng cho analytics products/videos.
        idExpr: `(elem->>'_ngay') || ':' || (elem->>'id')`,
      },
    },
  };
});

import { POST } from "@/app/api/ingest/raw/route";
import { landRaw } from "@/lib/bronze/land-raw";
import { prisma } from "@/lib/prisma";

import { SHOP_TIKTOK_SHOP } from "../helpers/shop-ids-fixture";

/** Stream ĐÓNG THẾ cho analytics (đã bật `chapNhanNgay` ở mock trên). */
const STREAM_NGAY = "tiktok/orders";
/** Stream CŨ, KHÔNG khai `chapNhanNgay` — lưới hồi quy "không đổi một bit". */
const STREAM_CU = "tiktok/statements";

const TTS = (arrayKey: string, items: string, npt = "") =>
  `{"code":0,"message":"Success","data":{"${arrayKey}":[${items}],"next_page_token":"${npt}","total_count":2}}`;

const SP = (id: string, orders = 1) => `{"id":"${id}","total_performance":{"orders":${orders}}}`;

/** Statement THẬT (rút gọn) — dùng nguyên văn để so hash với giá trị đo TRƯỚC khi có `ngay`. */
const ST_1 = `{"id":"7639761649183852289","statement_time":1778803200,"settlement_amount":"159902","currency":"VND"}`;
/**
 * Hash đo được trên code TRƯỚC khi thêm tham số `ngay` (md5 của `elem::text` sau khi Postgres chuẩn
 * hoá jsonb). Đây là chốt "byte-identical": đổi một bit trong đường ghi của stream cũ — thêm khoá,
 * đổi thứ tự, bọc thêm một lớp jsonb — là con số này lệch ngay.
 */
const HASH_ST_1_TRUOC_KHI_CO_NGAY = "59487e08ef7d16ca255e49da592ec13f";

const post = (stream: string, shopId: string, payload: string, ngay?: string) =>
  POST(
    new Request("http://localhost/api/ingest/raw", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${SECRET}` },
      body: JSON.stringify(ngay === undefined ? { stream, shopId, payload } : { stream, shopId, payload, ngay }),
    })
  );

beforeEach(async () => {
  await prisma.rawTiktokShopOrder.deleteMany();
  await prisma.rawTiktokShopStatement.deleteMany();
  await prisma.syncLog.deleteMany();
});

describe("landRaw — tham số ngay", () => {
  it("`_ngay` vào khoá: cùng id, hai ngày ⇒ hai dòng", async () => {
    const body = TTS("orders", SP("1729557518640450219"));

    const r1 = await landRaw(STREAM_NGAY, SHOP_TIKTOK_SHOP, body, undefined, undefined, undefined, "2026-08-19");
    const r2 = await landRaw(STREAM_NGAY, SHOP_TIKTOK_SHOP, body, undefined, undefined, undefined, "2026-08-20");

    expect(r1.landedIds).toEqual(["2026-08-19:1729557518640450219"]);
    expect(r2.landedIds).toEqual(["2026-08-20:1729557518640450219"]);
    expect(r1.seenIds).toEqual(["2026-08-19:1729557518640450219"]);
    expect(await prisma.rawTiktokShopOrder.count()).toBe(2);
  });

  it("`_ngay` nằm TRONG payload lưu (nên cũng nằm trong hash)", async () => {
    await landRaw(STREAM_NGAY, SHOP_TIKTOK_SHOP, TTS("orders", SP("1")), undefined, undefined, undefined, "2026-08-19");

    const row = await prisma.rawTiktokShopOrder.findFirstOrThrow();
    expect((row.payload as Record<string, unknown>)._ngay).toBe("2026-08-19");
    // Trường gốc KHÔNG bị mất khi merge — `||` chỉ cộng khoá mới.
    expect((row.payload as Record<string, unknown>).id).toBe("1");
  });

  it("kéo lại CÙNG ngày + cùng nội dung ⇒ dedupe (không nhân bản chuỗi ngày)", async () => {
    const body = TTS("orders", SP("1"));
    const r1 = await landRaw(STREAM_NGAY, SHOP_TIKTOK_SHOP, body, undefined, undefined, undefined, "2026-08-19");
    const r2 = await landRaw(STREAM_NGAY, SHOP_TIKTOK_SHOP, body, undefined, undefined, undefined, "2026-08-19");

    expect(r1.landed).toBe(1);
    expect(r2.landed).toBe(0);
    // Lượt kéo lại vẫn THẤY khoá (đường tự chữa + cổng đối chứng `seen` của workflow).
    expect(r2.seenIds).toEqual(["2026-08-19:1"]);
    expect(await prisma.rawTiktokShopOrder.count()).toBe(1);
  });

  it("sàn chỉnh số hồi tố cùng ngày ⇒ land BẢN MỚI, giữ bản cũ", async () => {
    await landRaw(STREAM_NGAY, SHOP_TIKTOK_SHOP, TTS("orders", SP("1", 1)), undefined, undefined, undefined, "2026-08-19");
    const r2 = await landRaw(STREAM_NGAY, SHOP_TIKTOK_SHOP, TTS("orders", SP("1", 3)), undefined, undefined, undefined, "2026-08-19");

    expect(r2.landed).toBe(1);
    expect(await prisma.rawTiktokShopOrder.count()).toBe(2);
  });

  it("stream khai chapNhanNgay mà THIẾU ngay ⇒ THROW (không land khoá cụt)", async () => {
    await expect(
      landRaw(STREAM_NGAY, SHOP_TIKTOK_SHOP, TTS("orders", SP("1")))
    ).rejects.toThrow(/chapNhanNgay|thiếu 'ngay'/i);
    expect(await prisma.rawTiktokShopOrder.count()).toBe(0);
  });

  it("stream KHÔNG khai mà truyền ngay ⇒ THROW (không đổi khoá của stream đang chạy)", async () => {
    await expect(
      landRaw(STREAM_CU, SHOP_TIKTOK_SHOP, TTS("statements", ST_1), undefined, undefined, undefined, "2026-08-19")
    ).rejects.toThrow(/không nhận 'ngay'/i);
    expect(await prisma.rawTiktokShopStatement.count()).toBe(0);
  });

  it("ngay sai định dạng ⇒ THROW", async () => {
    await expect(
      landRaw(STREAM_NGAY, SHOP_TIKTOK_SHOP, TTS("orders", SP("1")), undefined, undefined, undefined, "19/08/2026")
    ).rejects.toThrow(/YYYY-MM-DD/);
    expect(await prisma.rawTiktokShopOrder.count()).toBe(0);
  });

  it("HỒI QUY stream cũ: khoá + hash + payload không đổi MỘT BIT", async () => {
    const r = await landRaw(STREAM_CU, SHOP_TIKTOK_SHOP, TTS("statements", ST_1));

    expect(r.landed).toBe(1);
    expect(r.landedIds).toEqual(["7639761649183852289"]);
    expect(r.seenIds).toEqual(["7639761649183852289"]);

    const row = await prisma.rawTiktokShopStatement.findFirstOrThrow();
    expect(row.externalId).toBe("7639761649183852289");
    expect(row.payloadHash).toBe(HASH_ST_1_TRUOC_KHI_CO_NGAY);
    expect(Object.hasOwn(row.payload as object, "_ngay")).toBe(false);
  });
});

describe("POST /api/ingest/raw — cổng 'ngay' + con số 'seen'", () => {
  it("400 khi ngay sai khuôn YYYY-MM-DD", async () => {
    const res = await post(STREAM_NGAY, SHOP_TIKTOK_SHOP, TTS("orders", SP("1")), "19/08/2026");

    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/YYYY-MM-DD/);
    expect(await prisma.rawTiktokShopOrder.count()).toBe(0);
  });

  it("400 khi gửi ngay cho stream KHÔNG khai chapNhanNgay", async () => {
    const res = await post(STREAM_CU, SHOP_TIKTOK_SHOP, TTS("statements", ST_1), "2026-08-19");

    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/không nhận 'ngay'/i);
    expect(await prisma.rawTiktokShopStatement.count()).toBe(0);
  });

  it("400 khi stream khai chapNhanNgay mà THIẾU ngay", async () => {
    const res = await post(STREAM_NGAY, SHOP_TIKTOK_SHOP, TTS("orders", SP("1")));

    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/BẮT BUỘC có 'ngay'/);
    expect(await prisma.rawTiktokShopOrder.count()).toBe(0);
  });

  it("200 + trả `seen` để workflow đối chứng Σ record với total_count", async () => {
    const body = TTS("orders", `${SP("1")},${SP("2")}`);

    const res1 = await post(STREAM_NGAY, SHOP_TIKTOK_SHOP, body, "2026-08-19");
    expect(res1.status).toBe(200);
    const j1 = await res1.json();
    expect(j1.stats.landed).toBe(2);
    expect(j1.stats.seen).toBe(2);

    // Kéo LẠI cùng trang: `landed` về 0 (trùng hash) nhưng `seen` vẫn đủ 2 — đúng lý do cổng đối
    // chứng của workflow KHÔNG được dùng `landed`.
    const res2 = await post(STREAM_NGAY, SHOP_TIKTOK_SHOP, body, "2026-08-19");
    const j2 = await res2.json();
    expect(j2.stats.landed).toBe(0);
    expect(j2.stats.seen).toBe(2);
  });
});
