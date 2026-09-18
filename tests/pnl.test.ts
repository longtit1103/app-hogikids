import { describe, expect, it } from "vitest";

import {
  calcPnlCore,
  type PnlIncomeInput,
  type PnlExpenseInput,
  type PnlOrderInput,
} from "@/lib/reports/pnl";

/**
 * Guard số cố định cho `calcPnlCore` — NGUỒN CÔNG THỨC P&L DUY NHẤT.
 * Fixture thuần object (hàm pure, KHÔNG DB). Mỗi số assert literal để bất kỳ
 * thay đổi công thức nào cũng RED ngay. Bất biến: đơn hợp lệ = status ∉
 * {RETURNED, CANCELLED}; phí sàn/voucher chỉ đơn hợp lệ; COGS = Σ qty × costPrice
 * hiện hành (0 + sku có tên → skuMissing; null/sku rỗng → skuUnknownLine);
 * "purchase" KHÔNG vào P&L.
 */

// Đơn COMPLETED chuẩn (case 1): itemsTotal 500.000, discount 20.000,
// platformFeeEst 62.500, items [2×100.000, 1×50.000] → cogs 250.000.
const baseOrder: PnlOrderInput = {
  status: "COMPLETED",
  channelId: "shopee",
  itemsTotal: 500_000,
  discount: 20_000,
  platformFeeEst: 62_500,
  items: [
    { sku: "A", quantity: 2, costPrice: 100_000 },
    { sku: "B", quantity: 1, costPrice: 50_000 },
  ],
};

describe("calcPnlCore — đếm thiếu giá vốn: SKU có tên vs dòng không rõ SKU", () => {
  it("sku rỗng KHÔNG gộp vào đếm SKU — đếm riêng theo DÒNG, mỗi dòng một", () => {
    // Hai dòng sku rỗng là hai dòng hàng KHÁC NHAU (Pancake không trả display_id — đơn Shopee
    // thiếu variation_info). Gộp chúng thành một "SKU rỗng" vừa đếm hụt vừa gây hiểu nhầm: chủ
    // shop không thể tìm SKU "" trong màn Sản phẩm để nhập giá.
    const r = calcPnlCore(
      [
        {
          status: "COMPLETED",
          channelId: "shopee",
          itemsTotal: 300_000,
          discount: 0,
          platformFeeEst: 0,
          items: [
            { sku: "", quantity: 1, costPrice: null },
            { sku: "", quantity: 2, costPrice: null },
            { sku: "X", quantity: 1, costPrice: null },
            { sku: "X", quantity: 3, costPrice: null }, // cùng SKU X lặp ở dòng khác → vẫn 1 SKU
          ],
        },
      ],
      [],
    );
    // X có tên nhưng costPrice null ⇒ không khớp biến thể ⇒ thuộc nhóm KHÔNG sửa được, cùng chỗ
    // với hai dòng sku rỗng. Không SKU nào ở đây nhập giá vốn được ⇒ skuMissingCount = 0.
    expect(r.skuMissingCount).toBe(0);
    expect(r.skuUnknownLineCount).toBe(4);
    expect(r.cogs).toBe(0);
  });

  it("SKU có tên nhưng KHÔNG khớp Variant (costPrice null) KHÔNG vào skuMissingCount", () => {
    // Phân biệt sống-còn cho cái LINK cảnh báo: bộ lọc "đã bán, thiếu giá vốn" ở màn Sản phẩm join
    // qua `OrderItem.variantId`, nên dòng không khớp Variant nào KHÔNG BAO GIỜ xuất hiện ở đó.
    // Đếm chúng vào `skuMissingCount` là bật link dẫn tới danh sách chắc chắn thiếu đúng dòng đang
    // cảnh báo. Chỉ SKU có tên VÀ có Variant (costPrice = 0) mới sửa được ở màn đó.
    const r = calcPnlCore(
      [
        {
          status: "COMPLETED",
          channelId: "shopee",
          itemsTotal: 300_000,
          discount: 0,
          platformFeeEst: 0,
          items: [
            { sku: "CO-VARIANT", quantity: 1, costPrice: 0 }, // có Variant, giá vốn chưa nhập
            { sku: "KHONG-KHOP", quantity: 1, costPrice: null }, // KHÔNG có Variant
            { sku: "", quantity: 1, costPrice: null }, // không rõ SKU
          ],
        },
      ],
      [],
    );
    expect(r.skuMissingCount).toBe(1); // chỉ CO-VARIANT
    expect(r.skuUnknownLineCount).toBe(2); // KHONG-KHOP + dòng sku rỗng: đều không sửa được ở màn SP
  });

  it("đủ giá vốn → cả hai bộ đếm bằng 0", () => {
    const r = calcPnlCore([baseOrder], []);
    expect(r.skuMissingCount).toBe(0);
    expect(r.skuUnknownLineCount).toBe(0);
  });
});

describe("calcPnlCore — guard số cố định", () => {
  it("1. đơn COMPLETED chuẩn tính đúng từng dòng", () => {
    const r = calcPnlCore([baseOrder], []);
    expect(r.revenue).toBe(500_000);
    expect(r.platformFee).toBe(62_500);
    expect(r.voucher).toBe(20_000);
    expect(r.netRevenue).toBe(417_500);
    expect(r.cogs).toBe(250_000);
    expect(r.grossProfit).toBe(167_500);
    expect(r.netProfit).toBe(167_500);
    expect(r.orderCount).toBe(1);
    expect(r.returnBomOrderCount).toBe(0);
    expect(r.skuMissingCount).toBe(0);
  });

  it("2. đơn RETURNED bị loại khỏi doanh thu VÀ phí sàn", () => {
    const returned: PnlOrderInput = {
      status: "RETURNED",
      channelId: "shopee",
      itemsTotal: 300_000,
      discount: 0,
      platformFeeEst: 37_500,
      items: [{ sku: "C", quantity: 1, costPrice: 80_000 }],
    };
    const r = calcPnlCore([baseOrder, returned], []);
    // Giữ NGUYÊN case 1 — loại cả doanh thu lẫn phí sàn của đơn hoàn.
    expect(r.revenue).toBe(500_000);
    expect(r.platformFee).toBe(62_500);
    expect(r.voucher).toBe(20_000);
    expect(r.cogs).toBe(250_000);
    expect(r.orderCount).toBe(1);
    expect(r.returnBomOrderCount).toBe(1);
  });

  it("3. danh mục 'purchase' (Nhập hàng) KHÔNG BAO GIỜ vào P&L", () => {
    const purchase: PnlExpenseInput = {
      categoryId: "purchase",
      adsSource: null,
      channelId: null,
      amount: 50_000_000,
    };
    const withPurchase = calcPnlCore([baseOrder], [purchase]);
    const without = calcPnlCore([baseOrder], []);
    expect(withPurchase.netProfit).toBe(without.netProfit);
    expect(withPurchase.netProfit).toBe(167_500);
    expect(withPurchase.other).toBe(0); // purchase KHÔNG rơi vào "other"
  });

  it("4. COGS dùng giá vốn HIỆN HÀNH — sửa giá đổi cả kỳ cũ", () => {
    const bumped: PnlOrderInput = {
      ...baseOrder,
      items: [
        { sku: "A", quantity: 2, costPrice: 120_000 }, // 100.000 → 120.000
        { sku: "B", quantity: 1, costPrice: 50_000 },
      ],
    };
    const r = calcPnlCore([bumped], []);
    expect(r.cogs).toBe(290_000);
    // netProfit giảm đúng 40.000 = (120.000−100.000) × 2.
    expect(r.netProfit).toBe(167_500 - 40_000);
    expect(r.netProfit).toBe(127_500);
  });

  it("5. adsBySource giữ mọi key — SHOPEE_ADS KHÔNG nuốt vào KHAC", () => {
    const expenses: PnlExpenseInput[] = [
      { categoryId: "ads", adsSource: "META", channelId: null, amount: 200_000 },
      { categoryId: "ads", adsSource: "TIKTOK_ADS", channelId: null, amount: 100_000 },
      { categoryId: "ads", adsSource: "SHOPEE_ADS", channelId: null, amount: 50_000 },
      { categoryId: "ads", adsSource: null, channelId: null, amount: 30_000 },
    ];
    const r = calcPnlCore([baseOrder], expenses);
    expect(r.ads).toBe(380_000);
    expect(r.adsBySource).toEqual({
      META: 200_000,
      TIKTOK_ADS: 100_000,
      SHOPEE_ADS: 50_000,
      KHAC: 30_000,
    });
    // Σ nguồn con = dòng cha.
    const sumChildren = Object.values(r.adsBySource).reduce((a, b) => a + b, 0);
    expect(sumChildren).toBe(r.ads);
    // netProfit trừ đúng tổng ads.
    expect(r.netProfit).toBe(167_500 - 380_000);
  });

  it("6. item costPrice null (variantId null) → bỏ qua COGS dòng, đếm vào nhóm KHÔNG khớp Variant", () => {
    const order: PnlOrderInput = {
      status: "COMPLETED",
      channelId: "shopee",
      itemsTotal: 200_000,
      discount: 0,
      platformFeeEst: 25_000,
      items: [
        { sku: "X", quantity: 1, costPrice: null },
        { sku: "Y", quantity: 2, costPrice: 30_000 },
      ],
    };
    const r = calcPnlCore([order], []);
    expect(r.cogs).toBe(60_000); // chỉ Y (2×30.000), bỏ X
    expect(r.skuMissingCount).toBe(0); // X không khớp Variant nào ⇒ KHÔNG phải tập sửa được
    expect(r.skuUnknownLineCount).toBe(1);
    expect(r.revenue).toBe(200_000);
    expect(r.netRevenue).toBe(175_000);
    expect(r.grossProfit).toBe(115_000);
  });

  it("7. channelId 'shopee' — chỉ kênh đó + chi phí gắn kênh & ∉ {purchase, fixed}", () => {
    const shopeeOrder: PnlOrderInput = {
      status: "COMPLETED",
      channelId: "shopee",
      itemsTotal: 500_000,
      discount: 20_000,
      platformFeeEst: 62_500,
      items: [{ sku: "A", quantity: 1, costPrice: 100_000 }],
    };
    const tiktokOrder: PnlOrderInput = {
      status: "COMPLETED",
      channelId: "tiktok",
      itemsTotal: 999_999,
      discount: 0,
      platformFeeEst: 50_000,
      items: [{ sku: "Z", quantity: 1, costPrice: 111_111 }],
    };
    const expenses: PnlExpenseInput[] = [
      { categoryId: "ads", adsSource: "SHOPEE_ADS", channelId: "shopee", amount: 100_000 }, // ĐƯỢC trừ
      { categoryId: "fixed", adsSource: null, channelId: "shopee", amount: 50_000 }, // fixed → KHÔNG trừ
      { categoryId: "ads", adsSource: "TIKTOK_ADS", channelId: "tiktok", amount: 70_000 }, // kênh khác → KHÔNG
      { categoryId: "packaging", adsSource: null, channelId: null, amount: 30_000 }, // chưa gắn kênh → KHÔNG
    ];
    const r = calcPnlCore([shopeeOrder, tiktokOrder], expenses, { channelId: "shopee" });
    expect(r.revenue).toBe(500_000); // đơn tiktok KHÔNG vào doanh thu
    expect(r.platformFee).toBe(62_500);
    expect(r.voucher).toBe(20_000);
    expect(r.netRevenue).toBe(417_500);
    expect(r.cogs).toBe(100_000); // costPrice đơn tiktok không tính
    expect(r.grossProfit).toBe(317_500);
    expect(r.ads).toBe(100_000);
    expect(r.adsBySource).toEqual({ SHOPEE_ADS: 100_000 });
    expect(r.fixed).toBe(0); // fixed gắn kênh vẫn KHÔNG phân bổ
    expect(r.packaging).toBe(0); // packaging chưa gắn kênh
    expect(r.other).toBe(0);
    expect(r.netProfit).toBe(217_500); // 317.500 − 100.000
    expect(r.orderCount).toBe(1);
    expect(r.returnBomOrderCount).toBe(0);
  });

  it("8. returnedOrderFee = Σ returnedFee đơn hoàn/hủy, trừ ở lãi ròng, KHÔNG đụng doanh thu", () => {
    const returnedWithFee: PnlOrderInput = {
      status: "RETURNED",
      channelId: "shopee",
      itemsTotal: 230_000,
      discount: 0,
      platformFeeEst: 1_620,
      returnedFee: 1_620, // phí thực sàn giữ
      items: [{ sku: "C", quantity: 1, costPrice: 80_000 }],
    };
    const cancelledWithFee: PnlOrderInput = {
      status: "CANCELLED",
      channelId: "tiktok",
      itemsTotal: 300_000,
      discount: 0,
      platformFeeEst: 15_000, // phí TẠM
      returnedFee: 0, // chưa đối soát → sàn giữ 0
      items: [],
    };
    const r = calcPnlCore([baseOrder, returnedWithFee, cancelledWithFee], []);
    // Doanh thu / phí sàn / voucher / cogs GIỮ NGUYÊN case 1 (đơn hoàn/hủy vẫn ngoài doanh thu)
    expect(r.revenue).toBe(500_000);
    expect(r.platformFee).toBe(62_500);
    expect(r.voucher).toBe(20_000);
    expect(r.cogs).toBe(250_000);
    expect(r.grossProfit).toBe(167_500);
    // returnedOrderFee = 1.620 (returned) + 0 (cancelled) = 1.620
    expect(r.returnedOrderFee).toBe(1_620);
    // netProfit giảm đúng bằng returnedOrderFee
    expect(r.netProfit).toBe(167_500 - 1_620);
  });

  it("9. returnedFee trên đơn HỢP LỆ KHÔNG bị cộng (chỉ tính đơn hoàn/hủy)", () => {
    const validWithReturnedFee: PnlOrderInput = { ...baseOrder, returnedFee: 9_999 };
    const r = calcPnlCore([validWithReturnedFee], []);
    expect(r.returnedOrderFee).toBe(0);
    expect(r.netProfit).toBe(167_500);
  });
});

/**
 * Lãi vay (danh mục `interest`) — chi phí TÀI CHÍNH thật, có dòng riêng ở bảng Lãi/Lỗ
 * (quyết định chủ shop 07/09, Q6-B). Tiền GỐC vay/trả gốc KHÔNG ở đây (trục dòng tiền).
 * Hai ca canh dưới đây là hai cách hỏng khác hẳn nhau: quên thêm `interest` vào `KNOWN`
 * ⇒ nó rơi vào "Khác" (số tổng vẫn đúng, dòng riêng mất); quên trừ ở `netProfit`
 * ⇒ danh mục biến mất khỏi lợi nhuận mà mọi test cũ vẫn xanh.
 */
describe("calcPnlCore — Lãi vay (danh mục interest) là chi phí thật, dòng riêng, KHÔNG phân bổ kênh", () => {
  const laiVay: PnlExpenseInput = { categoryId: "interest", adsSource: null, channelId: null, amount: 5_000_000 };

  it("toàn shop: interest = 5tr, netProfit giảm ĐÚNG 5tr, other KHÔNG đổi", () => {
    const r = calcPnlCore([baseOrder], [laiVay]);
    expect(r.interest).toBe(5_000_000);
    expect(r.other).toBe(0); // KHÔNG rơi vào "Khác" — interest đã vào KNOWN
    expect(r.netProfit).toBe(167_500 - 5_000_000);
  });

  it("lăng kính kênh: lãi vay là chi phí CHUNG như mặt bằng ⇒ interest = 0, netProfit không trừ", () => {
    const r = calcPnlCore([baseOrder], [{ ...laiVay, channelId: "shopee" }], { channelId: "shopee" });
    expect(r.interest).toBe(0);
    expect(r.netProfit).toBe(167_500);
  });
});

/**
 * Thu nhập tài chính (bảng `ThuNhap` — v1 chỉ có lãi sổ tiết kiệm) là phép CỘNG DUY NHẤT vào
 * `netProfit` ngoài doanh thu bán hàng. Hai cách hỏng khác hẳn nhau: quên cộng vào `netProfit`
 * ⇒ tháng đáo hạn báo lỗ oan đúng bằng số lãi; quên ép 0 dưới lăng kính kênh ⇒ lãi tiết kiệm bị
 * gán cho một kênh bán, bịa lãi cho kênh đó (cùng luật `fixed`/`interest`).
 */
describe("calcPnlCore — Thu nhập tài chính CỘNG vào lãi ròng, KHÔNG phân bổ kênh", () => {
  const lai: PnlIncomeInput = { amount: 2_000_000 };

  it("toàn shop: financialIncome = 2tr, netProfit tăng ĐÚNG 2tr", () => {
    const r = calcPnlCore([baseOrder], [], { incomes: [lai] });
    expect(r.financialIncome).toBe(2_000_000);
    expect(r.netProfit).toBe(167_500 + 2_000_000);
  });

  it("không truyền incomes → financialIncome = 0, netProfit y hệt trước (caller cũ không đổi số)", () => {
    const r = calcPnlCore([baseOrder], []);
    expect(r.financialIncome).toBe(0);
    expect(r.netProfit).toBe(167_500);
  });

  it("nhiều sổ tất toán cùng kỳ → cộng dồn, không lấy dòng đầu", () => {
    const r = calcPnlCore([baseOrder], [], { incomes: [{ amount: 1_200_000 }, { amount: 800_000 }] });
    expect(r.financialIncome).toBe(2_000_000);
    expect(r.netProfit).toBe(167_500 + 2_000_000);
  });

  it("lăng kính kênh: lãi tiết kiệm không thuộc kênh bán nào ⇒ financialIncome = 0, netProfit không cộng", () => {
    const r = calcPnlCore([baseOrder], [], { channelId: "shopee", incomes: [lai] });
    expect(r.financialIncome).toBe(0);
    expect(r.netProfit).toBe(167_500);
  });
});
