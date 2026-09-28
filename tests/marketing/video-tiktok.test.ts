import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { prisma } from "@/lib/prisma";
import { videoTiktok } from "@/lib/reports/marketing/video-tiktok";

import { docFixtureJson, landFixture, landJson } from "./helpers/land-fixture";

/**
 * BẢNG VIDEO (tab Nội dung) — Σ theo ngày của cùng một video id.
 *
 * Ba lời khai:
 *  1. CTR của video KHÔNG phân rã được (sàn không trả impressions) ⇒ kỳ nhiều ngày phải là null;
 *     lấy trung bình cộng của tỉ số là bịa. GPM thì NGƯỢC LẠI: cả tử (gmv) lẫn mẫu (views) đều
 *     cộng được ⇒ tính lại là đúng.
 *  2. Record `id = "0"` (TikTok gom "video không xác định") VẪN hiện, không lọc bỏ.
 *  3. Metadata lấy bản của NGÀY MỚI NHẤT — tiêu đề đổi giữa kỳ là chuyện của sàn.
 */

const KY = (tu: string, den: string) => ({
  from: new Date(`${tu}T00:00:00+07:00`),
  to: new Date(`${den}T00:00:00+07:00`),
});
const VIDEO_SHOP = "7589461730787396885";

type EnvelopeVideo = { data: { videos: Record<string, unknown>[] } };

beforeEach(async () => {
  await prisma.rawTiktokShopAnalyticsVideo.deleteMany();
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("videoTiktok", () => {
  it("gom 2 ngày: views/gmv/đơn cộng dồn, GPM tính lại, CTR null vì kỳ nhiều ngày", async () => {
    await landFixture("tiktok/analytics_videos", "shop-videos.json", "2026-08-19");
    await landFixture("tiktok/analytics_videos", "shop-videos.json", "2026-08-20");

    const r = await videoTiktok(KY("2026-08-19", "2026-08-20"));

    expect(r.video).toHaveLength(3);
    const v = r.video.find((x) => x.id === VIDEO_SHOP)!;
    expect(v.luotXem).toBe(2_216); // 1108 × 2
    expect(v.gmvSan).toBe(660_000);
    expect(v.donSku).toBe(2);
    expect(v.gpmSan).toBe(297_834); // 660.000 / 2216 × 1000 = 297.833,9 ⇒ làm tròn
    expect(v.ctr).toBeNull();
    expect(v.soNgayCoSo).toBe(2);
    expect(v.loaiTaiKhoan).toBe("OFFICIAL_ACCOUNTS");
    expect(v.dangLuc).toBe("2025-12-30 08:47:54");
    expect(v.sanPham).toEqual([
      {
        id: "1733583824365520555",
        ten: "ten_san_pham_11",
      },
    ]);
    // Sắp xếp mặc định theo GMV giảm dần.
    expect(r.video.map((x) => x.id)).toEqual([VIDEO_SHOP, "7552020068545154322", "0"]);
    expect(r.soNgayThieu).toBe(0);
  });

  it("kỳ ĐÚNG 1 ngày ⇒ lấy CTR sàn báo", async () => {
    await landFixture("tiktok/analytics_videos", "shop-videos.json", "2026-08-19");

    const r = await videoTiktok(KY("2026-08-19", "2026-08-19"));

    expect(r.video.find((x) => x.id === VIDEO_SHOP)!.ctr).toBeCloseTo(0.1431, 6);
  });

  it("record id = 0 vẫn có mặt, thiếu metadata ⇒ null chứ không bịa tên", async () => {
    await landFixture("tiktok/analytics_videos", "shop-videos.json", "2026-08-19");

    const v = (await videoTiktok(KY("2026-08-19", "2026-08-19"))).video.find((x) => x.id === "0")!;

    expect(v.tieuDe).toBeNull();
    expect(v.taiKhoan).toBeNull();
    expect(v.dangLuc).toBeNull();
    expect(v.loaiTaiKhoan).toBe("AFFILIATE_ACCOUNTS");
    expect(v.gpmSan).toBeNull(); // 0 lượt xem ⇒ mẫu 0 ⇒ null, không phải 0
  });

  it("lọc theo loại tài khoản", async () => {
    await landFixture("tiktok/analytics_videos", "shop-videos.json", "2026-08-19");

    const r = await videoTiktok(KY("2026-08-19", "2026-08-19"), { loaiTaiKhoan: "OFFICIAL_ACCOUNTS" });

    expect(r.video.map((x) => x.id)).toEqual([VIDEO_SHOP]);
  });

  it("metadata lấy bản của NGÀY MỚI NHẤT trong kỳ", async () => {
    await landFixture("tiktok/analytics_videos", "shop-videos.json", "2026-08-19");
    const env = docFixtureJson<EnvelopeVideo>("shop-videos.json");
    const v0 = env.data.videos.find((v) => v.id === VIDEO_SHOP)!;
    v0.title = "tieu_de_MOI";
    await landJson("tiktok/analytics_videos", env, "2026-08-20");

    const r = await videoTiktok(KY("2026-08-19", "2026-08-20"));

    expect(r.video.find((x) => x.id === VIDEO_SHOP)!.tieuDe).toBe("tieu_de_MOI");
  });

  it("ngày ≤ mốc mà Bronze rỗng ⇒ số của video null; ngày > mốc chỉ đếm riêng", async () => {
    await landFixture("tiktok/analytics_videos", "shop-videos.json", "2026-08-19");
    await landFixture("tiktok/analytics_videos", "shop-videos.json", "2026-08-21");

    const hut = await videoTiktok(KY("2026-08-19", "2026-08-21"));
    expect(hut.soNgayThieu).toBe(1); // 20/08 ≤ mốc 21/08 mà rỗng
    expect(hut.video.find((x) => x.id === VIDEO_SHOP)!.gmvSan).toBeNull();
    expect(hut.video.find((x) => x.id === VIDEO_SHOP)!.luotXem).toBeNull();

    const chuaSanSang = await videoTiktok(KY("2026-08-21", "2026-08-23"));
    expect(chuaSanSang.mocSanSang).toBe("2026-08-21");
    expect(chuaSanSang.soNgayChuaSanSang).toBe(2);
    expect(chuaSanSang.soNgayThieu).toBe(0);
    expect(chuaSanSang.video.find((x) => x.id === VIDEO_SHOP)!.gmvSan).toBe(330_000);
  });

  it("chỉ tính video của shop TikTok Shop đang cấu hình", async () => {
    await landFixture("tiktok/analytics_videos", "shop-videos.json", "2026-08-19");
    // INSERT thẳng: landRaw chặn shopId ngoài whitelist (ca mô phỏng DB có shop TikTok Shop khác).
    await prisma.rawTiktokShopAnalyticsVideo.create({
      data: {
        shopId: "9999999999999999999",
        externalId: "2026-08-19:6666666666666666666",
        payloadHash: "h-shop-la",
        payload: {
          _ngay: "2026-08-19",
          id: "6666666666666666666",
          views: 50_000,
          sku_orders: 9,
          gmv: { amount: "12000000.00", currency: "VND" },
          creator: { author_type: "OFFICIAL_ACCOUNTS" },
        },
      },
    });

    const r = await videoTiktok(KY("2026-08-19", "2026-08-19"));

    expect(r.video).toHaveLength(3);
    expect(r.video.map((x) => x.id)).not.toContain("6666666666666666666");
  });

  it("tiền dị ⇒ null, không ra 0", async () => {
    const env = docFixtureJson<EnvelopeVideo>("shop-videos.json");
    const v0 = env.data.videos.find((v) => v.id === VIDEO_SHOP)!;
    v0.gmv = { amount: "330000.00", currency: "USD" }; // sai tiền tệ = không đọc chắc chắn được
    await landJson("tiktok/analytics_videos", env, "2026-08-19");

    const v = (await videoTiktok(KY("2026-08-19", "2026-08-19"))).video.find((x) => x.id === VIDEO_SHOP)!;

    expect(v.gmvSan).toBeNull();
    expect(v.gpmSan).toBeNull();
    expect(v.luotXem).toBe(1_108);
  });
});
