import { describe, expect, it } from "vitest";

import { docDemSan, docTiLeSan, docTienSan } from "@/lib/marketing/doc-so-san";

/**
 * Parser số sàn — lưới duy nhất giữa payload TikTok và mọi con số hiện trên `/marketing`.
 * Mọi ca dưới đây là GIÁ TRỊ THẬT bóc từ `tests/fixtures/tiktokshop/analytics/*.json` và
 * `tests/fixtures/tiktokbusiness/gmvmax-item.json` (đối chiếu bằng `grep` trực tiếp trên file,
 * không suy đoán từ tài liệu). 2 chỗ brief minh hoạ SAI so với fixture thật đã sửa — xem
 * report Task 2: `docTiLeSan("0.0827")` → không tồn tại trong fixture, giá trị thật là
 * `"0.0829"` (`add_cart_rate` của SP `1733583824365520555`, `shop-products.json`);
 * `docDemSan("31")` → không có chuỗi `"31"` nào trong fixture, thay bằng `"592"`
 * (`metrics.cost` của `gmvmax-item.json`, chuỗi số nguyên thật của Business API — mượn để
 * kiểm khuôn "chuỗi toàn chữ số", vì fixture Task 1 chỉ có `orders: "0"` làm ca chuỗi-đếm thật).
 *
 * Luật xuyên suốt: đọc KHÔNG chắc chắn ⇒ `null`, TUYỆT ĐỐI KHÔNG rơi về 0. "0" và "không đo được"
 * là hai chuyện khác nhau; trộn chúng lại là bịa ra một phép đo chưa từng xảy ra.
 */
describe("docTienSan", () => {
  it("khuôn thập phân của shop/products/videos", () => {
    expect(docTienSan({ amount: "330000.00", currency: "VND" })).toBe(330_000);
  });

  it('khuôn KHÔNG thập phân của shop_lives ("0")', () => {
    expect(docTienSan({ amount: "0", currency: "VND" })).toBe(0);
  });

  it("làm tròn về đồng (gpm của video có phần lẻ)", () => {
    expect(docTienSan({ amount: "297833.94", currency: "VND" })).toBe(297_834);
    expect(docTienSan({ amount: "3055555.56", currency: "VND" })).toBe(3_055_556);
  });

  it("tiền tệ KHÁC VND ⇒ null (ad/shop account đổi tiền tệ là sai ~26.000 lần)", () => {
    expect(docTienSan({ amount: "10.00", currency: "USD" })).toBeNull();
  });

  it("shape lạ ⇒ null, KHÔNG ra 0", () => {
    expect(docTienSan(null)).toBeNull();
    expect(docTienSan("330000")).toBeNull(); // số trần, không phải object tiền
    expect(docTienSan({ amount: "N/A", currency: "VND" })).toBeNull();
    expect(docTienSan({ currency: "VND" })).toBeNull(); // thiếu key amount
  });
});

describe("docTiLeSan", () => {
  it("khuôn thập phân (add_cart_rate SP 1733583824365520555, shop-products.json)", () => {
    expect(docTiLeSan("0.0829")).toBeCloseTo(0.0829, 6);
    expect(docTiLeSan("0.0000")).toBe(0);
  });

  it('khuôn phần trăm riêng của shop_lives ("0.00%")', () => {
    expect(docTiLeSan("0.00%")).toBe(0);
    expect(docTiLeSan("12.50%")).toBeCloseTo(0.125, 6);
  });

  it("chuỗi dị ⇒ null", () => {
    expect(docTiLeSan("")).toBeNull();
    expect(docTiLeSan("N/A")).toBeNull();
    expect(docTiLeSan(0.5)).toBeNull(); // sàn LUÔN trả chuỗi — number ở đây là dấu hiệu mapping trôi
  });
});

describe("docDemSan", () => {
  it("number nguyên (views của video, analytics là number thật)", () => {
    expect(docDemSan(1108)).toBe(1108);
    expect(docDemSan(0)).toBe(0);
  });

  it('chuỗi toàn chữ số (metrics của Business API là chuỗi: orders "0", cost "592")', () => {
    expect(docDemSan("0")).toBe(0);
    expect(docDemSan("592")).toBe(592);
  });

  it("âm / thập phân / rác ⇒ null", () => {
    expect(docDemSan(-1)).toBeNull();
    expect(docDemSan(1.5)).toBeNull();
    expect(docDemSan("abc")).toBeNull();
    expect(docDemSan(undefined)).toBeNull();
  });
});
