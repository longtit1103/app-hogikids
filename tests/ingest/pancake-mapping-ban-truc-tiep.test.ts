import { describe, expect, it } from "vitest";

import { mapChannel, mapPancakeOrder, type MapOrderCtx } from "@/lib/ingest/pancake-mapping";
import { pancakeOrderSchema } from "@/lib/ingest/pancake-schemas";

/**
 * Kênh "Bán trực tiếp" — đơn lên từ màn "Bán hàng" Pancake. Payload rút gọn từ đơn THẬT `777`
 * (shop TikTok, 21/09/2026, đã bỏ thông tin khách): 2 dòng 440.000 + 119.000, giảm 39.000 mức đơn,
 * khách chuyển khoản 520.000, nhận tại shop.
 */
const DON_777 = {
  id: 777,
  system_id: 777,
  status: 3,
  status_name: "delivered",
  inserted_at: "2026-09-21T05:55:19.015402",
  order_sources_name: null,
  marketplace_id: null,
  received_at_shop: true,
  total_price: 559000,
  total_discount: 39000,
  shipping_fee: 0,
  fee_marketplace: 0,
  cod: 0,
  prepaid: 520000,
  transfer_money: 520000,
  cash: 0,
  charged_by_card: 0,
  charged_by_momo: 0,
  charged_by_qrpay: 0,
  advanced_platform_fee: {},
  items: [
    { quantity: 1, discount_each_product: 0, total_discount: 0, variation_info: { display_id: "AD01-AD GIAI NHAN-130", retail_price: 440000 } },
    { quantity: 1, discount_each_product: 0, total_discount: 0, variation_info: { display_id: "AD01-CHOANG TO-130", retail_price: 119000 } },
  ],
};

const CTX: MapOrderCtx = {
  channels: {
    website: { platformFeePct: 0, paymentFeePct: 0 },
    direct: { platformFeePct: 0, paymentFeePct: 0 },
  },
};

const map = (patch: Record<string, unknown> = {}) =>
  mapPancakeOrder(pancakeOrderSchema.parse({ ...DON_777, ...patch }), CTX);

describe("mapChannel — bán trực tiếp", () => {
  const w: string[] = [];
  it("đủ 3 dấu (không nguồn, không sàn, nhận tại shop) ⇒ direct, KHÔNG cảnh báo", () => {
    const ww: string[] = [];
    expect(mapChannel({ order_sources_name: "", marketplace_id: null, received_at_shop: true }, ww)).toBe("direct");
    expect(mapChannel({ order_sources_name: null, marketplace_id: undefined, received_at_shop: true }, ww)).toBe("direct");
    expect(ww).toHaveLength(0);
  });
  it("thiếu một dấu ⇒ KHÔNG đoán, về website như cũ", () => {
    expect(mapChannel({ order_sources_name: null, marketplace_id: null, received_at_shop: false }, w)).toBe("website");
    expect(mapChannel({ order_sources_name: null, marketplace_id: null, received_at_shop: null }, w)).toBe("website");
    expect(mapChannel({ order_sources_name: null, marketplace_id: "-9", received_at_shop: true }, w)).toBe("website");
  });
  it("nguồn sàn luôn thắng dấu nhận tại shop", () => {
    expect(mapChannel({ order_sources_name: "Tiktok", marketplace_id: "-9", received_at_shop: true }, w)).toBe("tiktok");
    expect(mapChannel({ order_sources_name: "Affiliate", marketplace_id: null, received_at_shop: true }, w)).toBe("website");
  });
});

describe("mapPancakeOrder — đơn bán trực tiếp", () => {
  it("đơn 777: kênh direct, doanh thu y hệt trước (P&L không đổi), paidAtShop = số khách chuyển", () => {
    const mo = map();
    expect(mo.channelId).toBe("direct");
    expect(mo.itemsTotal).toBe(559000);
    expect(mo.discount).toBe(39000);
    expect(mo.platformFeeEst).toBe(0);
    expect(mo.paidAtShop).toBe(520000);
    expect(mo.warnings).toEqual([]);
  });

  it("cộng đủ 5 khoản thanh toán (chuyển khoản + tiền mặt + thẻ + MoMo + QR)", () => {
    const mo = map({ transfer_money: 200000, cash: 100000, charged_by_card: 120000, charged_by_momo: 50000, charged_by_qrpay: 50000 });
    expect(mo.paidAtShop).toBe(520000);
    expect(mo.warnings).toEqual([]);
  });

  it("đã giao mà trả thiếu ⇒ ghi ĐÚNG số đã trả + cảnh báo (không tự sửa)", () => {
    const mo = map({ transfer_money: 500000 });
    expect(mo.paidAtShop).toBe(500000);
    expect(mo.warnings.some((x) => x.includes("đã trả 500000 ≠ phải trả 520000"))).toBe(true);
  });

  it("ship khách trả tính vào số phải trả", () => {
    expect(map({ shipping_fee: 30000, transfer_money: 550000 }).warnings).toEqual([]);
  });

  it("đơn chưa giao trả trước một phần ⇒ không cảnh báo (đợi giao)", () => {
    expect(map({ status: 1, status_name: "submitted", transfer_money: 100000 }).warnings).toEqual([]);
  });

  it("khoản thanh toán shape lạ ⇒ KHÔNG reject đơn (mất doanh thu), chỉ hụt + cảnh báo", () => {
    const parsed = pancakeOrderSchema.safeParse({ ...DON_777, transfer_money: { la: 1 } });
    expect(parsed.success).toBe(true);
    const mo = mapPancakeOrder(parsed.data!, CTX);
    expect(mo.itemsTotal).toBe(559000);
    expect(mo.paidAtShop).toBe(0);
    expect(mo.warnings.length).toBe(1);
  });

  it("received_at_shop shape lạ ⇒ về website, KHÔNG reject đơn", () => {
    const parsed = pancakeOrderSchema.safeParse({ ...DON_777, received_at_shop: "co" });
    expect(parsed.success).toBe(true);
    expect(mapPancakeOrder(parsed.data!, CTX).channelId).toBe("website");
  });

  it("kênh sàn KHÔNG bao giờ mang paidAtShop (tiền sàn về quỹ qua đường khác)", () => {
    const mo = map({ order_sources_name: "Tiktok", marketplace_id: "-9", fee_marketplace: 0 });
    expect(mo.channelId).toBe("tiktok");
    expect(mo.paidAtShop).toBe(0);
  });
});
