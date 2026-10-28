import { describe, expect, it } from "vitest";

import {
  mapHoaDonTiktok,
  thoiDiemHoaDon,
  tienKhongMat,
  type TruongHoaDonTho,
} from "@/lib/ingest/tiktok-ads-hoa-don-mapping";

/**
 * Unit mapping Bronze hoá đơn quảng cáo TikTok → Silver `TiktokAdsHoaDon`. Đầu vào là bản đồ trường CHUỖI (SQL
 * rút từ jsonb) — shape theo hoá đơn thật Business Center: `create_time` giờ ad account + `timezone` "UTC+07:00",
 * tiền chuỗi/số, `transaction_id` có thể ghép "A|B", một số hoá đơn thiếu `invoice_id`.
 */

const BC = "7129545797879726081";

const hoaDon = (them: Partial<Record<string, string | null>> = {}): TruongHoaDonTho => ({
  transaction_id: "7657315630890860807",
  transaction_type: "BILL_PAYMENT",
  billing_type: "CASH",
  amount_type: "POSITIVE",
  account_id: "7129548444015902722",
  bc_id: BC,
  subtotal: "130000",
  tax_amount: "13000",
  amount: "143000",
  currency: "VND",
  invoice_id: "7657322667854365458",
  create_time: "2026-10-23 15:38:00",
  timezone: "UTC+07:00",
  payment_portfolio_id: "7553366094925204945",
  ...them,
});

describe("tienKhongMat — chuỗi tiền → Int lossless", () => {
  it("số nguyên chuỗi, đuôi .0 (jsonb giữ nguyên) ⇒ Int", () => {
    expect(tienKhongMat("143000", "amount")).toEqual({ ok: true, so: 143_000 });
    expect(tienKhongMat("143000.00", "amount")).toEqual({ ok: true, so: 143_000 });
    expect(tienKhongMat("0", "amount")).toEqual({ ok: true, so: 0 });
  });

  it("phần lẻ khác 0 / âm / rác / thiếu / vượt INTEGER ⇒ lý do, KHÔNG ép 0 hay làm tròn", () => {
    for (const v of ["143000.5", "-143000", "143,000", "abc", "1e5", "", null, undefined, "2147483648"]) {
      const r = tienKhongMat(v, "amount");
      expect(r.ok, `giá trị ${String(v)}`).toBe(false);
    }
  });
});

describe("thoiDiemHoaDon — create_time + timezone ⇒ instant thật", () => {
  it("UTC+07:00 ⇒ đúng instant (15:38 VN = 08:38Z)", () => {
    const r = thoiDiemHoaDon("2026-10-23 15:38:00", "UTC+07:00");
    expect(r).toEqual({ ok: true, luc: new Date("2026-10-23T08:38:00.000Z") });
  });

  it("biên ngày VN: 23:59:59 VN 31/10 vẫn là 31/10 (16:59:59Z), không trôi sang 01/11", () => {
    const r = thoiDiemHoaDon("2026-10-31 23:59:59", "UTC+07:00");
    expect(r).toEqual({ ok: true, luc: new Date("2026-10-31T16:59:59.000Z") });
  });

  it("timezone vắng ⇒ mặc định UTC+07:00", () => {
    expect(thoiDiemHoaDon("2026-10-23 15:38:00", null)).toEqual({ ok: true, luc: new Date("2026-10-23T08:38:00.000Z") });
    expect(thoiDiemHoaDon("2026-10-23 15:38:00", "")).toEqual({ ok: true, luc: new Date("2026-10-23T08:38:00.000Z") });
  });

  it("offset khác đúng khuôn ⇒ quy đổi chính xác (không ép về giờ VN)", () => {
    expect(thoiDiemHoaDon("2026-10-23 15:38:00", "UTC-03:30")).toEqual({
      ok: true,
      luc: new Date("2026-10-23T19:08:00.000Z"),
    });
  });

  it("timezone lạ (tên vùng, GMT+7, rác) ⇒ lý do — bỏ dòng, không ép", () => {
    for (const tz of ["Asia/Ho_Chi_Minh", "GMT+7", "UTC+7", "+07:00", "UTC+25:00"]) {
      const r = thoiDiemHoaDon("2026-10-23 15:38:00", tz);
      expect(r.ok, tz).toBe(false);
      if (!r.ok) expect(r.loi).toMatch(/timezone lạ/);
    }
  });

  it("create_time sai khuôn / ngày không có thật (31/02 — V8 tự cuộn) ⇒ lý do", () => {
    expect(thoiDiemHoaDon("2026-10-23T15:38:00", "UTC+07:00").ok).toBe(false);
    expect(thoiDiemHoaDon("2026-02-31 10:00:00", "UTC+07:00").ok).toBe(false);
    expect(thoiDiemHoaDon("2026-10-23 25:00:00", "UTC+07:00").ok).toBe(false);
    expect(thoiDiemHoaDon(null, "UTC+07:00").ok).toBe(false);
  });
});

describe("mapHoaDonTiktok", () => {
  it("hoá đơn BILL_PAYMENT|CASH thật ⇒ đủ cột, tiền Int, id giữ nguyên chuỗi (int64 không làm tròn)", () => {
    const r = mapHoaDonTiktok("7657315630890860807", BC, hoaDon());
    expect(r).toEqual({
      ok: true,
      hoaDon: {
        transactionId: "7657315630890860807",
        bcId: BC,
        advertiserId: "7129548444015902722",
        invoiceId: "7657322667854365458",
        createTime: new Date("2026-10-23T08:38:00.000Z"),
        amount: 143_000,
        subtotal: 130_000,
        taxAmount: 13_000,
        transactionType: "BILL_PAYMENT",
        billingType: "CASH",
        amountType: "POSITIVE",
        paymentPortfolioId: "7553366094925204945",
      },
    });
  });

  it("transaction_id ghép 'A|B' giữ NGUYÊN làm khoá", () => {
    const r = mapHoaDonTiktok("7657315630890860807|7657315630890860999", BC, hoaDon());
    expect(r.ok && r.hoaDon.transactionId).toBe("7657315630890860807|7657315630890860999");
  });

  it("thiếu invoice_id / payment_portfolio_id / account_id ⇒ vẫn land, cột NULL", () => {
    const r = mapHoaDonTiktok("tx", BC, hoaDon({ invoice_id: null, payment_portfolio_id: "", account_id: undefined }));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.hoaDon.invoiceId).toBeNull();
      expect(r.hoaDon.paymentPortfolioId).toBeNull();
      expect(r.hoaDon.advertiserId).toBeNull();
    }
  });

  it("thiếu bc_id trong payload ⇒ lấy shopId Bronze (= bc_id)", () => {
    const r = mapHoaDonTiktok("tx", BC, hoaDon({ bc_id: null }));
    expect(r.ok && r.hoaDon.bcId).toBe(BC);
  });

  it("dấu: NEGATIVE giữ amount KHÔNG dấu, chiều nằm ở amountType", () => {
    const r = mapHoaDonTiktok("tx", BC, hoaDon({ transaction_type: "ORDER_CREATION_PAYMENT", amount_type: "NEGATIVE", amount: "226682" }));
    expect(r.ok && [r.hoaDon.amount, r.hoaDon.amountType]).toEqual([226_682, "NEGATIVE"]);
  });

  it("tiền dạng số JSON (đã thành chuỗi số) đọc như chuỗi; subtotal/tax vắng ⇒ NULL, không ép 0", () => {
    const r = mapHoaDonTiktok("tx", BC, hoaDon({ amount: "1300750", subtotal: null, tax_amount: undefined }));
    expect(r.ok).toBe(true);
    if (r.ok) expect([r.hoaDon.amount, r.hoaDon.subtotal, r.hoaDon.taxAmount]).toEqual([1_300_750, null, null]);
  });

  it("loại giao dịch lạ / tín dụng tặng (PROMOTION_ISSUED|CREDIT) vẫn LAND — người đọc tự lọc", () => {
    const tang = mapHoaDonTiktok("tx", BC, hoaDon({ transaction_type: "PROMOTION_ISSUED", billing_type: "CREDIT" }));
    expect(tang.ok && [tang.hoaDon.transactionType, tang.hoaDon.billingType]).toEqual(["PROMOTION_ISSUED", "CREDIT"]);
    const la = mapHoaDonTiktok("tx", BC, hoaDon({ transaction_type: "LOAI_MOI_CHUA_THAY" }));
    expect(la.ok).toBe(true);
  });

  it("amount_type lạ / thiếu ⇒ lý do (không biết chiều tiền)", () => {
    for (const v of ["UNKNOWN", "positive", null]) {
      const r = mapHoaDonTiktok("tx", BC, hoaDon({ amount_type: v }));
      expect(r.ok, String(v)).toBe(false);
      if (!r.ok) expect(r.loi).toMatch(/amount_type/);
    }
  });

  it("thiếu transaction_type / billing_type / amount ⇒ lý do", () => {
    expect(mapHoaDonTiktok("tx", BC, hoaDon({ transaction_type: null })).ok).toBe(false);
    expect(mapHoaDonTiktok("tx", BC, hoaDon({ billing_type: "" })).ok).toBe(false);
    expect(mapHoaDonTiktok("tx", BC, hoaDon({ amount: null })).ok).toBe(false);
  });

  it("amount âm / có phần lẻ ⇒ lý do (dấu chỉ nằm ở amount_type)", () => {
    expect(mapHoaDonTiktok("tx", BC, hoaDon({ amount: "-143000" })).ok).toBe(false);
    expect(mapHoaDonTiktok("tx", BC, hoaDon({ amount: "143000.5" })).ok).toBe(false);
    expect(mapHoaDonTiktok("tx", BC, hoaDon({ subtotal: "abc" })).ok).toBe(false);
  });

  it("tiền tệ khác VND ⇒ lý do; currency vắng ⇒ cho qua", () => {
    const usd = mapHoaDonTiktok("tx", BC, hoaDon({ currency: "USD" }));
    expect(usd.ok).toBe(false);
    if (!usd.ok) expect(usd.loi).toMatch(/USD/);
    expect(mapHoaDonTiktok("tx", BC, hoaDon({ currency: null })).ok).toBe(true);
  });

  it("timezone lạ ⇒ lý do; payload không phải object ⇒ lý do", () => {
    expect(mapHoaDonTiktok("tx", BC, hoaDon({ timezone: "Asia/Ho_Chi_Minh" })).ok).toBe(false);
    expect(mapHoaDonTiktok("tx", BC, null).ok).toBe(false);
  });
});
