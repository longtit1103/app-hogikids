import { format } from "date-fns";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { prisma } from "@/lib/prisma";
import {
  KHOI_NGUON,
  nguonDoanhSoTiktok,
  type KhoiNguon,
} from "@/lib/reports/marketing/nguon-doanh-so-tiktok";

import { seedReference, truncateBusinessTables } from "../helpers/test-db";
import { landFixture } from "./helpers/land-fixture";

/**
 * NGUỒN DOANH SỐ (SÀN BÁO) — 8 khối của `analytics_products` + 1 dòng GMV Max (TikTok Ads).
 *
 * Ba chỗ dễ sai nhất mà suite này khoá:
 *  1. Tên trường TIỀN/ĐƠN KHÁC NHAU theo khối: khối `total` dùng gmv/orders (KHÔNG phải
 *     attributed_*), affiliate_video dùng attributed_video_gmv, affiliate_live dùng
 *     live_attributed_gmv, shop_tab dùng bộ tên riêng và KHÔNG có khái niệm "đơn".
 *  2. VẮNG KHỐI = 0, không phải null/lỗi (A14 mục 4 — cấm cảnh báo thiếu). Fixture có SP chỉ 3/8 khối.
 *  3. Dòng GMV Max KHÔNG query riêng — lấy từ `quangCaoTheoChienDich` (sổ chi phí + Bronze ads).
 */

const KY = (tu: string, den: string) => ({
  from: new Date(`${tu}T00:00:00+07:00`),
  to: new Date(`${den}T00:00:00+07:00`),
});

const dong = (r: Awaited<ReturnType<typeof nguonDoanhSoTiktok>>, khoi: KhoiNguon) =>
  r.dong.find((d) => d.khoi === khoi)!;

beforeAll(async () => {
  await seedReference();
}, 60_000);

beforeEach(async () => {
  await truncateBusinessTables();
  await prisma.rawTiktokShopAnalyticsProduct.deleteMany();
  await prisma.rawTiktokBusinessReport.deleteMany();
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("nguonDoanhSoTiktok", () => {
  it("8 khối, mỗi khối đọc ĐÚNG tên trường của nó (số tuyệt đối từ fixture 19/08)", async () => {
    await landFixture("tiktok/analytics_products", "shop-products.json", "2026-08-19");

    const r = await nguonDoanhSoTiktok(KY("2026-08-19", "2026-08-19"));

    expect(r.dong).toHaveLength(8);
    expect(dong(r, "total")).toMatchObject({
      gmvSan: 330_000,
      donSan: 1,
      hienThi: 5_217, // 5156 + 41 + 20
      click: 375, // 374 + 1 + 0
      gopChong: true,
    });
    expect(dong(r, "seller_video")).toMatchObject({
      gmvSan: 330_000,
      donSan: 1,
      hienThi: 2_361,
      click: 186,
    });
    // shop_tab: bộ tên riêng, và KHÔNG có "đơn" ⇒ null chứ không phải 0.
    expect(dong(r, "shop_tab")).toMatchObject({
      gmvSan: 0,
      donSan: null,
      hienThi: 2_013, // 1988 + 18 + 7
      click: 106, // 105 + 1 + 0
    });
    expect(dong(r, "affiliate_video")).toMatchObject({ gmvSan: 0, donSan: null, hienThi: 7, click: 0 });
    expect(dong(r, "affiliate_live")).toMatchObject({ gmvSan: 0, donSan: null, hienThi: 0, click: 0 });
    // CTR tính LẠI từ click ÷ hiển thị (không lấy chuỗi `ctr` của sàn).
    expect(dong(r, "total").ctr).toBeCloseTo(375 / 5_217, 6);
    expect(dong(r, "affiliate_live").ctr).toBeNull(); // mẫu 0 ⇒ null, không phải 0
    expect(r.soNgayThieu).toBe(0);
  });

  it("cộng đúng qua NHIỀU ngày (khoá `_ngay:id` tách được hai ngày)", async () => {
    await landFixture("tiktok/analytics_products", "shop-products.json", "2026-08-19");
    await landFixture("tiktok/analytics_products", "shop-products.json", "2026-08-20");

    const r = await nguonDoanhSoTiktok(KY("2026-08-19", "2026-08-20"));

    expect(dong(r, "total").gmvSan).toBe(660_000);
    expect(dong(r, "total").hienThi).toBe(10_434);
    expect(dong(r, "total").donSan).toBe(2);
  });

  it("ngày > mốc sẵn sàng ⇒ chỉ đếm riêng, các tổng VẪN có số", async () => {
    await landFixture("tiktok/analytics_products", "shop-products.json", "2026-08-19");
    await landFixture("tiktok/analytics_products", "shop-products.json", "2026-08-20");

    const r = await nguonDoanhSoTiktok(KY("2026-08-19", "2026-08-21"));

    expect(r.mocSanSang).toBe("2026-08-20");
    expect(r.soNgayChuaSanSang).toBe(1);
    expect(r.soNgayThieu).toBe(0);
    expect(dong(r, "total").gmvSan).toBe(660_000);
  });

  it("ngày ≤ mốc mà Bronze rỗng ⇒ mọi tổng null (hụt thật, không cộng thiếu)", async () => {
    await landFixture("tiktok/analytics_products", "shop-products.json", "2026-08-19");
    await landFixture("tiktok/analytics_products", "shop-products.json", "2026-08-21");

    const r = await nguonDoanhSoTiktok(KY("2026-08-19", "2026-08-21"));

    expect(r.soNgayThieu).toBe(1); // 20/08 — ≤ mốc 21/08 mà rỗng
    expect(dong(r, "total").gmvSan).toBeNull();
    expect(dong(r, "total").hienThi).toBeNull();
    expect(dong(r, "total").ctr).toBeNull();
  });

  it("dòng GMV Max lấy từ sổ chi phí + Bronze ads (nguồn KHÁC, không query lại)", async () => {
    const ngay = "2026-08-19";
    await prisma.expense.create({
      data: {
        date: new Date(`${ngay}T00:00:00+07:00`),
        categoryId: "ads",
        adsSource: "TIKTOK_ADS",
        description: "CD GMV Max",
        amount: 83_368,
        source: "ADS_API",
        refId: `TIKTOK_ADS:${ngay}:1873416520735281`,
      },
    });
    await prisma.rawTiktokBusinessReport.create({
      data: {
        shopId: "7129548444015902722",
        externalId: `1873416520735281:${ngay}`,
        payloadHash: "h1",
        payload: {
          dimensions: { campaign_id: "1873416520735281", stat_time_day: `${ngay} 00:00:00` },
          metrics: { campaign_name: "CD GMV Max", cost: "75790", orders: "3", gross_revenue: "900000" },
        },
      },
    });
    await landFixture("tiktok/analytics_products", "shop-products.json", ngay);

    const r = await nguonDoanhSoTiktok(KY(ngay, ngay));

    expect(r.gmvMax.chiGomVat).toBe(83_368); // tiền SỔ (đã gồm VAT), không phải `cost` chưa VAT
    expect(r.gmvMax.donSan).toBe(3);
    expect(r.gmvMax.gmvSan).toBe(900_000);
    // Dòng GMV Max KHÔNG được gộp vào 8 khối analytics (hai nguồn khác nhau).
    expect(r.dong).toHaveLength(8);
  });

  it("chỉ cộng dòng của shop TikTok Shop đang cấu hình", async () => {
    await landFixture("tiktok/analytics_products", "shop-products.json", "2026-08-19");
    // INSERT thẳng: landRaw chặn shopId ngoài whitelist, mà ca cần mô phỏng là DB có shop KHÁC.
    await prisma.rawTiktokShopAnalyticsProduct.create({
      data: {
        shopId: "9999999999999999999",
        externalId: "2026-08-19:8888888888888888888",
        payloadHash: "h-shop-la",
        payload: {
          _ngay: "2026-08-19",
          id: "8888888888888888888",
          total_performance: {
            gmv: { amount: "77000000.00", currency: "VND" },
            orders: 42,
            product_impressions: 60_000,
            product_clicks: 900,
          },
        },
      },
    });

    const r = await nguonDoanhSoTiktok(KY("2026-08-19", "2026-08-19"));

    expect(dong(r, "total").gmvSan).toBe(330_000); // KHÔNG phải 77.330.000
    expect(dong(r, "total").hienThi).toBe(5_217);
  });

  it("bảng ánh xạ khối là HẰNG: total dùng gmv/orders, affiliate_video/live dùng tên riêng và không có đơn", () => {
    expect(KHOI_NGUON.total.truongGmv).toBe("gmv");
    expect(KHOI_NGUON.total.truongDon).toBe("orders");
    expect(KHOI_NGUON.affiliate_video.truongGmv).toBe("attributed_video_gmv");
    expect(KHOI_NGUON.affiliate_video.truongDon).toBeNull();
    expect(KHOI_NGUON.affiliate_live.truongGmv).toBe("live_attributed_gmv");
    expect(KHOI_NGUON.shop_tab.truongHienThi).toBe("shop_tab_product_impressions");
    expect(KHOI_NGUON.seller_video.truongGmv).toBe("attributed_gmv");
    // Hai dòng GỘP CHỒNG với các dòng khác — UI phải tách khu, không vẽ chung cột.
    expect(Object.entries(KHOI_NGUON).filter(([, d]) => d.gopChong).map(([k]) => k)).toEqual([
      "total",
      "affiliate_total",
    ]);
  });

  it("kỳ không có ngày nào trong Bronze và chưa có mốc ⇒ hụt thật, không bịa 0", async () => {
    const r = await nguonDoanhSoTiktok(KY("2026-08-19", "2026-08-19"));

    expect(r.mocSanSang).toBeNull();
    expect(r.soNgayThieu).toBe(1);
    expect(dong(r, "total").gmvSan).toBeNull();
    expect(r.gmvMax.chiGomVat).toBe(0);
    expect(format(new Date("2026-08-19T00:00:00+07:00"), "yyyy-MM-dd")).toBe("2026-08-19");
  });
});
