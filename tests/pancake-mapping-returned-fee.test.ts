import { describe, expect, it } from "vitest";

import { mapPancakeOrder, type MapOrderCtx } from "@/lib/ingest/pancake-mapping";
import { pancakeOrderSchema } from "@/lib/ingest/pancake-schemas";

const ctx: MapOrderCtx = { channels: {} };

// Payload tối thiểu hợp lệ để mapPancakeOrder chạy (khớp pancakeOrderSchema).
function rawOrder(over: Record<string, unknown>) {
  return pancakeOrderSchema.parse({
    id: "584888566020736389",
    status: 4, // RETURNED
    inserted_at: "2026-04-21T10:00:00.000000",
    order_sources_name: "Shopee",
    total_price: 230_000,
    total_discount: 0,
    shipping_fee: 0,
    fee_marketplace: 1_620,
    items: [],
    ...over,
  });
}

describe("mapPancakeOrder — returnedFee từ advanced_platform_fee.returned_fee", () => {
  it("lấy returned_fee khi có", () => {
    const mo = mapPancakeOrder(rawOrder({ advanced_platform_fee: { returned_fee: 1_620 } }), ctx);
    expect(mo.returnedFee).toBe(1_620);
  });

  it("returned_fee vắng/null → 0", () => {
    expect(mapPancakeOrder(rawOrder({ advanced_platform_fee: { platform_commission: 5_000 } }), ctx).returnedFee).toBe(0);
    expect(mapPancakeOrder(rawOrder({}), ctx).returnedFee).toBe(0);
  });

  it("returned_fee âm → clamp 0", () => {
    expect(mapPancakeOrder(rawOrder({ advanced_platform_fee: { returned_fee: -50 } }), ctx).returnedFee).toBe(0);
  });
});
