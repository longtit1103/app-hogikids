import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { prisma } from "@/lib/prisma";
import { lanChayOkGanNhatAnalyticsTheoStream } from "@/lib/reports/marketing/suc-khoe-dong-bo-analytics";

/**
 * Bằng chứng ĐỘ TƯƠI (ruling P2-R35, tách theo stream ở P2-R40) — chạm DB THẬT (`TEST_DATABASE_URL`,
 * ép sẵn ở `tests/setup.ts`) vì hàm đọc `stats->>'stream'` bằng `$queryRaw`, một toán tử Postgres
 * JSON không mock được ý nghĩa bằng test đơn vị thuần. TRƯỚC bản vá này module không có test nào —
 * bỏ nhầm `status: "OK"` khỏi `where`, hoặc gộp chung MỘT mốc cho cả 4 stream (bug gốc ruling
 * P2-R40 vá) đều để lọt qua `tsc --noEmit` + toàn bộ suite khác vẫn xanh trên hệ khoẻ.
 */

beforeEach(async () => {
  await prisma.syncLog.deleteMany({ where: { kind: "TIKTOK_SHOP_ANALYTICS" } });
});

afterAll(async () => {
  await prisma.syncLog.deleteMany({ where: { kind: "TIKTOK_SHOP_ANALYTICS" } });
  await prisma.$disconnect();
});

describe("lanChayOkGanNhatAnalyticsTheoStream", () => {
  it("chưa có dòng SyncLog nào ⇒ cả 4 stream null", async () => {
    expect(await lanChayOkGanNhatAnalyticsTheoStream()).toEqual({
      "tiktok/analytics_shop": null,
      "tiktok/analytics_products": null,
      "tiktok/analytics_videos": null,
      "tiktok/analytics_lives": null,
    });
  });

  /**
   * Bug gốc P2-R40: cổng cũ lấy MỘT dòng OK gần nhất chung cho cả kind, nên `shop` OK "sơn xanh"
   * luôn trạng thái của `products` — đúng lúc `products` đang lỗi thật. Test này ép: `shop` có lượt
   * OK, `products` CHƯA TỪNG OK (chỉ có ERROR) ⇒ hai stream phải ra hai kết quả ĐỘC LẬP.
   */
  it("TÁCH ĐÚNG theo stream — lượt OK của shop KHÔNG lấp cho products đang lỗi", async () => {
    const okShop = new Date("2026-08-25T02:30:00+07:00");
    await prisma.syncLog.create({
      data: {
        kind: "TIKTOK_SHOP_ANALYTICS",
        status: "OK",
        startedAt: okShop,
        finishedAt: okShop,
        stats: { stream: "tiktok/analytics_shop" },
      },
    });
    await prisma.syncLog.create({
      data: {
        kind: "TIKTOK_SHOP_ANALYTICS",
        status: "ERROR",
        startedAt: new Date("2026-08-25T02:31:00+07:00"),
        finishedAt: new Date("2026-08-25T02:31:05+07:00"),
        stats: { stream: "tiktok/analytics_products" },
      },
    });

    const ket = await lanChayOkGanNhatAnalyticsTheoStream();
    expect(ket["tiktok/analytics_shop"]).toEqual(okShop);
    expect(ket["tiktok/analytics_products"]).toBeNull();
  });

  it("CHỈ lấy OK — RUNNING/ERROR mới hơn KHÔNG được che mất lượt OK cuối cùng", async () => {
    const okCu = new Date("2026-08-24T02:30:00+07:00");
    await prisma.syncLog.create({
      data: {
        kind: "TIKTOK_SHOP_ANALYTICS",
        status: "OK",
        startedAt: okCu,
        finishedAt: okCu,
        stats: { stream: "tiktok/analytics_videos" },
      },
    });
    // Lượt đêm SAU đó thất bại (ERROR) rồi đang chạy dở (RUNNING) — cả hai đều MỚI HƠN `okCu` nhưng
    // không phải OK, nên bằng chứng "gần nhất" phải vẫn là `okCu`.
    await prisma.syncLog.create({
      data: {
        kind: "TIKTOK_SHOP_ANALYTICS",
        status: "ERROR",
        startedAt: new Date("2026-08-25T02:30:00+07:00"),
        finishedAt: new Date("2026-08-25T02:30:10+07:00"),
        stats: { stream: "tiktok/analytics_videos" },
      },
    });
    await prisma.syncLog.create({
      data: {
        kind: "TIKTOK_SHOP_ANALYTICS",
        status: "RUNNING",
        startedAt: new Date("2026-08-26T02:30:00+07:00"),
        stats: { stream: "tiktok/analytics_videos" },
      },
    });

    const ket = await lanChayOkGanNhatAnalyticsTheoStream();
    expect(ket["tiktok/analytics_videos"]).toEqual(okCu);
  });

  it("lọc ĐÚNG kind — dòng OK của kind khác (vd TIKTOK_SHOP) không lọt vào", async () => {
    await prisma.syncLog.create({
      data: {
        kind: "TIKTOK_SHOP",
        status: "OK",
        startedAt: new Date(),
        finishedAt: new Date(),
        stats: { stream: "tiktok/analytics_lives" },
      },
    });

    const ket = await lanChayOkGanNhatAnalyticsTheoStream();
    expect(ket["tiktok/analytics_lives"]).toBeNull();
  });

  it("nhiều lượt OK của cùng một stream ⇒ lấy đúng lượt MỚI NHẤT", async () => {
    const cu = new Date("2026-08-20T02:30:00+07:00");
    const moi = new Date("2026-08-25T02:30:00+07:00");
    await prisma.syncLog.create({
      data: {
        kind: "TIKTOK_SHOP_ANALYTICS",
        status: "OK",
        startedAt: cu,
        finishedAt: cu,
        stats: { stream: "tiktok/analytics_shop" },
      },
    });
    await prisma.syncLog.create({
      data: {
        kind: "TIKTOK_SHOP_ANALYTICS",
        status: "OK",
        startedAt: moi,
        finishedAt: moi,
        stats: { stream: "tiktok/analytics_shop" },
      },
    });

    const ket = await lanChayOkGanNhatAnalyticsTheoStream();
    expect(ket["tiktok/analytics_shop"]).toEqual(moi);
  });
});
