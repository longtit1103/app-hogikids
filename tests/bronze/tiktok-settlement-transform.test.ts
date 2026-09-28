import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { transformFromRaw } from "@/lib/bronze/transform-from-raw";
import { prisma } from "@/lib/prisma";

/**
 * Integration transform Bronze TikTok → Silver "tiền đã về" (`hogikids_test`).
 * Bất biến kiểm: idempotent; ads nhận diện CROSS-VERSION (C2 — bản latest mất
 * `type` vẫn bắt); shopId TikTok Shop; không đụng bảng khác.
 */

const SHOP = "7494544063361551019";

async function cleanup(): Promise<void> {
  await prisma.tiktokSettlement.deleteMany({});
  await prisma.tiktokAdsSettlement.deleteMany({});
  await prisma.tiktokPayment.deleteMany({});
  await prisma.rawTiktokShopStatement.deleteMany({});
  await prisma.rawTiktokShopTransaction.deleteMany({});
  await prisma.rawTiktokShopPayment.deleteMany({});
}

beforeEach(cleanup);
afterAll(async () => {
  await cleanup();
  await prisma.$disconnect();
});

describe("transform tiktok/statements", () => {
  it("statement → TiktokSettlement đúng số + idempotent", async () => {
    await prisma.rawTiktokShopStatement.create({
      data: {
        shopId: SHOP,
        externalId: "STMT1",
        payloadHash: "h1",
        payload: {
          settlement_amount: "162795",
          revenue_amount: "230000",
          fee_amount: "-67205",
          adjustment_amount: "0",
          net_sales_amount: "162795",
          shipping_cost_amount: "0",
          statement_time: 1778803200,
          payment_status: "SETTLED",
          payment_id: "PAY1",
        },
      },
    });
    const w: string[] = [];
    await transformFromRaw("tiktok/statements", w);
    await transformFromRaw("tiktok/statements", w); // chạy 2 lần

    const rows = await prisma.tiktokSettlement.findMany();
    expect(rows).toHaveLength(1); // idempotent
    expect(rows[0].settlementAmount).toBe(162795);
    expect(rows[0].feeAmount).toBe(-67205);
    expect(rows[0].paymentId).toBe("PAY1");
  });
});

describe("transform tiktok/statement_transactions — ads cross-version [C2]", () => {
  it("record ads có 2 version, bản MỚI NHẤT mất `type` → VẪN nhận là ads", async () => {
    // version cũ: có type=ads
    await prisma.rawTiktokShopTransaction.create({
      data: {
        shopId: SHOP,
        externalId: "ADS_STRIP",
        payloadHash: "old",
        fetchedAt: new Date("2026-07-14T14:22:57Z"),
        payload: {
          type: "GMV_PAYMENT_FOR_TIKTOK_ADS",
          order_create_time: "1778770412",
          settlement_amount: "-143000",
          adjustment_id: "ADJ1",
        },
      },
    });
    // version mới nhất: RỚT field type (TikTok re-fetch)
    await prisma.rawTiktokShopTransaction.create({
      data: {
        shopId: SHOP,
        externalId: "ADS_STRIP",
        payloadHash: "new",
        fetchedAt: new Date("2026-07-15T19:02:19Z"),
        payload: { order_create_time: "1778770412", settlement_amount: "-143000", adjustment_id: "ADJ1" },
      },
    });
    // 1 txn KHÔNG ads (type=ORDER) → không được vào ads
    await prisma.rawTiktokShopTransaction.create({
      data: {
        shopId: SHOP,
        externalId: "ORDER_TXN",
        payloadHash: "o1",
        payload: { type: "ORDER", order_create_time: "1778770412", settlement_amount: "500000" },
      },
    });

    const w: string[] = [];
    await transformFromRaw("tiktok/statement_transactions", w);

    const ads = await prisma.tiktokAdsSettlement.findMany();
    expect(ads).toHaveLength(1); // ADS_STRIP nhận đủ dù latest mất type; ORDER_TXN loại
    expect(ads[0].transactionId).toBe("ADS_STRIP");
    expect(ads[0].settlementAmount).toBe(-143000); // âm giữ nguyên
  });
});

describe("transform tiktok/payments", () => {
  it("payment {value} → TiktokPayment", async () => {
    await prisma.rawTiktokShopPayment.create({
      data: {
        shopId: SHOP,
        externalId: "PAY1",
        payloadHash: "p1",
        payload: {
          status: "PAID",
          paid_time: 1783094255,
          amount: { value: "1800000" },
          settlement_amount: { value: "1800000" },
          reserve_amount: { value: "0" },
        },
      },
    });
    const w: string[] = [];
    await transformFromRaw("tiktok/payments", w);
    const rows = await prisma.tiktokPayment.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0].settlementValue).toBe(1800000);
    expect(rows[0].status).toBe("PAID");
  });

  it("payment PAID mà THIẾU paid_time → vẫn ghi Silver nhưng CẢNH BÁO to (không rơi câm khỏi 'Đã rút về bank')", async () => {
    // Card "Đã rút về bank" lọc `status=PAID AND paidTime ∈ kỳ` — paidTime NULL bị filter ngày
    // loại ở MỌI kỳ, tức lệnh rút biến mất khỏi hiển thị mà không ai biết. Giữ dòng (dữ liệu
    // thật), nhưng lượt transform phải kêu để nhật ký đồng bộ lộ ra ngay.
    await prisma.rawTiktokShopPayment.create({
      data: {
        shopId: SHOP,
        externalId: "PAY_THIEU_NGAY",
        payloadHash: "p2",
        payload: {
          status: "PAID",
          amount: { value: "500000" },
          settlement_amount: { value: "500000" },
          reserve_amount: { value: "0" },
        },
      },
    });
    const w: string[] = [];
    await transformFromRaw("tiktok/payments", w);

    const row = await prisma.tiktokPayment.findUnique({ where: { paymentId: "PAY_THIEU_NGAY" } });
    expect(row).not.toBeNull();
    expect(row?.paidTime).toBeNull();
    expect(w.some((c) => c.includes("PAY_THIEU_NGAY") && /paid_time/.test(c))).toBe(true);
  });
});
