import { describe, expect, it } from "vitest";

import { calcPnlCore, type PnlOrderInput } from "@/lib/reports/pnl";

/**
 * Guard cho param ADDITIVE `statusIn` của `calcPnlCore` (lăng kính Dòng tiền).
 * Bất biến: không truyền = hành vi cũ (đơn hợp lệ ∉ {RETURNED,CANCELLED});
 * `[]` KHÔNG âm thầm rơi về default (guard `!== undefined`).
 */

const completed: PnlOrderInput = {
  status: "COMPLETED",
  channelId: "shopee",
  itemsTotal: 500_000,
  discount: 20_000,
  platformFeeEst: 62_500,
  items: [],
};
const shipping: PnlOrderInput = {
  status: "SHIPPING",
  channelId: "shopee",
  itemsTotal: 300_000,
  discount: 0,
  platformFeeEst: 30_000,
  items: [],
};
const cancelled: PnlOrderInput = {
  status: "CANCELLED",
  channelId: "shopee",
  itemsTotal: 999_000,
  discount: 0,
  platformFeeEst: 0,
  items: [],
};

describe("calcPnlCore — statusIn (ADDITIVE)", () => {
  const all = [completed, shipping, cancelled];

  it("không truyền statusIn = hành vi cũ (loại RETURNED/CANCELLED)", () => {
    const r = calcPnlCore(all, []);
    expect(r.revenue).toBe(800_000); // completed + shipping (cancelled bị loại)
    expect(r.orderCount).toBe(2);
  });

  it("statusIn:['COMPLETED'] chỉ đơn đã giao", () => {
    const r = calcPnlCore(all, [], { statusIn: ["COMPLETED"] });
    expect(r.revenue).toBe(500_000);
    expect(r.netRevenue).toBe(417_500); // 500.000 − 62.500 − 20.000
    expect(r.orderCount).toBe(1);
  });

  it("statusIn:['PENDING','SHIPPING'] chỉ đơn đang chờ", () => {
    const r = calcPnlCore(all, [], { statusIn: ["PENDING", "SHIPPING"] });
    expect(r.revenue).toBe(300_000);
    expect(r.netRevenue).toBe(270_000);
    expect(r.orderCount).toBe(1);
  });

  it("statusIn:[] KHÔNG rơi về default → revenue 0 (guard !== undefined)", () => {
    const r = calcPnlCore(all, [], { statusIn: [] });
    expect(r.revenue).toBe(0);
    expect(r.orderCount).toBe(0);
  });

  // Guard mức KIỂU: dưới lăng kính statusIn, netProfit/returnBomOrderCount vô nghĩa
  // → overload trả PnlStatusLensBreakdown loại 2 field này. `@ts-expect-error` tự
  // kiểm qua `tsc --noEmit`: nếu ai gỡ guard (2 field đọc được trở lại) thì chính
  // dòng @ts-expect-error thành "thừa" → tsc đỏ. Đây là type-test, không assert số.
  it("kiểu trả về dưới statusIn KHÔNG cho đọc netProfit/returnBomOrderCount", () => {
    const lens = calcPnlCore(all, [], { statusIn: ["COMPLETED"] });
    // @ts-expect-error netProfit vô nghĩa dưới lăng kính statusIn — bị loại khỏi kiểu
    void lens.netProfit;
    // @ts-expect-error returnBomOrderCount vô nghĩa dưới lăng kính statusIn — bị loại khỏi kiểu
    void lens.returnBomOrderCount;
    // @ts-expect-error returnedOrderFee tính trên mọi đơn (độc lập filter) — bị loại khỏi kiểu
    void lens.returnedOrderFee;
    // Không truyền statusIn → PnlBreakdown đầy đủ, 2 field vẫn đọc bình thường.
    const full = calcPnlCore(all, []);
    expect(typeof full.netProfit).toBe("number");
    expect(typeof full.returnBomOrderCount).toBe("number");
    expect(typeof full.returnedOrderFee).toBe("number");
  });

  /**
   * Thu nhập tài chính chỉ có nghĩa khi có `netProfit` để cộng vào — mà lăng kính `statusIn`
   * không có field đó. Nếu overload `statusIn` lỡ nhận `incomes`, caller Dòng tiền sẽ truyền vào
   * rồi tưởng đã tính, trong khi số không đi đâu cả. `@ts-expect-error` giữ cánh cửa đó đóng:
   * gỡ guard ⇒ dòng này thành "thừa" ⇒ `tsc --noEmit` đỏ.
   */
  it("KHÔNG cho truyền incomes kèm statusIn (thu nhập tài chính vô nghĩa dưới lăng kính này)", () => {
    // @ts-expect-error `incomes` chỉ có ở overload không-statusIn — cố ý không có chỗ rơi vào đây
    const lens = calcPnlCore(all, [], { statusIn: ["COMPLETED"], incomes: [{ amount: 1_000_000 }] });
    expect(lens.revenue).toBe(500_000);
  });
});
