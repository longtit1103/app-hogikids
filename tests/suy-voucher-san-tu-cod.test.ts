import { describe, expect, it } from "vitest";

import { suyVoucherSanTuCod } from "@/lib/ingest/suy-voucher-san-tu-cod";

/**
 * Luật suy khoản sàn tài trợ Pancake bỏ trống, dùng `cod` làm trọng tài.
 *
 * Trọng tâm test KHÔNG phải "bù đúng số" mà là "TỪ CHỐI bù đúng lúc": đây là luật duy nhất trong
 * app tự cộng thêm vào doanh thu, nên mỗi cửa nó bước qua nhầm là một lần tiền bị thổi lên mà không
 * ai biết. Ba đơn thật (đo prod 2026-08-05) dùng làm ca chuẩn.
 */

const NEN = {
  maDon: "TEST-1",
  status: "COMPLETED" as const,
  grossTotal: 350_000,
  sumEachDiscount: 144_460,
  voucherSanDaKhai: 0,
  cod: 183_396,
  feeMarketplace: 55_604,
  discountMucDon: 0,
  tienShip: 0,
  dungPhiThat: true,
};

describe("suyVoucherSanTuCod — ba đơn thật Pancake bỏ trống ô sàn tài trợ", () => {
  it("đơn #148: suy ra đúng 33.460 đ (TikTok API xác nhận cùng số)", () => {
    expect(suyVoucherSanTuCod(NEN).boSung).toBe(33_460);
  });

  it("đơn #171: suy ra đúng 26.010 đ", () => {
    const kq = suyVoucherSanTuCod({
      ...NEN,
      maDon: "171",
      grossTotal: 400_000,
      sumEachDiscount: 137_010,
      cod: 210_096,
      feeMarketplace: 78_904,
    });
    expect(kq.boSung).toBe(26_010);
  });

  it("đơn #114: sàn tài trợ TOÀN BỘ khoản giảm — shop không giảm đồng nào", () => {
    const kq = suyVoucherSanTuCod({
      ...NEN,
      maDon: "114",
      grossTotal: 230_000,
      sumEachDiscount: 20_700,
      cod: 177_674,
      feeMarketplace: 52_326,
    });
    expect(kq.boSung).toBe(20_700); // = trọn Σ giảm giá dòng, vẫn trong hạn cho phép
  });

  it("có bù thì phải nói ra, không sửa tiền im lặng", () => {
    expect(suyVoucherSanTuCod(NEN).canhBao).toMatch(/sàn tài trợ 33460/);
  });
});

describe("suyVoucherSanTuCod — các cửa PHẢI từ chối bù", () => {
  it("đơn khớp đẳng thức → không đụng gì (311/314 đơn rơi vào đây)", () => {
    // itemsTotal 205.540 = cod 149.936 + phí 55.604 ⇒ khớp, không lệch
    const kq = suyVoucherSanTuCod({ ...NEN, cod: 205_540 - 55_604 });
    expect(kq).toEqual({ boSung: 0, canhBao: null });
  });

  it("Pancake ĐÃ khai voucher sàn → tin số nó khai, không suy diễn đè lên", () => {
    const kq = suyVoucherSanTuCod({ ...NEN, voucherSanDaKhai: 20_000 });
    expect(kq).toEqual({ boSung: 0, canhBao: null });
  });

  it("kênh dùng phí ước tính % → không có trọng tài, bỏ qua", () => {
    expect(suyVoucherSanTuCod({ ...NEN, dungPhiThat: false })).toEqual({ boSung: 0, canhBao: null });
  });

  it("thiếu cod (null hoặc 0) → không có gì để đối chiếu", () => {
    expect(suyVoucherSanTuCod({ ...NEN, cod: null })).toEqual({ boSung: 0, canhBao: null });
    expect(suyVoucherSanTuCod({ ...NEN, cod: 0 })).toEqual({ boSung: 0, canhBao: null });
  });

  it("app ghi THỪA so với mốc cod → KHÔNG tự sửa, chỉ cảnh báo", () => {
    // cod nhỏ đi ⇒ mốc Pancake thấp hơn tiền hàng app đang ghi.
    const kq = suyVoucherSanTuCod({ ...NEN, cod: 100_000 });
    expect(kq.boSung).toBe(0);
    expect(kq.canhBao).toMatch(/bất thường/);
  });

  it("lệch vượt Σ giảm giá dòng → lệch đến từ chỗ khác, KHÔNG tự sửa", () => {
    // Giảm giá dòng chỉ 10.000 mà thiếu tới 128.460 ⇒ không thể là phần sàn gánh trong khoản giảm đó.
    const kq = suyVoucherSanTuCod({ ...NEN, sumEachDiscount: 10_000, grossTotal: 120_540 });
    expect(kq.boSung).toBe(0);
    expect(kq.canhBao).toMatch(/vượt Σ giảm giá dòng/);
  });

  it("đơn có phí ship → cod gồm ship, KHÔNG suy khoản sàn tài trợ", () => {
    // Đơn thật 260618D33GY0R4: lệch 42.500 đ đúng bằng `shipping_fee`, KHÔNG phải sàn tài trợ.
    const kq = suyVoucherSanTuCod({ ...NEN, tienShip: 42_500 });
    expect(kq.boSung).toBe(0);
    expect(kq.canhBao).toMatch(/tiền ship/);
  });

  it("chênh phí ship (diff_shipping_fee) cũng chặn — đo thật ở đơn khác", () => {
    // Đơn thật 260516HYR5495D: lệch 8.000 đ đúng bằng `diff_shipping_fee`.
    const kq = suyVoucherSanTuCod({ ...NEN, tienShip: 8_000 });
    expect(kq.boSung).toBe(0);
  });

  it("ship ÂM cũng phải chặn (hoàn phí ship) — không được lọt vì dấu", () => {
    expect(suyVoucherSanTuCod({ ...NEN, tienShip: -5_000 }).boSung).toBe(0);
  });

  it("đơn RETURNED → tuyệt đối không suy, cũng không cảnh báo (ngoài vùng luật được chứng minh)", () => {
    // Cùng hình dạng lệch mà đơn hợp lệ được bù 33.460 — đơn hoàn thì KHÔNG: luật chỉ được chứng
    // minh trên 314 đơn HỢP LỆ; trên đơn hoàn `fee_marketplace` là số tạm và `total_discount` hay bị
    // đảo khoản, đẳng thức mất nền (đo prod 2026-08-06: 16 đơn hoàn/hủy bị suy oan 2.237.730 đ).
    expect(suyVoucherSanTuCod({ ...NEN, status: "RETURNED" })).toEqual({ boSung: 0, canhBao: null });
  });

  it("đơn CANCELLED → như đơn RETURNED, không suy không báo", () => {
    expect(suyVoucherSanTuCod({ ...NEN, status: "CANCELLED" })).toEqual({ boSung: 0, canhBao: null });
  });

  it("đơn PENDING/SHIPPING (chưa chốt tiền) cũng KHÔNG suy — luật chỉ chạy trên đơn ĐÃ GIAO XONG", () => {
    // Nhóm này NẰM TRONG doanh thu P&L nên suy oan ở đây nặng hơn cả đơn hoàn: cùng hình dạng dữ
    // liệu (cod > 0, phí 0 vì sàn chưa đối soát) là +336.000 thổi thẳng vào P&L. Tập chứng minh
    // 314 đơn gần như toàn đơn đã hoàn tất — chưa từng đo trên đơn đang xử lý; đơn chưa xong thì
    // chờ giao xong re-sync sẽ suy sau, không mất gì.
    expect(suyVoucherSanTuCod({ ...NEN, status: "PENDING" })).toEqual({ boSung: 0, canhBao: null });
    expect(suyVoucherSanTuCod({ ...NEN, status: "SHIPPING" })).toEqual({ boSung: 0, canhBao: null });
  });

  it("đơn thật 583311185310680831: sàn gánh TRỌN khoản giảm — cod + phí = đúng total_price", () => {
    // Đo prod 2026-08-07 (lượt rebuild): total_price 230.000, Σ giảm giá dòng 20.700,
    // cod 177.674 + phí 52.326 = 230.000 = ĐÚNG total_price ⇒ Pancake tự chốt tiền hàng KHÔNG trừ
    // đồng giảm giá nào, tức sàn gánh trọn. `raw.total_discount` của đơn này là −20.700 (cách
    // Pancake ghi khoản sàn gánh); mapping KẸP về 0 trước khi truyền vào đây — ca đi qua đường
    // thật nằm ở `tests/ingest/pancake-mapping.test.ts`.
    const kq = suyVoucherSanTuCod({
      ...NEN,
      maDon: "583311185310680831",
      grossTotal: 230_000,
      sumEachDiscount: 20_700,
      cod: 177_674,
      feeMarketplace: 52_326,
      discountMucDon: 0,
    });
    expect(kq.boSung).toBe(20_700);
  });

  it("voucher mức đơn được tính vào đẳng thức (không bị coi là lệch)", () => {
    // Đơn #158 thật: itemsTotal 325.312 = cod 248.219 + phí 71.781 + voucher đơn 5.312
    const kq = suyVoucherSanTuCod({
      maDon: "158",
      status: "COMPLETED",
      grossTotal: 400_000,
      sumEachDiscount: 134_400,
      voucherSanDaKhai: 59_712,
      cod: 248_219,
      feeMarketplace: 71_781,
      discountMucDon: 5_312,
      tienShip: 0,
      dungPhiThat: true,
    });
    expect(kq).toEqual({ boSung: 0, canhBao: null });
  });
});
