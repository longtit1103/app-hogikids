import { describe, expect, it } from "vitest";

import { mapPancakeOrder, type MapOrderCtx } from "@/lib/ingest/pancake-mapping";
import { pancakeOrderSchema } from "@/lib/ingest/pancake-schemas";

const ctx: MapOrderCtx = { channels: {} };

// Payload tối thiểu hợp lệ (khớp pancakeOrderSchema) — status 3 = COMPLETED.
function rawOrder(over: Record<string, unknown>) {
  return pancakeOrderSchema.parse({
    id: "584888566020736389",
    status: 3,
    inserted_at: "2026-07-06T11:34:47.000000",
    order_sources_name: "Shopee",
    total_price: 230_000,
    total_discount: 0,
    shipping_fee: 0,
    fee_marketplace: 1_620,
    items: [],
    ...over,
  });
}

describe("mapPancakeOrder — statusChangedAt từ status_history", () => {
  it("lấy updated_at của entry khớp status hiện tại, neo UTC (naive = giờ UTC)", () => {
    const mo = mapPancakeOrder(
      rawOrder({
        status_history: [
          { status: 0, updated_at: "2026-07-06T11:34:58" },
          { status: 3, updated_at: "2026-07-08T02:10:00" },
        ],
      }),
      ctx,
    );
    expect(mo.statusChangedAt?.toISOString()).toBe("2026-07-08T02:10:00.000Z");
  });

  it("nhiều entry cùng status (đổi qua lại) → lấy mốc MUỘN nhất", () => {
    const mo = mapPancakeOrder(
      rawOrder({
        status_history: [
          { status: 3, updated_at: "2026-07-07T00:00:00" },
          { status: 4, updated_at: "2026-07-08T00:00:00" },
          { status: 3, updated_at: "2026-07-09T05:00:00" },
        ],
      }),
      ctx,
    );
    expect(mo.statusChangedAt?.toISOString()).toBe("2026-07-09T05:00:00.000Z");
  });

  it("không entry nào khớp status hiện tại → fallback updated_at đầu đơn", () => {
    const mo = mapPancakeOrder(
      rawOrder({
        updated_at: "2026-07-06T11:35:18.865797",
        status_history: [{ status: 0, updated_at: "2026-07-06T11:34:58" }],
      }),
      ctx,
    );
    expect(mo.statusChangedAt?.toISOString()).toBe("2026-07-06T11:35:18.865Z");
  });

  it("không status_history, có updated_at → dùng updated_at", () => {
    const mo = mapPancakeOrder(rawOrder({ updated_at: "2026-07-06T11:35:18.865797" }), ctx);
    expect(mo.statusChangedAt?.toISOString()).toBe("2026-07-06T11:35:18.865Z");
  });

  it("không status_history lẫn updated_at → null; entry thiếu updated_at bị bỏ qua", () => {
    expect(mapPancakeOrder(rawOrder({}), ctx).statusChangedAt).toBeNull();
    const mo = mapPancakeOrder(rawOrder({ status_history: [{ status: 3, updated_at: null }] }), ctx);
    expect(mo.statusChangedAt).toBeNull();
  });

  it("status_history dị dạng KHÔNG làm rớt đơn — schema catch → fallback updated_at/null", () => {
    // Không phải mảng → catch về undefined, đơn vẫn parse OK, fallback updated_at.
    const notArray = mapPancakeOrder(
      rawOrder({ status_history: "corrupt", updated_at: "2026-07-06T11:35:18.865797" }),
      ctx,
    );
    expect(notArray.statusChangedAt?.toISOString()).toBe("2026-07-06T11:35:18.865Z");
    // Entry có status là object (không scalar) → cả mảng catch → null (không có updated_at).
    const badEntry = mapPancakeOrder(
      rawOrder({ status_history: [{ status: { weird: true }, updated_at: "2026-07-06T11:34:58" }] }),
      ctx,
    );
    expect(badEntry.statusChangedAt).toBeNull();
  });

  it("updated_at SAI KHUÔN ⇒ null, KHÔNG trả về một mốc thời gian hỏng", () => {
    // `updated_at` chỉ bị zod ép là chuỗi nên mọi khuôn lạ đều lọt. Trả về một Date hỏng thì cả lượt
    // ghi đơn bị Prisma từ chối — tức MẤT DOANH THU chỉ vì một mốc PHỤ (`statusChangedAt` không
    // tham gia P&L, chỉ để hiển thị "đơn vào trạng thái này lúc nào"). Hạ về null an toàn hơn nhiều.
    for (const xau of ["khong-phai-ngay", "01/07/2026", "2026-13-40T10:00:00", ""]) {
      const mo = mapPancakeOrder(rawOrder({ status_history: null, updated_at: xau }), ctx);
      expect(mo.statusChangedAt).toBeNull();
    }
  });
});
