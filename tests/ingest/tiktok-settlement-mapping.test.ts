import { describe, expect, it } from "vitest";

import {
  epochToDate,
  mapAdsTxn,
  mapPayment,
  mapStatement,
  toIntMoney,
} from "@/lib/ingest/tiktok-settlement-mapping";

/**
 * Unit mapping Bronze TikTok → Silver "tiền đã về". Payload mẫu THẬT (scout).
 * Money STRING → Int (giữ dấu âm); epoch giây → instant; biên tháng theo giờ VN.
 */

const SHOP = "7494544063361551019";

describe("toIntMoney", () => {
  it("string/số → Int, giữ dấu âm, rỗng/null → 0", () => {
    expect(toIntMoney("162795")).toBe(162795);
    expect(toIntMoney("-143000")).toBe(-143000);
    expect(toIntMoney(1800000)).toBe(1800000);
    expect(toIntMoney("")).toBe(0);
    expect(toIntMoney(null)).toBe(0);
    expect(toIntMoney(undefined)).toBe(0);
  });
});

describe("epochToDate — biên tháng giờ VN [H2]", () => {
  it("epoch giây → instant đúng; 23:59 VN 30/06 = tháng 6, 00:01 VN 01/07 = tháng 7", () => {
    const eLateJune = Math.floor(new Date("2026-06-30T23:59:00+07:00").getTime() / 1000);
    const eEarlyJuly = Math.floor(new Date("2026-07-01T00:01:00+07:00").getTime() / 1000);
    const dJune = epochToDate(eLateJune)!;
    const dJuly = epochToDate(eEarlyJuly)!;
    expect(dJune.getTime()).toBe(eLateJune * 1000); // instant lossless
    // getMonth() dùng TZ máy chạy (container TZ=Asia/Ho_Chi_Minh) → biên đúng VN
    expect(dJune.getMonth()).toBe(5); // tháng 6
    expect(dJuly.getMonth()).toBe(6); // tháng 7
    expect(epochToDate(0)).toBeNull();
    expect(epochToDate(null)).toBeNull();
  });
});

describe("mapStatement", () => {
  it("statement chuẩn → net + breakdown; thiếu statement_time → null", () => {
    const p = {
      settlement_amount: "162795",
      revenue_amount: "230000",
      fee_amount: "-67205",
      adjustment_amount: "0",
      net_sales_amount: "162795",
      shipping_cost_amount: "0",
      statement_time: 1778803200,
      payment_time: 1778859287,
      payment_status: "SETTLED",
      payment_id: "3616084732377269931",
      currency: "VND",
    };
    const m = mapStatement("STMT1", SHOP, p)!;
    expect(m.statementId).toBe("STMT1");
    expect(m.settlementAmount).toBe(162795);
    expect(m.revenueAmount).toBe(230000);
    expect(m.feeAmount).toBe(-67205);
    expect(m.paymentId).toBe("3616084732377269931");
    expect(m.paymentStatus).toBe("SETTLED");
    expect(mapStatement("X", SHOP, { settlement_amount: "1" })).toBeNull(); // thiếu statement_time
  });
});

describe("mapAdsTxn", () => {
  it("ads txn → settlement âm giữ nguyên", () => {
    const p = {
      type: "GMV_PAYMENT_FOR_TIKTOK_ADS",
      order_id: null,
      adjustment_id: "3615386224338110123",
      order_create_time: "1778770412",
      settlement_amount: "-143000",
    };
    const m = mapAdsTxn("ADS1", SHOP, p)!;
    expect(m.transactionId).toBe("ADS1");
    expect(m.settlementAmount).toBe(-143000);
    expect(m.adjustmentId).toBe("3615386224338110123");
    expect(mapAdsTxn("X", SHOP, { settlement_amount: "-1" })).toBeNull(); // thiếu order_create_time
  });
});

describe("mapPayment", () => {
  it("payment {value} nested → settlementValue/amountValue Int", () => {
    const p = {
      status: "PAID",
      paid_time: 1783094255,
      amount: { value: "1800000", currency: "VND" },
      settlement_amount: { value: "1800000", currency: "VND" },
      reserve_amount: { value: "0", currency: "VND" },
      bank_account: "********4025",
    };
    const m = mapPayment("PAY1", SHOP, p)!;
    expect(m.status).toBe("PAID");
    expect(m.settlementValue).toBe(1800000);
    expect(m.amountValue).toBe(1800000);
    expect(m.reserveValue).toBe(0);
    expect(m.paidTime).not.toBeNull();
  });
});
