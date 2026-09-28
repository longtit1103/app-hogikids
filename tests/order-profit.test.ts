import { describe, expect, it } from "vitest";

import { calcOrderCogs, calcOrderProfit } from "@/lib/orders/order-profit";
import { ORDER_STATUS_META, slugToStatus } from "@/lib/orders/order-status-meta";
import { calcPnlCore, type PnlOrderInput } from "@/lib/reports/pnl";

describe("calcOrderCogs", () => {
  it("costPrice null/0 → cộng 0 + đếm missing, không NaN", () => {
    const r = calcOrderCogs([
      { quantity: 2, costPrice: 100 },
      { quantity: 3, costPrice: null },
      { quantity: 1, costPrice: 0 },
    ]);
    expect(r.cogs).toBe(200);
    expect(r.missingCostCount).toBe(2);
    expect(Number.isNaN(r.cogs)).toBe(false);
  });
});

describe("calcOrderProfit", () => {
  it("case số cố định: 500.000 − 20.000 − 62.500 − 180.000 = 237.500", () => {
    expect(calcOrderProfit({ itemsTotal: 500000, discount: 20000, platformFeeEst: 62500, cogs: 180000 })).toBe(237500);
  });
  it("lãi âm trả số âm", () => {
    expect(calcOrderProfit({ itemsTotal: 100000, discount: 0, platformFeeEst: 50000, cogs: 80000 })).toBe(-30000);
  });
});

describe("order-status-meta", () => {
  it("đủ 5 trạng thái có slug/label/tone", () => {
    expect(Object.keys(ORDER_STATUS_META)).toHaveLength(5);
    expect(ORDER_STATUS_META.COMPLETED).toEqual({ slug: "hoan_thanh", label: "Hoàn thành", tone: "success" });
  });
  it("slugToStatus: phẩy → OrderStatus[]; slug lạ bỏ qua; rỗng → []", () => {
    expect(slugToStatus("hoan_hang,huy_bom")).toEqual(["RETURNED", "CANCELLED"]);
    expect(slugToStatus("hoan_hang, lung_tung ,huy_bom")).toEqual(["RETURNED", "CANCELLED"]);
    expect(slugToStatus("")).toEqual([]);
  });
});

// Finding M2/B6: order-profit.ts (lãi từng đơn ở drawer) LẶP công thức cấp-đơn với
// pnl.ts. Không có test parity thì đổi 1 bên mà quên bên kia → drawer lãi/đơn lệch
// bảng P&L âm thầm. Chốt: Σ calcOrderProfit(đơn HỢP LỆ) === grossProfit của calcPnlCore.
describe("parity order-profit ↔ pnl.ts (grossProfit)", () => {
  // Đủ dạng: costPrice thường / null (variantId null) / 0 (chưa nhập giá vốn) / lãi âm;
  // kèm đơn RETURNED + CANCELLED (phải bị LOẠI khỏi cả 2 vế) + 2 kênh (test lọc channelId).
  const orders: PnlOrderInput[] = [
    {
      status: "COMPLETED",
      channelId: "shopee",
      itemsTotal: 500000,
      discount: 20000,
      platformFeeEst: 62500,
      items: [{ sku: "A", quantity: 2, costPrice: 90000 }],
    },
    {
      status: "SHIPPING",
      channelId: "tiktok",
      itemsTotal: 300000,
      discount: 0,
      platformFeeEst: 81000,
      items: [
        { sku: "B", quantity: 1, costPrice: null }, // variantId null → COGS 0
        { sku: "C", quantity: 3, costPrice: 0 }, // chưa nhập giá vốn → COGS 0
      ],
    },
    {
      status: "PENDING",
      channelId: "shopee",
      itemsTotal: 100000,
      discount: 5000,
      platformFeeEst: 50000,
      items: [{ sku: "D", quantity: 1, costPrice: 80000 }], // lãi âm (-35.000)
    },
    {
      status: "RETURNED",
      channelId: "shopee",
      itemsTotal: 999000,
      discount: 0,
      platformFeeEst: 12345,
      returnedFee: 3000,
      items: [{ sku: "E", quantity: 5, costPrice: 100000 }],
    },
    {
      status: "CANCELLED",
      channelId: "tiktok",
      itemsTotal: 777000,
      discount: 7000,
      platformFeeEst: 6789,
      items: [{ sku: "F", quantity: 2, costPrice: 50000 }],
    },
  ];

  /** Tổng lãi-gộp từng-đơn qua order-profit.ts, CHỈ đơn hợp lệ, khớp bộ lọc kênh. */
  function sumOrderProfit(channelId?: string): number {
    return orders
      .filter((o) => (channelId ? o.channelId === channelId : true))
      .filter((o) => o.status !== "RETURNED" && o.status !== "CANCELLED")
      .reduce((acc, o) => {
        const { cogs } = calcOrderCogs(o.items);
        return (
          acc +
          calcOrderProfit({
            itemsTotal: o.itemsTotal,
            discount: o.discount,
            platformFeeEst: o.platformFeeEst,
            cogs,
          })
        );
      }, 0);
  }

  it("khớp trên toàn shop", () => {
    expect(sumOrderProfit()).toBe(calcPnlCore(orders, []).grossProfit);
  });

  it("khớp khi lọc theo 1 kênh (channelId)", () => {
    expect(sumOrderProfit("shopee")).toBe(calcPnlCore(orders, [], { channelId: "shopee" }).grossProfit);
    expect(sumOrderProfit("tiktok")).toBe(calcPnlCore(orders, [], { channelId: "tiktok" }).grossProfit);
  });
});
