import { describe, expect, it } from "vitest";

import { returnedOrderFeeDisplay } from "@/lib/orders/provisional-fee";

describe("returnedOrderFeeDisplay", () => {
  const now = new Date("2026-07-21T00:00:00+07:00");
  const recent = new Date("2026-07-10T00:00:00+07:00"); // 11 ngày < 30 → còn trong cửa sổ
  const old = new Date("2026-04-15T00:00:00+07:00"); // >30 ngày → coi như đã đối soát
  const base = { channelId: "shopee", status: "RETURNED" as const, orderedAt: recent };

  it("đã đối soát (returnedFee>0): số thực, KHÔNG nhãn tạm (kể cả đơn mới)", () => {
    const d = returnedOrderFeeDisplay({ ...base, returnedFee: 1_620, platformFeeEst: 1_620 }, now);
    expect(d).toEqual({ show: true, fee: 1_620, provisional: false });
  });
  it("chưa đối soát + đơn CÒN MỚI (≤30 ngày): số 0 + nhãn tạm", () => {
    const d = returnedOrderFeeDisplay({ ...base, returnedFee: 0, platformFeeEst: 90_980 }, now);
    expect(d).toEqual({ show: true, fee: 0, provisional: true });
  });
  it("returnedFee=0 nhưng đơn ĐÃ CŨ (>30 ngày): hiện 0, BỎ nhãn tạm (đã đối soát)", () => {
    const d = returnedOrderFeeDisplay({ ...base, orderedAt: old, returnedFee: 0, platformFeeEst: 90_980 }, now);
    expect(d).toEqual({ show: true, fee: 0, provisional: false });
  });
  it("mốc đúng 30 ngày vẫn coi là còn trong cửa sổ (tạm)", () => {
    const at30 = new Date("2026-06-21T00:00:00+07:00"); // đúng 30 ngày trước now
    const d = returnedOrderFeeDisplay({ ...base, orderedAt: at30, returnedFee: 0, platformFeeEst: 5_000 }, now);
    expect(d.provisional).toBe(true);
  });
  it("không phí gì (returnedFee=0, fee_mkt=0): không hiện", () => {
    expect(returnedOrderFeeDisplay({ ...base, returnedFee: 0, platformFeeEst: 0 }, now).show).toBe(false);
  });
  it("kênh không phí thật (facebook): không hiện", () => {
    expect(
      returnedOrderFeeDisplay({ channelId: "facebook", status: "RETURNED", orderedAt: recent, returnedFee: 0, platformFeeEst: 100 }, now).show,
    ).toBe(false);
  });
  it("đơn hợp lệ (COMPLETED): không hiện", () => {
    expect(
      returnedOrderFeeDisplay({ channelId: "shopee", status: "COMPLETED", orderedAt: recent, returnedFee: 5, platformFeeEst: 5 }, now).show,
    ).toBe(false);
  });
});
