import { beforeEach, describe, expect, it } from "vitest";

// INGEST_SECRET phải set TRƯỚC khi gọi handler (requireIngestSecret đọc process.env lúc chạy).
const SECRET = "test-ingest-secret";
process.env.INGEST_SECRET = SECRET;

import { POST } from "@/app/api/ingest/ads/route";
import { prisma } from "@/lib/prisma";

/**
 * Trần thân `/api/ingest/ads` theo BYTE, áp TRƯỚC khi parse JSON. `ingestAdsBodySchema` chỉ chặn
 * `.max(2000)` SAU khi zod đã dựng xong cả mảng — body vài MB rác (cần `INGEST_SECRET`) đủ dựng
 * hàng trăm MB heap trước khi tới cổng đó. Trần phải đủ cho lô hợp lệ lớn nhất (2000 dòng).
 */

/** Phải khớp hằng trong route (file route Next chỉ được export handler nên không import được). */
const TRAN_BODY_ADS_BYTE = 1_000_000;

const AUTH = { "content-type": "application/json", authorization: `Bearer ${SECRET}` };

const goi = (body: BodyInit, headers: Record<string, string> = AUTH) =>
  POST(new Request("http://localhost/api/ingest/ads", { method: "POST", headers, body, duplex: "half" } as RequestInit));

/** Dòng chi tiêu "nặng" nhất hợp lý: tên chiến dịch dài tiếng Việt (đa byte). */
const dongNang = (i: number) => ({
  date: "2026-10-20",
  campaignId: String(1_864_314_018_521_233 + i),
  campaignName: "GMV Max - Váy đầm bé gái mùa thu đông — bộ sưu tập Hogikids 2026 ".repeat(2).trim(),
  spendExVat: 1_234_567,
  vatRate: 0.1,
  adType: "gmv_max" as const,
});

beforeEach(async () => {
  await prisma.syncLog.deleteMany({ where: { kind: { in: ["META_ADS", "TIKTOK_ADS"] } } });
});

describe("POST /api/ingest/ads — trần body theo byte", () => {
  it("lô hợp lệ lớn nhất (2000 dòng nặng) vẫn lọt dưới trần 1.000.000 byte", () => {
    const lo = JSON.stringify({ source: "TIKTOK_ADS", rows: Array.from({ length: 2000 }, (_, i) => dongNang(i)) });
    expect(new TextEncoder().encode(lo).byteLength).toBeLessThan(TRAN_BODY_ADS_BYTE);
  });

  it("body 1,2 MB (Content-Length khai thật) ⇒ 413, không SyncLog", async () => {
    const rac = JSON.stringify({ source: "META", rows: Array.from({ length: 13_000 }, () => ({ x: "y".repeat(90) })) });
    expect(new TextEncoder().encode(rac).byteLength).toBeGreaterThan(1_200_000);

    const res = await goi(rac, { ...AUTH, "content-length": String(new TextEncoder().encode(rac).byteLength) });

    expect(res.status).toBe(413);
    expect((await res.json()).error).toContain("vượt trần");
    expect(await prisma.syncLog.count({ where: { kind: { in: ["META_ADS", "TIKTOK_ADS"] } } })).toBe(0);
  });

  it("body 1,2 MB KHÔNG Content-Length (chunked) ⇒ 413", async () => {
    const chunk = new TextEncoder().encode("x".repeat(100_000));
    const luong = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode('{"source":"META","rows":[],"pad":"'));
        for (let i = 0; i < 12; i++) c.enqueue(chunk);
        c.enqueue(new TextEncoder().encode('"}'));
        c.close();
      },
    });

    const res = await goi(luong);

    expect(res.status).toBe(413);
  });

  it("JSON hỏng dưới trần ⇒ 400 như cũ", async () => {
    const res = await goi("{not json");
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid json");
  });
});
