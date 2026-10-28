import { describe, expect, it } from "vitest";

import {
  docTienBatBuoc,
  docTienTuyChon,
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

/**
 * Tiền KHÔNG đọc được khác tiền BẰNG 0. Shape payload trôi (chuỗi lạ, field biến mất) mà mapping
 * vẫn đổi thành 0 thì lượt kéo lại GHI ĐÈ số đúng trong Silver bằng 0 — "Đã rút về bank" và quỹ hụt
 * đúng số đó, không backlog, SyncLog xanh. Mapping phải TỪ CHỐI để Silver cũ còn nguyên.
 */
describe("docTienBatBuoc / docTienTuyChon — tiền hỏng không thành 0", () => {
  it("bắt buộc: số/chuỗi số → Int giữ dấu; thiếu/rỗng/khoảng trắng/không phải số → null", () => {
    expect(docTienBatBuoc("1800000")).toBe(1800000);
    expect(docTienBatBuoc("-143000")).toBe(-143000);
    expect(docTienBatBuoc("0")).toBe(0);
    expect(docTienBatBuoc(0)).toBe(0);
    expect(docTienBatBuoc(162795.4)).toBe(162795);
    expect(docTienBatBuoc(undefined)).toBeNull();
    expect(docTienBatBuoc(null)).toBeNull();
    expect(docTienBatBuoc("")).toBeNull();
    expect(docTienBatBuoc("   ")).toBeNull(); // Number("   ") = 0 — bẫy kinh điển
    expect(docTienBatBuoc("not-money")).toBeNull();
    expect(docTienBatBuoc(Number.NaN)).toBeNull();
    expect(docTienBatBuoc(true)).toBeNull();
    expect(docTienBatBuoc({ value: "1" })).toBeNull(); // object chưa bóc `value` không phải tiền
  });

  it("tuỳ chọn: thiếu → 0; có mà hỏng → null (không đoán 0 thay sàn)", () => {
    expect(docTienTuyChon(undefined)).toBe(0);
    expect(docTienTuyChon(null)).toBe(0);
    expect(docTienTuyChon("")).toBe(0);
    expect(docTienTuyChon("250000")).toBe(250000);
    expect(docTienTuyChon("not-money")).toBeNull();
    expect(docTienTuyChon(false)).toBeNull();
  });
});

describe("mapPayment — tiền rút về bank bắt buộc đọc được", () => {
  const goc = {
    status: "PAID",
    paid_time: 1783094255,
    amount: { value: "1800000", currency: "VND" },
    settlement_amount: { value: "1800000", currency: "VND" },
    reserve_amount: { value: "0", currency: "VND" },
  };

  it("settlement_amount.value không phải số ⇒ TỪ CHỐI (null), không ghi 0", () => {
    expect(mapPayment("PAY-HONG", SHOP, { ...goc, settlement_amount: { value: "not-money", currency: "VND" } })).toBeNull();
  });

  it("PAID thiếu settlement_amount (cả object hoặc chỉ value) ⇒ TỪ CHỐI", () => {
    const khongTien = { status: goc.status, paid_time: goc.paid_time, amount: goc.amount };
    expect(mapPayment("PAY-THIEU", SHOP, khongTien)).toBeNull();
    expect(mapPayment("PAY-THIEU-VALUE", SHOP, { ...goc, settlement_amount: { currency: "VND" } })).toBeNull();
  });
  it("CHƯA PAID (PROCESSING/FAILED) thiếu settlement_amount ⇒ vẫn nhận, tiền về bank = 0 (không vào Sổ quỹ); có mà hỏng vẫn từ chối", () => {
    const { settlement_amount: _bo, ...khongTien } = goc;
    void _bo;
    for (const status of ["PROCESSING", "FAILED"]) {
      const m = mapPayment("PAY-CHUA-PAID", SHOP, { ...khongTien, status });
      expect(m?.settlementValue).toBe(0);
      expect(m?.status).toBe(status);
      expect(mapPayment("PAY-CHUA-PAID-HONG", SHOP, { ...goc, status, settlement_amount: { value: "x", currency: "VND" } })).toBeNull();
    }
  });

  it('"0" là số 0 THẬT ⇒ ghi 0 (không nhầm với thiếu)', () => {
    const m = mapPayment("PAY-0", SHOP, { ...goc, settlement_amount: { value: "0", currency: "VND" } });
    expect(m).not.toBeNull();
    expect(m!.settlementValue).toBe(0);
  });

  it("thiếu amount/reserve_amount (tuỳ chọn) ⇒ 0, vẫn nhận lệnh rút", () => {
    const m = mapPayment("PAY-GON", SHOP, { status: "PAID", paid_time: 1783094255, settlement_amount: { value: "1800000" } });
    expect(m).not.toBeNull();
    expect(m!.settlementValue).toBe(1800000);
    expect(m!.amountValue).toBe(0);
    expect(m!.reserveValue).toBe(0);
  });

  it("amount/reserve CÓ mặt mà hỏng ⇒ TỪ CHỐI (shape đã trôi, không tin nửa bản ghi)", () => {
    expect(mapPayment("PAY-AMT", SHOP, { ...goc, amount: { value: "abc" } })).toBeNull();
    expect(mapPayment("PAY-RES", SHOP, { ...goc, reserve_amount: { value: "abc" } })).toBeNull();
  });
});

describe("mapAdsTxn — khoản ads TikTok trừ ví bắt buộc có tiền", () => {
  const goc = { type: "GMV_PAYMENT_FOR_TIKTOK_ADS", order_create_time: "1778770412", settlement_amount: "-143000" };

  it("thiếu settlement_amount ⇒ TỪ CHỐI (không ghi khoản trừ 0đ)", () => {
    expect(mapAdsTxn("ADS-THIEU", SHOP, { type: goc.type, order_create_time: goc.order_create_time })).toBeNull();
  });

  it("settlement_amount không phải số ⇒ TỪ CHỐI", () => {
    expect(mapAdsTxn("ADS-HONG", SHOP, { ...goc, settlement_amount: "not-money" })).toBeNull();
  });

  it('"0" ⇒ ghi 0', () => {
    expect(mapAdsTxn("ADS-0", SHOP, { ...goc, settlement_amount: "0" })!.settlementAmount).toBe(0);
  });
});
