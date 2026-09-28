import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { khachTheoKy } from "@/lib/reports/marketing/khach-tiktok";
import { prisma } from "@/lib/prisma";

import { seedReference, truncateBusinessTables } from "../helpers/test-db";
import { taoDon } from "./tao-don-gia";

/**
 * Khách mới ↔ quay lại — HAI ĐỊNH NGHĨA, hai con số, hai nhãn (spec §5.1b). Gộp lại là bịa:
 * "trong cửa sổ app" cắt được kỳ nhưng chỉ thấy phần lịch sử app giữ; "lifetime shop"
 * (`customer.order_count`) là snapshot của sàn, KHÔNG cắt kỳ được.
 */
const RANGE = { from: new Date("2026-05-01T00:00:00+07:00"), to: new Date("2026-05-31T00:00:00+07:00") };
const TRONG_KY = new Date("2026-05-15T00:00:00+07:00");
const NGOAI_KY = new Date("2026-04-15T00:00:00+07:00");

const khach = (id: string | null, lifetime?: number) => ({
  customer: { ...(id === null ? {} : { id }), ...(lifetime === undefined ? {} : { order_count: lifetime }) },
});

beforeAll(async () => {
  await seedReference();
}, 60_000);
beforeEach(async () => {
  await truncateBusinessTables();
});
afterAll(async () => {
  await prisma.$disconnect();
});

describe("khachTheoKy", () => {
  it("khách MỚI vs QUAY LẠI tính theo cửa sổ app (có đơn hợp lệ trước range.from hay chưa)", async () => {
    await taoDon({ orderedAt: NGOAI_KY, itemsTotal: 100_000, raw: khach("K1") }); // K1 đã mua trước kỳ
    await taoDon({ orderedAt: TRONG_KY, itemsTotal: 200_000, raw: khach("K1") }); // ⇒ quay lại
    await taoDon({ orderedAt: TRONG_KY, itemsTotal: 300_000, raw: khach("K2") }); // ⇒ mới
    await taoDon({ orderedAt: TRONG_KY, itemsTotal: 400_000, raw: khach("K2") }); // K2 mua 2 lần TRONG kỳ, vẫn là 1 khách mới

    const r = await khachTheoKy(RANGE);
    expect(r.khachTrongKy).toBe(2);
    expect(r.khachMoiTrongKy).toBe(1);
    expect(r.khachQuayLaiTrongKy).toBe(1);
    expect(r.donHopLeTrongKy).toBe(3);
  });

  it("đơn KHÔNG có khoá khách đếm riêng, không lẫn vào số khách (Shopee mù 60% — đo 24/08)", async () => {
    await taoDon({ orderedAt: TRONG_KY, itemsTotal: 100_000, raw: khach(null) });
    await taoDon({ orderedAt: TRONG_KY, itemsTotal: 100_000, raw: { customer: { id: "" } } });
    await taoDon({ orderedAt: TRONG_KY, itemsTotal: 100_000, raw: {} });
    await taoDon({ orderedAt: TRONG_KY, itemsTotal: 100_000, raw: khach("K9") });

    const r = await khachTheoKy(RANGE);
    expect(r.donHopLeTrongKy).toBe(4);
    expect(r.donThieuKhoaKhach).toBe(3);
    expect(r.khachTrongKy).toBe(1);
  });

  it("tỉ lệ LIFETIME đọc `customer.order_count` — con số KHÁC với 'quay lại trong kỳ'", async () => {
    // K3 mới với app (chưa đơn nào trước kỳ) NHƯNG sàn báo đã mua 5 lần ⇒ mới-theo-app, quay-lại-theo-lifetime.
    await taoDon({ orderedAt: TRONG_KY, itemsTotal: 100_000, raw: khach("K3", 5) });
    await taoDon({ orderedAt: TRONG_KY, itemsTotal: 100_000, raw: khach("K4", 1) });
    await taoDon({ orderedAt: TRONG_KY, itemsTotal: 100_000, raw: khach("K5") }); // sàn không trả order_count

    const r = await khachTheoKy(RANGE);
    expect(r.khachMoiTrongKy).toBe(3); // theo cửa sổ app: cả 3 đều mới
    expect(r.khachCoSoLieuLifetime).toBe(2); // chỉ 2 khách có số lifetime để chia
    expect(r.khachLifetimeQuayLai).toBe(1); // K3
  });

  it("lọc theo kênh", async () => {
    await taoDon({ channelId: "tiktok", orderedAt: TRONG_KY, itemsTotal: 100_000, raw: khach("K6") });
    await taoDon({ channelId: "shopee", orderedAt: TRONG_KY, itemsTotal: 100_000, raw: khach("K7") });
    expect((await khachTheoKy(RANGE, { channelId: "tiktok" })).khachTrongKy).toBe(1);
    expect((await khachTheoKy(RANGE, { channelId: "shopee" })).donHopLeTrongKy).toBe(1);
  });

  it("đơn hoàn/hủy KHÔNG tính — cả trong kỳ lẫn ở cửa sổ 'trước kỳ' (cùng tập với pnl.ts)", async () => {
    // Đơn hoàn TRƯỚC kỳ không được biến K8 thành khách quay lại: nó không phải giao dịch thành công.
    await taoDon({ orderedAt: NGOAI_KY, itemsTotal: 100_000, status: "RETURNED", raw: khach("K8") });
    await taoDon({ orderedAt: TRONG_KY, itemsTotal: 100_000, raw: khach("K8") });
    await taoDon({ orderedAt: TRONG_KY, itemsTotal: 100_000, status: "CANCELLED", raw: khach("K10") });

    const r = await khachTheoKy(RANGE);
    expect(r.donHopLeTrongKy).toBe(1);
    expect(r.khachTrongKy).toBe(1);
    expect(r.khachMoiTrongKy).toBe(1);
    expect(r.khachQuayLaiTrongKy).toBe(0);
  });

  it("đơn ngoài kỳ KHÔNG lọt vào (cùng biên kỳ với calcPnl)", async () => {
    await taoDon({ orderedAt: NGOAI_KY, itemsTotal: 999_000, raw: khach("K11") });
    // Biên PHẢI là hết ngày `to`, không phải 00:00 — đơn 23:30 ngày cuối kỳ phải được tính.
    await taoDon({
      orderedAt: new Date("2026-05-31T23:30:00+07:00"),
      itemsTotal: 50_000,
      raw: khach("K12"),
    });

    const r = await khachTheoKy(RANGE);
    expect(r.donHopLeTrongKy).toBe(1);
    expect(r.khachTrongKy).toBe(1);
    expect(r.khachMoiTrongKy).toBe(1);
    expect(r.khachQuayLaiTrongKy).toBe(0);
  });
});
