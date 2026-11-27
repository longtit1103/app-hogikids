import { describe, expect, it } from "vitest";

import { mapHoaDonTiktok } from "@/lib/ingest/tiktok-ads-hoa-don-mapping";

import {
  BC,
  DONG_NAP,
  DONG_OTHERS,
  DONG_P8,
  ID_NAP,
  ID_OTHERS,
  ID_P8,
  INVOICE_TACH_DOI,
  NAP,
  P8,
  truongTho,
} from "../helpers/hoa-don-tiktok-others-fixture";

/**
 * GHIM hành vi của MAPPING với hoá đơn TikTok Business `amount_type = "OTHERS"` (shape payload thật; id, ngày giờ, số tiền GIẢ —
 * fixture chung `tests/helpers/hoa-don-tiktok-others-fixture.ts`). Mapping KHÔNG đổi theo tập dấu băm đã xác minh: OTHERS
 * luôn là "không biết chiều tiền" ⇒ ok:false. Việc bỏ có chủ đích dòng thuộc tập nằm ở bước transform
 * (`ingest-raw-hoa-don-others-tru-so-du-da-xac-minh.integration.test.ts`); dòng ngoài tập giữ ERROR + backlog
 * (`ingest-raw-hoa-don-others-giu-error-backlog.integration.test.ts`). Hai nhóm OTHERS:
 *  - 7 dòng thiếu `invoice_id` (chuỗi rỗng) + `serial_number` "-999", `amount` null;
 *  - 1 dòng `OTHERS` của bill TÁCH ĐÔI: cùng `invoice_id`/serial với một hoá đơn `POSITIVE` trừ thẻ.
 */

describe("mapping hoá đơn TikTok amount_type OTHERS (ghim)", () => {
  it("đối chứng dữ liệu mẫu: Σ(subtotal + tax) 8 dòng OTHERS = đúng lần nạp N", () => {
    // Giữ fixture đúng cấu trúc ca thật (tổng OTHERS = một lần nạp) — sửa tay một dòng làm lệch là test này đỏ trước.
    const tong = DONG_OTHERS.reduce((s, d) => s + Number(d.subtotal) + Number(d.tax_amount), 0);
    expect(tong).toBe(NAP);
  });

  it.each(DONG_OTHERS.map((d, i) => [ID_OTHERS[i], d.invoice_id === "" ? "thiếu invoice_id" : "bill tách đôi", d] as const))(
    "OTHERS %s (%s) ⇒ ok:false, lý do 'không biết chiều tiền' — mapping không bao giờ đưa OTHERS vào Silver",
    (id, _nhom, d) => {
      // Mapping chỉ nhận POSITIVE | NEGATIVE: chiều tiền OTHERS không đọc chắc được, đoán là lệch nợ thẻ im lặng.
      const r = mapHoaDonTiktok(id, BC, truongTho(d));
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.loi).toContain("không biết chiều tiền");
        expect(r.loi).toContain('"OTHERS"');
      }
    },
  );

  it("phần POSITIVE của bill tách đôi ⇒ ok:true, amount = P8, cùng invoiceId với dòng OTHERS", () => {
    // Nửa trừ thẻ của bill vẫn vào nợ thẻ bình thường — dòng OTHERS cùng bill bị bỏ không kéo nó theo.
    const r = mapHoaDonTiktok(ID_P8, BC, truongTho(DONG_P8));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.hoaDon).toMatchObject({
        transactionId: ID_P8,
        amount: P8,
        subtotal: 2_134_560,
        taxAmount: 213_456,
        amountType: "POSITIVE",
        transactionType: "BILL_PAYMENT",
        billingType: "CASH",
        invoiceId: INVOICE_TACH_DOI,
        createTime: new Date("2026-09-09T06:27:58.000Z"),
      });
    }
    expect(DONG_OTHERS[7].invoice_id).toBe(INVOICE_TACH_DOI);
  });

  it("lần nạp ADD_BALANCE ⇒ ok:true, amount = N, portfolio NULL", () => {
    // Đây là khoản đã vào nợ thẻ — 8 dòng OTHERS tiêu từ chính số dư này.
    const r = mapHoaDonTiktok(ID_NAP, BC, truongTho(DONG_NAP));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.hoaDon).toMatchObject({
        amount: NAP,
        transactionType: "ADD_BALANCE",
        amountType: "POSITIVE",
        invoiceId: "7000000000000000200",
        paymentPortfolioId: null,
        createTime: new Date("2026-09-02T12:47:12.000Z"),
      });
    }
  });
});
