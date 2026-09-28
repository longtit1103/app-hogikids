import { describe, expect, it } from "vitest";

import { buildOrderProfitLines, buildSettlementLines, type OrderDetailLineInput } from "@/lib/orders/order-detail-lines";
import { displayValue, type PnlLineItem } from "@/lib/reports/pnl-line-items";
import { expandableIds, summableChildren } from "@/lib/reports/pnl-line-tree";
import type { QuyetToanDon } from "@/lib/reports/tiktok-quyet-toan-don";

/**
 * `buildOrderProfitLines`/`buildSettlementLines` dựng cây khoản mục cho drawer chi
 * tiết đơn — cùng bất biến "Σ con = cha" và "cộng dọc mạch chính" với bảng Lãi/Lỗ
 * (xem tests/pnl-line-items.test.ts). Hai mạch tách riêng: (1) app tự tính lãi đơn,
 * (2) sàn quyết toán đối chiếu — không trộn (bất biến #7).
 */

function byId(items: PnlLineItem[]): Map<string, PnlLineItem> {
  return new Map(items.map((i) => [i.id, i]));
}

/**
 * Σ mọi dòng con (đã đổi dấu) phải khớp dòng cha, ở MỌI nhóm — bỏ dòng `aside`.
 * Dùng `displayValue` cho CẢ HAI vế (không chỉ con) vì có nhóm cha là khoản trừ
 * (platformFee/cogs, magnitude dương) lẫn nhóm cha KHÔNG phải khoản trừ
 * (netOfDiscount, net đã có dấu) — chỉ so trên .value thô sẽ SAI ở nhóm loại đầu.
 */
function assertChildrenSumToParent(items: PnlLineItem[]) {
  const m = byId(items);
  for (const parentId of expandableIds(items)) {
    const tongCon = summableChildren(items, parentId).reduce((s, i) => s + displayValue(i), 0);
    expect(tongCon, `Σ con của "${parentId}" phải khớp dòng cha`).toBe(displayValue(m.get(parentId)!));
  }
}

const INPUT: OrderDetailLineInput = {
  itemsTotal: 160_000, // = 200_000 (giá niêm yết) − 40_000 (giảm giá dòng)
  discount: 5_000,
  platformFeeEst: 30_000,
  cogs: 80_000, // = 2×40_000 (SKU-A) + 1×0 (SKU-B thiếu giá vốn)
  items: [
    { sku: "SKU-A", productName: "SP A", quantity: 2, lineDiscount: 20_000, costPrice: 40_000 },
    { sku: "SKU-B", productName: "SP B", quantity: 1, lineDiscount: 20_000, costPrice: null },
  ],
  feeComponents: [
    { key: "platform_commission", label: "Hoa hồng nền tảng", amount: 20_000 },
    { key: "payment_fee", label: "Phí giao dịch", amount: 8_000 },
  ],
  marketplaceFunded: 3_000,
};

describe("buildOrderProfitLines — Σ con = cha ở mọi nhóm", () => {
  it("netOfDiscount / sellerDiscount / platformFee / cogs đều khớp", () => {
    const items = buildOrderProfitLines(INPUT);
    // Non-vacuity: đủ mặt 4 nhóm có con trong fixture, không phải rỗng tự-pass.
    expect([...expandableIds(items)].sort()).toEqual(["cogs", "netOfDiscount", "platformFee", "sellerDiscount"]);
    assertChildrenSumToParent(items);
  });
});

describe("buildOrderProfitLines — cộng dọc mạch chính", () => {
  it("Doanh thu − Phí sàn = Thực nhận từ sàn", () => {
    const m = byId(buildOrderProfitLines(INPUT));
    expect(m.get("netOfDiscount")!.value - m.get("platformFee")!.value).toBe(m.get("netRevenue")!.value);
  });

  it("Thực nhận từ sàn − Giá vốn = Lãi đơn", () => {
    const m = byId(buildOrderProfitLines(INPUT));
    expect(m.get("netRevenue")!.value - m.get("cogs")!.value).toBe(m.get("profit")!.value);
  });
});

describe("buildOrderProfitLines — SKU thiếu giá vốn", () => {
  it("dòng cha 'Giá vốn' gắn warn khi có ít nhất 1 SKU thiếu giá vốn", () => {
    const m = byId(buildOrderProfitLines(INPUT));
    expect(m.get("cogs")!.warn).toBe(true);
  });

  it("dòng con của SKU thiếu giá vốn gắn warn, SKU có giá vốn thì không", () => {
    const items = buildOrderProfitLines(INPUT);
    const conA = items.find((i) => i.id.startsWith("cogs:SKU-A"))!;
    const conB = items.find((i) => i.id.startsWith("cogs:SKU-B"))!;
    expect(conA.warn).toBeFalsy();
    expect(conB.warn).toBe(true);
  });

  it("mọi SKU đều có giá vốn → dòng cha 'Giá vốn' KHÔNG warn", () => {
    const items = buildOrderProfitLines({
      ...INPUT,
      cogs: 80_000,
      items: [{ sku: "SKU-A", productName: "SP A", quantity: 2, lineDiscount: 40_000, costPrice: 40_000 }],
    });
    expect(byId(items).get("cogs")!.warn).toBeFalsy();
  });
});

describe("buildOrderProfitLines — feeComponents rỗng", () => {
  it('không có chi tiết → dòng "Phí sàn" là kind "line", không mọc mũi tên rỗng', () => {
    const items = buildOrderProfitLines({ ...INPUT, feeComponents: [] });
    expect(byId(items).get("platformFee")!.kind).toBe("line");
    expect(items.some((i) => i.parentId === "platformFee")).toBe(false);
  });

  it("có chi tiết → dòng 'Phí sàn' là kind 'group' và mọc dòng con", () => {
    const items = buildOrderProfitLines(INPUT);
    expect(byId(items).get("platformFee")!.kind).toBe("group");
    expect(items.some((i) => i.parentId === "platformFee")).toBe(true);
  });
});

describe("buildSettlementLines — mạch đối chiếu sàn quyết toán", () => {
  // Số ví dụ khớp đúng cả hai đẳng thức đã chứng minh trên prod (xem docstring nguồn):
  // settlement = doanh thu + phí&thuế + vận chuyển + điều chỉnh; vận chuyển = Σ 5 vế.
  const Q: QuyetToanDon = {
    soGiaoDich: 2,
    settlement: 84_500,
    doanhThu: 100_000,
    phiVaThue: -15_000,
    shipNet: 0,
    dieuChinh: -500,
    ve: {
      phiThucTe: -20_000,
      sanChietKhau: 20_000,
      phiShipHoan: -3_000,
      sanBuShipHoan: 3_000,
      khachTra: 0,
    },
  };

  it("doanh thu + phí&thuế + vận chuyển + điều chỉnh = Sàn quyết toán", () => {
    const m = byId(buildSettlementLines(Q, 80_000));
    const tong =
      m.get("settlement:revenue")!.value +
      m.get("settlement:fee")!.value +
      m.get("settlement:ship")!.value +
      m.get("settlement:adjustment")!.value;
    expect(tong).toBe(m.get("settlement")!.value);
  });

  it("5 vế vận chuyển cộng lại = Vận chuyển", () => {
    const m = byId(buildSettlementLines(Q, 80_000));
    const tong =
      m.get("settlement:ship:actual")!.value +
      m.get("settlement:ship:discount")!.value +
      m.get("settlement:ship:customer")!.value +
      m.get("settlement:ship:return")!.value +
      m.get("settlement:ship:reimburse")!.value;
    expect(tong).toBe(m.get("settlement:ship")!.value);
  });

  /**
   * Đơn hoàn/hủy: app CỐ TÌNH không tính "thực nhận" (loại khỏi P&L) nên không có
   * gì để so. Đem trừ một số không tồn tại thì mọi đơn hoàn/hủy đỏ rực dòng chênh
   * bằng đúng giá trị đơn — đo prod: 73/73 đơn, ca tệ nhất −1.454.556đ, hiện ngay
   * dưới dòng chữ "đơn không tính vào P&L".
   */
  it("thucNhanApp = null (đơn hoàn/hủy) → BỎ dòng chênh, khối vẫn hiện đủ số sàn", () => {
    const items = buildSettlementLines(Q, null);
    expect(items.some((i) => i.id === "settlement:chenh")).toBe(false);
    const m = byId(items);
    expect(m.get("settlement")!.value).toBe(Q.settlement);
    expect(m.get("settlement:ship")!.value).toBe(Q.shipNet);
  });

  it("dòng 'Chênh với số app tính' = settlement − thực nhận app", () => {
    const m = byId(buildSettlementLines(Q, 80_000));
    expect(m.get("settlement:chenh")!.value).toBe(Q.settlement - 80_000);
  });
});
