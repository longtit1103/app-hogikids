import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { prisma } from "@/lib/prisma";
import { mocDuLieuSanSang } from "@/lib/reports/marketing/moc-du-lieu-san-sang";

import { docFixtureJson, landFixture, landJson } from "./helpers/land-fixture";

/**
 * MỐC DỮ LIỆU SẴN SÀNG — bốn stream, bốn mốc RIÊNG (A2 mục 6 + A14 mục 3: mốc trôi khác nhau
 * theo endpoint VÀ theo giờ). Lưới này khoá hai thứ:
 *  1. Chưa land gì ⇒ `null`, KHÔNG phải một ngày mặc định nào đó (mốc bịa ⇒ mọi ngày trong kỳ
 *     bị xếp nhầm giữa "sàn chưa chốt" và "hụt thật").
 *  2. Mốc của `lives` suy từ `start_time` (epoch giây) theo GIỜ VN — phiên rơi vào 00:00–06:59
 *     giờ VN thuộc ngày HÔM TRƯỚC theo UTC, và đó là ca duy nhất phân biệt được hai phép tính.
 */

beforeEach(async () => {
  await prisma.rawTiktokShopAnalyticsShop.deleteMany();
  await prisma.rawTiktokShopAnalyticsProduct.deleteMany();
  await prisma.rawTiktokShopAnalyticsVideo.deleteMany();
  await prisma.rawTiktokShopAnalyticsLive.deleteMany();
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("mocDuLieuSanSang", () => {
  it("chưa land gì ⇒ cả 4 mốc là null", async () => {
    expect(await mocDuLieuSanSang()).toEqual({
      shop: null,
      products: null,
      videos: null,
      lives: null,
    });
  });

  it("mốc shop = ngày lớn nhất đã land; products/videos lấy 10 ký tự đầu của khoá `_ngay:id`", async () => {
    await landFixture("tiktok/analytics_shop", "shop-performance.json");
    await landFixture("tiktok/analytics_products", "shop-products.json", "2026-08-21");
    await landFixture("tiktok/analytics_products", "shop-products.json", "2026-08-22");
    await landFixture("tiktok/analytics_videos", "shop-videos.json", "2026-08-19");

    const m = await mocDuLieuSanSang();
    // Fixture shop có 3 interval: start_date 15/08, 19/08, 20/08.
    expect(m.shop).toBe("2026-08-20");
    expect(m.products).toBe("2026-08-22");
    expect(m.videos).toBe("2026-08-19");
    expect(m.lives).toBeNull();
  });

  it("mốc lives suy từ start_time (epoch giây) — phiên mới nhất 07/08 19:38 giờ VN", async () => {
    await landFixture("tiktok/analytics_lives", "shop-lives.json");

    expect((await mocDuLieuSanSang()).lives).toBe("2026-08-07");
  });

  it("phiên 01:00 giờ VN thuộc NGÀY VN, không phải ngày UTC (18:00 hôm trước)", async () => {
    // 1786212000 = 2026-08-09 01:00 giờ VN = 2026-08-08 18:00 UTC. Đọc theo UTC ra 08/08 —
    // mốc lùi một ngày ⇒ cả một ngày dữ liệu bị xếp nhầm sang "sàn chưa chốt".
    const env = docFixtureJson<{ data: { live_stream_sessions: Record<string, unknown>[] } }>(
      "shop-lives.json",
    );
    env.data.live_stream_sessions = [
      { ...env.data.live_stream_sessions[0], id: "9999", start_time: "1786212000", end_time: "1786212060" },
    ];
    await landJson("tiktok/analytics_lives", env);

    expect((await mocDuLieuSanSang()).lives).toBe("2026-08-09");
  });

  it("start_time không phải chuỗi số ⇒ bỏ qua phiên đó, không làm hỏng cả mốc", async () => {
    const env = docFixtureJson<{ data: { live_stream_sessions: Record<string, unknown>[] } }>(
      "shop-lives.json",
    );
    env.data.live_stream_sessions = [
      { ...env.data.live_stream_sessions[0], id: "8888", start_time: "N/A", end_time: "N/A" },
      ...env.data.live_stream_sessions,
    ];
    await landJson("tiktok/analytics_lives", env);

    expect((await mocDuLieuSanSang()).lives).toBe("2026-08-07");
  });
});
