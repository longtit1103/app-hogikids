import { describe, expect, it } from "vitest";

import { nhanTrangThaiChotHoaHong } from "@/lib/marketing/nhan-trang-thai-chot-hoa-hong";

/**
 * Luật fail-open "chưa chốt" (đo 28/08): chỉ SETTLED và INELIGIBLE là trạng thái cuối; mọi thứ khác —
 * kể cả sàn KHÔNG báo — là "đang chờ sàn chốt". Chuỗi gốc luôn được giữ để đưa vào `title`.
 */
describe("nhanTrangThaiChotHoaHong — nhãn Việt cho settlement_status (fail-open)", () => {
  it("hai trạng thái CUỐI đo được trên sàn", () => {
    expect(nhanTrangThaiChotHoaHong("SETTLED")).toEqual({
      nhan: "đã chốt",
      goc: "SETTLED",
    });
    expect(nhanTrangThaiChotHoaHong("INELIGIBLE")).toEqual({
      nhan: "không đủ ĐK",
      goc: "INELIGIBLE",
    });
  });

  it("hai trạng thái CHỜ thật đã thấy trên prod (tuổi 4 và 6 ngày, 30/08)", () => {
    expect(nhanTrangThaiChotHoaHong("To-SETTLE")).toEqual({
      nhan: "đang chờ sàn chốt",
      goc: "To-SETTLE",
    });
    expect(nhanTrangThaiChotHoaHong("AWAITING PAYMENT")).toEqual({
      nhan: "đang chờ sàn chốt",
      goc: "AWAITING PAYMENT",
    });
  });

  it("sàn không báo (null) ⇒ vẫn là đang chờ, goc null để UI ghi 'sàn không báo'", () => {
    expect(nhanTrangThaiChotHoaHong(null)).toEqual({
      nhan: "đang chờ sàn chốt",
      goc: null,
    });
  });

  it("giá trị lạ / biến thể hoa-thường KHÔNG được đoán thành đã chốt (fail-open, so sánh chính xác)", () => {
    for (const la of [
      "settled",
      "Settled",
      "SETTLED ",
      "PAID",
      "COMPLETED",
      "",
    ]) {
      expect(nhanTrangThaiChotHoaHong(la).nhan).toBe("đang chờ sàn chốt");
      expect(nhanTrangThaiChotHoaHong(la).goc).toBe(la);
    }
  });
});
