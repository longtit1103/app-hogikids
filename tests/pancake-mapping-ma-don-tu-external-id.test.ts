import { describe, expect, it } from "vitest";

import { mapPancakeOrder, type MapOrderCtx } from "@/lib/ingest/pancake-mapping";
import { pancakeOrderSchema } from "@/lib/ingest/pancake-schemas";

/**
 * `Order.pancakeId` phải là mã LOSSLESS của dòng Bronze (`externalId` rút bằng `elem->>'id'` trong
 * SQL), không phải `String(raw.id)` của payload đã `JSON.parse`.
 *
 * Hôm nay id đơn Pancake là CHUỖI (đo prod) nên hai giá trị trùng nhau — ca "giữ nguyên" đứng đầu để
 * khoá việc KHÔNG đổi một `pancakeId` nào của dữ liệu hiện có. Nếu Pancake/webhook đổi sang số int64,
 * `JSON.parse` làm tròn ⇒ `String(raw.id)` lệch mã thật ⇒ upsert đẻ đơn Silver thứ hai = doanh thu
 * đếm đôi mà cổng đối soát (đếm số lượng) không kêu.
 */
const ctx: MapOrderCtx = { channels: {} };

function rawOrder(id: string | number) {
  return pancakeOrderSchema.parse({
    id,
    status: 3,
    inserted_at: "2026-07-06T11:34:47.000000",
    order_sources_name: "Shopee",
    total_price: 230_000,
    total_discount: 0,
    shipping_fee: 0,
    fee_marketplace: 1_620,
    items: [],
  });
}

describe("mapPancakeOrder — pancakeId từ externalId lossless", () => {
  it("id chuỗi (dữ liệu hiện có) ⇒ pancakeId GIỮ NGUYÊN, không cảnh báo", () => {
    const mo = mapPancakeOrder(rawOrder("584888566020736389"), ctx, "584888566020736389");
    expect(mo.pancakeId).toBe("584888566020736389");
    expect(mo.code).toBe("584888566020736389");
    expect(mo.warnings.filter((w) => w.includes("làm tròn"))).toEqual([]);
  });

  it("không truyền externalId (caller cũ) ⇒ hành vi cũ String(raw.id)", () => {
    expect(mapPancakeOrder(rawOrder("AB123"), ctx).pancakeId).toBe("AB123");
  });

  it("id số int64 bị JSON.parse làm tròn ⇒ dùng externalId lossless + cảnh báo", () => {
    // 584888566020736389 vượt Number.MAX_SAFE_INTEGER ⇒ JSON.parse ra 584888566020736400.
    const daLamTron = JSON.parse('{"id":584888566020736389}').id as number;
    expect(String(daLamTron)).not.toBe("584888566020736389");

    const mo = mapPancakeOrder(rawOrder(daLamTron), ctx, "584888566020736389");
    expect(mo.pancakeId).toBe("584888566020736389");
    expect(mo.code).toBe("584888566020736389"); // không system_id ⇒ mã hiển thị cũng lấy mã lossless
    expect(mo.warnings.some((w) => w.includes("584888566020736389") && w.includes("làm tròn"))).toBe(true);
  });
});
