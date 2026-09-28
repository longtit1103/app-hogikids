import { describe, expect, it } from "vitest";

import { mapPancakeOrder, type MapOrderCtx } from "@/lib/ingest/pancake-mapping";
import { pancakeOrderSchema } from "@/lib/ingest/pancake-schemas";
import { phanBoVoucherSanTheoDong, voucherSanApDung } from "@/lib/ingest/voucher-san-tai-tro";

/**
 * VOUCHER DO SÀN TÀI TRỢ không được trừ khỏi doanh thu (sàn trả thay khách, shop vẫn nhận đủ).
 * Số kỳ vọng là LITERAL tính tay từ đơn THẬT — xem `voucher-san-tai-tro.ts` để biết bằng chứng.
 */

const CTX: MapOrderCtx = { channels: { tiktok: { platformFeePct: 0, paymentFeePct: 0 } } };

const donTikTok = (over: Record<string, unknown>) =>
  pancakeOrderSchema.parse({
    id: "V1",
    status: 3,
    inserted_at: "2026-07-24T07:09:20.000000",
    order_sources_name: "Tiktok",
    marketplace_id: "-9",
    total_price: 230000,
    total_discount: 0,
    fee_marketplace: 0,
    items: [{ quantity: 1, discount_each_product: 0, variation_info: { display_id: "X1", retail_price: 230000 } }],
    ...over,
  });

describe("phanBoVoucherSanTheoDong — chia voucher mức đơn về từng dòng", () => {
  it("Σ phân bổ === voucher, không dòng nào vượt giảm giá của chính nó", () => {
    const dong = [30000, 15000, 5000];
    const p = phanBoVoucherSanTheoDong(dong, 20000);
    expect(p.reduce((s, v) => s + v, 0)).toBe(20000);
    p.forEach((v, i) => {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(dong[i]);
    });
  });

  it("chia hết không lẻ: 3 dòng bằng nhau, voucher chia 3", () => {
    expect(phanBoVoucherSanTheoDong([10000, 10000, 10000], 9000)).toEqual([3000, 3000, 3000]);
  });

  it("phần lẻ rải theo phần dư lớn nhất, tổng vẫn khớp tuyệt đối (không lệch làm tròn)", () => {
    const p = phanBoVoucherSanTheoDong([1, 1, 1], 2);
    expect(p.reduce((s, v) => s + v, 0)).toBe(2);
    expect(p).toEqual([1, 1, 0]); // hoà phần lẻ → ưu tiên dòng đầu (TẤT ĐỊNH)
  });

  it("cùng input luôn cho cùng output (rebuild-from-raw phải dựng lại y hệt)", () => {
    const dong = [7777, 3333, 1111, 999];
    const a = phanBoVoucherSanTheoDong(dong, 5000);
    expect(phanBoVoucherSanTheoDong(dong, 5000)).toEqual(a);
    expect(a.reduce((s, v) => s + v, 0)).toBe(5000);
  });

  it("voucher lớn hơn Σ giảm giá dòng → kẹp, không đẩy doanh thu vượt giá gốc", () => {
    expect(voucherSanApDung(98000, 49000)).toBe(49000);
    expect(phanBoVoucherSanTheoDong([49000], 98000)).toEqual([49000]);
  });

  it("voucher 0 / âm / không có dòng giảm giá → không phân bổ gì", () => {
    expect(phanBoVoucherSanTheoDong([30000, 10000], 0)).toEqual([0, 0]);
    expect(phanBoVoucherSanTheoDong([30000, 10000], -5000)).toEqual([0, 0]);
    expect(phanBoVoucherSanTheoDong([0, 0], 10000)).toEqual([0, 0]);
    expect(phanBoVoucherSanTheoDong([], 10000)).toEqual([]);
  });
});

describe("mapPancakeOrder — voucher sàn không bị trừ khỏi doanh thu", () => {
  it("đơn THẬT #580 (24/07): giảm giá dòng 40.800, sàn tài trợ 30.800 → itemsTotal 220.000", () => {
    const m = mapPancakeOrder(
      donTikTok({
        items: [
          { quantity: 1, discount_each_product: 40800, variation_info: { display_id: "SP000316", retail_price: 230000 } },
        ],
        advanced_platform_fee: { marketplace_voucher: 30800 },
        fee_marketplace: 66755,
      }),
      CTX
    );
    expect(m.itemsTotal).toBe(220000); // 230.000 − (40.800 − 30.800)
    expect(m.items[0].lineDiscount).toBe(10000); // chỉ phần shop chịu
    // Đối chiếu tiền THỰC về: cod Pancake 153.245 = 220.000 − 66.755.
    expect(m.itemsTotal - m.platformFeeEst).toBe(153245);
  });

  it("đơn THẬT #573 (15/07): sàn tài trợ TRỌN 15.000 → itemsTotal = giá gốc 360.000", () => {
    const m = mapPancakeOrder(
      donTikTok({
        total_price: 360000,
        items: [
          { quantity: 1, discount_each_product: 15000, variation_info: { display_id: "SP000423", retail_price: 360000 } },
        ],
        advanced_platform_fee: { marketplace_voucher: 15000 },
        fee_marketplace: 101655,
      }),
      CTX
    );
    expect(m.itemsTotal).toBe(360000);
    expect(m.items[0].lineDiscount).toBe(0);
    expect(m.itemsTotal - m.platformFeeEst).toBe(258345); // = cod Pancake
  });

  it("không có advanced_platform_fee → giữ nguyên cách cũ (trừ hết giảm giá dòng)", () => {
    const m = mapPancakeOrder(
      donTikTok({
        items: [
          { quantity: 1, discount_each_product: 111000, variation_info: { display_id: "SP000449", retail_price: 400000 } },
        ],
        total_price: 400000,
      }),
      CTX
    );
    expect(m.itemsTotal).toBe(289000);
    expect(m.items[0].lineDiscount).toBe(111000);
  });

  it("nhiều dòng: chia voucher về TỪNG DÒNG đúng số, Σ doanh thu dòng khớp itemsTotal", () => {
    const m = mapPancakeOrder(
      donTikTok({
        total_price: 350000, // = 2×100.000 + 3×50.000
        items: [
          { quantity: 2, discount_each_product: 30001, variation_info: { display_id: "A", retail_price: 100000 } },
          { quantity: 3, discount_each_product: 15000, variation_info: { display_id: "B", retail_price: 50000 } },
        ],
        advanced_platform_fee: { marketplace_voucher: 20000 },
      }),
      CTX
    );
    // Tính tay: giảm giá dòng A = 2×30.001 = 60.002; B = 3×15.000 = 45.000; Σ = 105.002.
    // Shop chịu = 105.002 − 20.000 = 85.002 → itemsTotal = 350.000 − 85.002 = 264.998.
    expect(m.itemsTotal).toBe(264998);
    // Chia voucher theo tỉ lệ: A = 20.000×60.002/105.002 = 11.428,7 → 11.428 (+1 phần dư) = 11.429;
    //                          B = 20.000×45.000/105.002 =  8.571,3 →  8.571. Tổng đúng 20.000.
    // ⇒ lineDiscount A = 60.002 − 11.429 = 48.573; B = 45.000 − 8.571 = 36.429.
    expect(m.items.map((it) => it.lineDiscount)).toEqual([48573, 36429]);
    // Σ doanh thu dòng: (2×100.000 − 48.573) + (3×50.000 − 36.429) = 151.427 + 113.571 = 264.998.
    expect(m.items.reduce((s, it) => s + it.unitPrice * it.quantity - it.lineDiscount, 0)).toBe(264998);
  });

  it("dòng KHÔNG giảm giá không bị gánh voucher của dòng khác", () => {
    const m = mapPancakeOrder(
      donTikTok({
        total_price: 300000, // = 1×200.000 + 1×100.000
        items: [
          { quantity: 1, discount_each_product: 50000, variation_info: { display_id: "A", retail_price: 200000 } },
          { quantity: 1, discount_each_product: 0, variation_info: { display_id: "B", retail_price: 100000 } },
        ],
        advanced_platform_fee: { marketplace_voucher: 30000 },
      }),
      CTX
    );
    expect(m.items.map((it) => it.lineDiscount)).toEqual([20000, 0]); // B giữ nguyên 0, KHÔNG âm
    expect(m.itemsTotal).toBe(280000); // 300.000 − (50.000 − 30.000)
  });

  it("cổng chặn ngữ nghĩa: item.total_discount lệch quantity×discount_each_product → warning", () => {
    const m = mapPancakeOrder(
      donTikTok({
        items: [
          {
            quantity: 2,
            discount_each_product: 10000,
            total_discount: 10000, // Pancake ghi kiểu CŨ (mức dòng) ⇒ lệch 20.000
            variation_info: { display_id: "X1", retail_price: 115000 },
          },
        ],
      }),
      CTX
    );
    expect(m.warnings.some((w) => w.includes("có thể đã đổi nghĩa field"))).toBe(true);
  });

  it("voucher > Σ giảm giá dòng → kẹp + warning (dữ liệu Pancake bất thường, có thật 4 đơn)", () => {
    const m = mapPancakeOrder(
      donTikTok({
        total_price: 700000,
        items: [
          { quantity: 1, discount_each_product: 49000, variation_info: { display_id: "X1", retail_price: 700000 } },
        ],
        advanced_platform_fee: { marketplace_voucher: 98000 },
      }),
      CTX
    );
    expect(m.itemsTotal).toBe(700000); // KHÔNG thành 749.000
    expect(m.warnings.some((w) => w.includes("voucher sàn tài trợ"))).toBe(true);
  });

  it("voucher âm → coi như 0 (không thổi phồng doanh thu)", () => {
    const m = mapPancakeOrder(
      donTikTok({
        items: [
          { quantity: 1, discount_each_product: 30000, variation_info: { display_id: "X1", retail_price: 230000 } },
        ],
        advanced_platform_fee: { marketplace_voucher: -50000 },
      }),
      CTX
    );
    expect(m.itemsTotal).toBe(200000);
  });
});
