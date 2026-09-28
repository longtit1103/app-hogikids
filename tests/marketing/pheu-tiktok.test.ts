import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { prisma } from "@/lib/prisma";
import { pheuTiktok } from "@/lib/reports/marketing/pheu-tiktok";

import { docFixtureJson, landFixture, landJson } from "./helpers/land-fixture";

/**
 * PHỄU TIKTOK (tab Tổng quan) — mọi con số dưới đây là số TUYỆT ĐỐI đọc từ fixture thật
 * `shop-performance.json` (3 interval: 15/08, 19/08, 20/08 — mốc sẵn sàng suy ra = 20/08).
 *
 * Bốn lời khai suite này khoá:
 *  1. HAI bộ đếm ngày phân biệt được: 16–18/08 (≤ mốc, Bronze rỗng) là hụt THẬT ⇒ tổng null;
 *     21–22/08 (> mốc) là sàn chưa chốt ⇒ tổng VẪN có số.
 *  2. Tỉ lệ chuyển đổi TÍNH LẠI từ đơn ÷ lượt truy cập, KHÔNG lấy `avg_conversation_rate` của sàn
 *     (cộng/trung bình tỉ số qua nhiều ngày là số vô nghĩa).
 *  3. Tiền dị ⇒ null, KHÔNG ra 0 — và chỉ null ĐÚNG trường đó.
 *  4. Bản land sau thắng bản trước trên cùng khoá ngày.
 */

const KY = (tu: string, den: string) => ({
  from: new Date(`${tu}T00:00:00+07:00`),
  to: new Date(`${den}T00:00:00+07:00`),
});

type EnvelopeShop = {
  data: { performance: { intervals: Record<string, unknown>[] } };
};

beforeEach(async () => {
  await prisma.rawTiktokShopAnalyticsShop.deleteMany();
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("pheuTiktok", () => {
  it("ngày ≤ mốc mà Bronze rỗng = hụt THẬT ⇒ mọi tổng null + soNgayThieu đếm đúng", async () => {
    await landFixture("tiktok/analytics_shop", "shop-performance.json");

    const r = await pheuTiktok(KY("2026-08-15", "2026-08-20"));

    expect(r.mocSanSang).toBe("2026-08-20");
    expect(r.soNgayThieu).toBe(3); // 16, 17, 18/08
    expect(r.soNgayChuaSanSang).toBe(0);
    expect(r.luotTruyCap).toBeNull();
    expect(r.luotXemTrang).toBeNull();
    expect(r.donSan).toBeNull();
    expect(r.gmvSan).toBeNull();
    expect(r.tiLeChuyenDoi).toBeNull();
    // Chuỗi ngày vẫn trả ĐỦ ngày có số (biểu đồ không mất điểm chỉ vì tổng không tin được).
    expect(r.chuoiNgay.map((d) => d.ngay)).toEqual(["2026-08-15", "2026-08-19", "2026-08-20"]);
  });

  it("kỳ 19–20/08 đủ ngày ⇒ số tuyệt đối từ fixture", async () => {
    await landFixture("tiktok/analytics_shop", "shop-performance.json");

    const r = await pheuTiktok(KY("2026-08-19", "2026-08-20"));

    expect(r.soNgayThieu).toBe(0);
    expect(r.luotTruyCap).toBe(349); // 178 + 171
    expect(r.luotXemTrang).toBe(495); // 267 + 228
    expect(r.donSan).toBe(2); // 2 + 0
    expect(r.gmvSan).toBe(381_920); // 381.920 + 0
    expect(r.gmvTheoNguon.video).toBe(220_000);
    expect(r.gmvTheoNguon.productCard).toBe(161_920);
    expect(r.gmvTheoNguon.live).toBe(0);
    // `gross_revenue` chỉ có ở ngày CÓ doanh số — 20/08 vắng key là ĐÚNG, không phải lỗi.
    expect(r.doanhSoSan).toBe(440_000);
    expect(r.soNgayCoDoanhSo).toBe(1);
    expect(r.tiTrongGmvMax).toBe(0); // 19/08 có GMV_MAX = 0.0000
    expect(r.tiLeChuyenDoi).toBeCloseTo(2 / 349, 6);
    expect(r.chuoiNgay).toEqual([
      { ngay: "2026-08-19", luotTruyCap: 178, luotXemTrang: 267, donSan: 2, gmvSan: 381_920 },
      { ngay: "2026-08-20", luotTruyCap: 171, luotXemTrang: 228, donSan: 0, gmvSan: 0 },
    ]);
  });

  it("kỳ 1 ngày: tỉ trọng GMV Max = 1 và tỉ lệ chuyển đổi tính LẠI (1 ÷ 199), không lấy avg_conversation_rate", async () => {
    await landFixture("tiktok/analytics_shop", "shop-performance.json");

    const r = await pheuTiktok(KY("2026-08-15", "2026-08-15"));

    expect(r.tiTrongGmvMax).toBe(1);
    expect(r.luotTruyCap).toBe(199);
    expect(r.donSan).toBe(1);
    // Sàn báo "0.0050"; app tính 1/199 = 0,005025 — gần nhau nhưng KHÔNG bằng, và app dùng số của app.
    expect(r.tiLeChuyenDoi).toBeCloseTo(0.005025, 6);
    expect(r.tiLeChuyenDoi).not.toBe(0.005);
  });

  it("ngày > mốc sẵn sàng KHÔNG null hoá tổng, chỉ đếm riêng", async () => {
    await landFixture("tiktok/analytics_shop", "shop-performance.json");

    const r = await pheuTiktok(KY("2026-08-19", "2026-08-22"));

    expect(r.soNgayChuaSanSang).toBe(2); // 21, 22/08 — sàn chưa chốt
    expect(r.soNgayThieu).toBe(0);
    expect(r.luotTruyCap).toBe(349);
    expect(r.gmvSan).toBe(381_920);
  });

  it("bản land SAU thắng trên cùng khoá ngày", async () => {
    await landFixture("tiktok/analytics_shop", "shop-performance.json");
    const env = docFixtureJson<EnvelopeShop>("shop-performance.json");
    const ngay19 = env.data.performance.intervals.find((i) => i.start_date === "2026-08-19")!;
    ngay19.traffic = { ...(ngay19.traffic as Record<string, unknown>), avg_visitors: 999 };
    await landJson("tiktok/analytics_shop", env);

    const r = await pheuTiktok(KY("2026-08-19", "2026-08-20"));

    expect(r.luotTruyCap).toBe(1_170); // 999 + 171
  });

  it("chỉ cộng dòng của shop TikTok Shop đang cấu hình — hai shop cùng DB không cộng đôi", async () => {
    await landFixture("tiktok/analytics_shop", "shop-performance.json");
    // INSERT thẳng vì `landRaw` chặn shopId ngoài whitelist; ca cần mô phỏng là DB của bản clone
    // có shop TikTok Shop KHÁC. Ngày 25/08 cố ý MỚI HƠN mọi ngày của shop mình: nếu mốc sẵn sàng
    // cũng quên lọc thì nó nhảy lên 25/08 và ba ngày 21–23/08 bị xếp nhầm sang "hụt thật".
    await prisma.rawTiktokShopAnalyticsShop.createMany({
      data: [
        // TRONG kỳ ⇒ nếu quên lọc thì mọi tổng cộng đôi.
        {
          shopId: "9999999999999999999",
          externalId: "2026-08-19",
          payloadHash: "h-shop-la-19",
          payload: {
            start_date: "2026-08-19",
            end_date: "2026-08-20",
            traffic: { avg_visitors: 5_000, avg_page_views: 9_000 },
            sales: { orders_count: 77, gmv: { overall: { amount: "99000000.00", currency: "VND" } } },
          },
        },
        // NGOÀI kỳ nhưng mới hơn ⇒ nếu quên lọc thì mốc sẵn sàng trôi theo shop lạ.
        {
          shopId: "9999999999999999999",
          externalId: "2026-08-25",
          payloadHash: "h-shop-la-25",
          payload: {
            start_date: "2026-08-25",
            end_date: "2026-08-26",
            traffic: { avg_visitors: 1, avg_page_views: 1 },
            sales: { orders_count: 0 },
          },
        },
      ],
    });

    const r = await pheuTiktok(KY("2026-08-19", "2026-08-20"));

    expect(r.luotTruyCap).toBe(349); // KHÔNG phải 5.349
    expect(r.donSan).toBe(2);
    expect(r.mocSanSang).toBe("2026-08-20"); // KHÔNG phải 2026-08-25
  });

  it("tiền sàn dị ⇒ null (không phải 0), và chỉ null đúng trường đó", async () => {
    const env = docFixtureJson<EnvelopeShop>("shop-performance.json");
    const ngay19 = env.data.performance.intervals.find((i) => i.start_date === "2026-08-19")!;
    const sales = ngay19.sales as Record<string, unknown>;
    sales.gmv = {
      ...(sales.gmv as Record<string, unknown>),
      overall: { amount: "N/A", currency: "VND" },
    };
    await landJson("tiktok/analytics_shop", env);

    const r = await pheuTiktok(KY("2026-08-19", "2026-08-20"));

    expect(r.gmvSan).toBeNull();
    expect(r.chuoiNgay[0].gmvSan).toBeNull();
    // Các trường khác KHÔNG bị kéo theo.
    expect(r.luotTruyCap).toBe(349);
    expect(r.donSan).toBe(2);
  });
});
