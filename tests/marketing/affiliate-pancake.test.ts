import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { affiliateTheoKy } from "@/lib/reports/marketing/affiliate-pancake";
import { prisma } from "@/lib/prisma";

import { seedReference, truncateBusinessTables } from "../helpers/test-db";
import { taoDon } from "./tao-don-gia";

/**
 * Affiliate/KOC theo kỳ — TIỀN THẬT Pancake (`advanced_platform_fee.affiliate_commission`).
 * Đo prod 24/08: 69/326 đơn TikTok có khoản này, Σ 1.245.675đ; Shopee KHÔNG có key này.
 * Hai lời khai phải giữ: (1) cùng tập "đơn hợp lệ" với `pnl.ts`; (2) payload dị KHÔNG được làm văng
 * truy vấn — cả trang sẽ trắng chứ không phải sai một dòng.
 */
const RANGE = { from: new Date("2026-05-01T00:00:00+07:00"), to: new Date("2026-05-31T00:00:00+07:00") };
const TRONG_KY = new Date("2026-05-15T00:00:00+07:00");
const NGOAI_KY = new Date("2026-04-15T00:00:00+07:00");

const apf = (hoaHong: unknown) => ({ advanced_platform_fee: { affiliate_commission: hoaHong } });

beforeAll(async () => {
  await seedReference();
}, 60_000);
beforeEach(async () => {
  await truncateBusinessTables();
});
afterAll(async () => {
  await prisma.$disconnect();
});

describe("affiliateTheoKy", () => {
  it("đếm đơn có hoa hồng + Σ hoa hồng + doanh thu của CHÍNH nhóm đó", async () => {
    await taoDon({ orderedAt: TRONG_KY, itemsTotal: 500_000, raw: apf(30_000) });
    await taoDon({ orderedAt: TRONG_KY, itemsTotal: 300_000, raw: apf(45_675) });
    await taoDon({ orderedAt: TRONG_KY, itemsTotal: 200_000, raw: apf(0) });
    await taoDon({ orderedAt: TRONG_KY, itemsTotal: 100_000 }); // không có khối advanced_platform_fee
    await taoDon({ orderedAt: NGOAI_KY, itemsTotal: 999_000, raw: apf(99_000) }); // ngoài kỳ

    const r = await affiliateTheoKy(RANGE);
    expect(r.tongSoDonHopLe).toBe(4);
    expect(r.soDonCoHoaHong).toBe(2);
    expect(r.tongHoaHong).toBe(75_675);
    expect(r.doanhThuDonCoHoaHong).toBe(800_000);
  });

  it("đơn hoàn/hủy KHÔNG tính (cùng tập đơn hợp lệ với pnl.ts)", async () => {
    await taoDon({ orderedAt: TRONG_KY, itemsTotal: 500_000, status: "RETURNED", raw: apf(30_000) });
    await taoDon({ orderedAt: TRONG_KY, itemsTotal: 400_000, status: "CANCELLED", raw: apf(20_000) });
    const r = await affiliateTheoKy(RANGE);
    expect(r).toEqual({ soDonCoHoaHong: 0, tongSoDonHopLe: 0, doanhThuDonCoHoaHong: 0, tongHoaHong: 0 });
  });

  it("payload dị (null / chuỗi / khối không phải object) ⇒ coi là 0, KHÔNG văng lỗi", async () => {
    await taoDon({ orderedAt: TRONG_KY, itemsTotal: 100_000, raw: { advanced_platform_fee: null } });
    await taoDon({ orderedAt: TRONG_KY, itemsTotal: 100_000, raw: { advanced_platform_fee: "rỗng" } });
    await taoDon({ orderedAt: TRONG_KY, itemsTotal: 100_000, raw: apf("30000") });
    await taoDon({ orderedAt: TRONG_KY, itemsTotal: 100_000, raw: apf(12_345) });

    const r = await affiliateTheoKy(RANGE);
    expect(r.tongSoDonHopLe).toBe(4);
    expect(r.soDonCoHoaHong).toBe(1); // chỉ dòng số THẬT — chuỗi không được nhận (Pancake trả number)
    expect(r.tongHoaHong).toBe(12_345);
  });

  it("lọc theo kênh", async () => {
    await taoDon({ channelId: "tiktok", orderedAt: TRONG_KY, itemsTotal: 100_000, raw: apf(10_000) });
    await taoDon({ channelId: "shopee", orderedAt: TRONG_KY, itemsTotal: 100_000, raw: apf(20_000) });
    expect((await affiliateTheoKy(RANGE, { channelId: "tiktok" })).tongHoaHong).toBe(10_000);
    expect((await affiliateTheoKy(RANGE, { channelId: "shopee" })).tongHoaHong).toBe(20_000);
  });

  it("đơn ngoài kỳ KHÔNG lọt vào (cùng biên kỳ với calcPnl)", async () => {
    await taoDon({ orderedAt: NGOAI_KY, itemsTotal: 999_000, raw: apf(99_000) });
    // Biên PHẢI là hết ngày `to`, không phải 00:00 — đơn 23:30 ngày cuối kỳ phải được tính.
    await taoDon({
      orderedAt: new Date("2026-05-31T23:30:00+07:00"),
      itemsTotal: 250_000,
      raw: apf(12_000),
    });

    const r = await affiliateTheoKy(RANGE);
    expect(r.tongSoDonHopLe).toBe(1);
    expect(r.soDonCoHoaHong).toBe(1);
    expect(r.tongHoaHong).toBe(12_000);
    expect(r.doanhThuDonCoHoaHong).toBe(250_000);
  });
});
