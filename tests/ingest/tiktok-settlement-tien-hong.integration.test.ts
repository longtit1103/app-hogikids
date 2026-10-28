import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

// INGEST_SECRET phải set TRƯỚC khi import route (requireIngestSecret đọc process.env lúc chạy).
const SECRET = "test-ingest-secret";
process.env.INGEST_SECRET = SECRET;

import { POST } from "@/app/api/ingest/raw/route";
import { prisma } from "@/lib/prisma";

import { SHOP_TIKTOK_SHOP } from "../helpers/shop-ids-fixture";
import { seedReference, truncateBusinessTables } from "../helpers/test-db";

/**
 * Lượt kéo lại TikTok Shop mang field tiền HỎNG (chuỗi lạ / mất field) — payload khác hash nên land
 * thành bản MỚI NHẤT trong Bronze, rồi transform đọc đúng bản đó. Trước đây mapping đổi tiền hỏng
 * thành 0 và upsert ĐÈ số đúng: "Đã rút về bank" + Sổ quỹ hụt đúng số tiền đó mà SyncLog vẫn OK.
 *
 * Kỳ vọng: bản hỏng bị TỪ CHỐI ở mapping, Silver giữ nguyên số cũ, SyncLog ERROR (HTTP vẫn 200 để
 * n8n không thử lại và các trang sau vẫn được gửi), cờ backlog bật.
 */

const PAY_ID = "3616084732377269931";
const trangPayment = (settlement: string) =>
  `{"code":0,"message":"Success","data":{"payments":[{"id":"${PAY_ID}","status":"PAID",` +
  `"paid_time":1783094255,"amount":{"value":"1800000","currency":"VND"},` +
  `"settlement_amount":${settlement},"reserve_amount":{"value":"0","currency":"VND"},` +
  `"bank_account":"********0000"}]}}`;

const TX_ID = "7646274335216338706";
const trangAds = (tien: string | null) =>
  `{"code":0,"message":"Success","data":{"transactions":[{"id":"${TX_ID}",` +
  `"type":"GMV_PAYMENT_FOR_TIKTOK_ADS","adjustment_id":"3626821605450483371",` +
  `"order_create_time":1778770412${tien === null ? "" : `,"settlement_amount":${tien}`}}]}}`;

const post = (stream: string, payload: string) =>
  POST(
    new Request("http://localhost/api/ingest/raw", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${SECRET}` },
      body: JSON.stringify({ stream, shopId: SHOP_TIKTOK_SHOP, payload }),
    })
  );

const backlogFlag = async (): Promise<string | null> =>
  (await prisma.setting.findUnique({ where: { key: "bronzeBacklogPending" } }))?.value ?? null;

const logMoiNhat = () => prisma.syncLog.findFirst({ orderBy: { startedAt: "desc" } });

const donBang = async () => {
  await prisma.rawTiktokShopPayment.deleteMany();
  await prisma.rawTiktokShopTransaction.deleteMany();
  await prisma.tiktokPayment.deleteMany();
  await prisma.tiktokAdsSettlement.deleteMany();
  await prisma.setting.deleteMany({ where: { key: "bronzeBacklogPending" } });
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

describe("POST /api/ingest/raw — tiền TikTok Shop hỏng không đè Silver", () => {
  it("payment kéo lại với settlement_amount 'not-money' ⇒ Silver GIỮ 1.800.000, SyncLog ERROR, backlog bật", async () => {
    const r1 = await post("tiktok/payments", trangPayment(`{"value":"1800000","currency":"VND"}`));
    expect(r1.status).toBe(200);
    expect((await prisma.tiktokPayment.findUniqueOrThrow({ where: { paymentId: PAY_ID } })).settlementValue).toBe(
      1_800_000
    );

    const r2 = await post("tiktok/payments", trangPayment(`{"value":"not-money","currency":"VND"}`));
    const json = await r2.json();

    expect(r2.status).toBe(200);
    expect(json.stats.landed).toBe(1); // bản hỏng VẪN nằm ở Bronze (giữ bằng chứng)
    expect(json.stats.skipped).toBe(1);
    expect(json.loiSauKhiGhi).toContain("tiktok/payments");
    const silver = await prisma.tiktokPayment.findUniqueOrThrow({ where: { paymentId: PAY_ID } });
    expect(silver.settlementValue).toBe(1_800_000); // KHÔNG bị đè thành 0
    expect((await logMoiNhat())?.status).toBe("ERROR");
    expect(await backlogFlag()).toBe("1");
  });

  it('payment "0" là số thật ⇒ ghi 0, SyncLog OK', async () => {
    const res = await post("tiktok/payments", trangPayment(`{"value":"0","currency":"VND"}`));
    expect(res.status).toBe(200);
    expect((await prisma.tiktokPayment.findUniqueOrThrow({ where: { paymentId: PAY_ID } })).settlementValue).toBe(0);
    expect((await logMoiNhat())?.status).toBe("OK");
  });

  it("khoản ads trừ ví kéo lại MẤT settlement_amount ⇒ Silver giữ −143.000, SyncLog ERROR", async () => {
    await post("tiktok/statement_transactions", trangAds(`"-143000"`));
    expect(
      (await prisma.tiktokAdsSettlement.findUniqueOrThrow({ where: { transactionId: TX_ID } })).settlementAmount
    ).toBe(-143_000);

    const res = await post("tiktok/statement_transactions", trangAds(null));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.stats.skipped).toBe(1);
    expect(
      (await prisma.tiktokAdsSettlement.findUniqueOrThrow({ where: { transactionId: TX_ID } })).settlementAmount
    ).toBe(-143_000);
    expect((await logMoiNhat())?.status).toBe("ERROR");
    expect(await backlogFlag()).toBe("1");
  });
});
