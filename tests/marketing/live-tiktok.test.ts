import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { prisma } from "@/lib/prisma";
import { liveTiktok } from "@/lib/reports/marketing/live-tiktok";

import { docFixtureJson, landFixture, landJson } from "./helpers/land-fixture";

/**
 * BẢNG PHIÊN LIVE (tab Nội dung) — thực thể có id riêng, lọc theo `start_time` (epoch giây DẠNG
 * CHUỖI), KHÔNG có chuỗi ngày nên KHÔNG có `soNgayThieu` (A4 + brief Step 5).
 *
 * Hai lời khai đáng tiền:
 *  1. Biên kỳ tính theo GIỜ VN. Phiên 00:00–06:59 giờ VN nằm ở ngày HÔM TRƯỚC theo UTC — đọc nhầm
 *     là phiên rơi khỏi kỳ mà không ai thấy.
 *  2. `thoiLuongGiay` = end − start (sàn KHÔNG trả `duration` cho phiên của creator), và cụm cột
 *     tương tác chỉ bật khi CÓ ít nhất một phiên có `interaction_performance`.
 */

const KY = (tu: string, den: string) => ({
  from: new Date(`${tu}T00:00:00+07:00`),
  to: new Date(`${den}T00:00:00+07:00`),
});

type EnvelopeLive = { data: { live_stream_sessions: Record<string, unknown>[] } };

beforeEach(async () => {
  await prisma.rawTiktokShopAnalyticsLive.deleteMany();
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("liveTiktok", () => {
  it("3 phiên trong tháng 8: thời lượng tính từ end − start, tỉ lệ khuôn '0.00%', tiền khuôn '0'", async () => {
    await landFixture("tiktok/analytics_lives", "shop-lives.json");

    const r = await liveTiktok(KY("2026-08-01", "2026-08-31"));

    expect(r.phien.map((p) => p.id)).toEqual([
      "7671268054237514504", // 07/08 19:38 — mới nhất trước
      "7670797759402822421", // 06/08 13:13
      "7668935874625751828", // 01/08 12:48
    ]);
    const ngan = r.phien.find((p) => p.id === "7670797759402822421")!;
    expect(ngan.thoiLuongGiay).toBe(3); // ca biên "bấm nhầm"
    expect(ngan.batDau).toBe("2026-08-06T13:13:33+07:00");
    const dai = r.phien.find((p) => p.id === "7668935874625751828")!;
    expect(dai.thoiLuongGiay).toBe(7_719);
    expect(dai.clickSangDon).toBe(0); // parse "0.00%"
    expect(dai.gmvSan).toBe(0); // parse {amount:"0"} — khuôn KHÔNG thập phân
    expect(dai.donSku).toBe(0);
    expect(dai.khach).toBe(0);
    expect(dai.spThemVaoLive).toBe(1);
    expect(dai.taiKhoan).toBe("creator_10");
    expect(dai.coTuongTac).toBe(false);
    // Shop chưa tự live ⇒ 0/3 phiên có interaction_performance ⇒ UI ẨN cả cụm cột tương tác.
    expect(r.coCotTuongTac).toBe(false);
    expect(r.mocSanSang).toBe("2026-08-07");
  });

  it("kỳ 06/08 đúng 1 ngày ⇒ đúng 1 phiên", async () => {
    await landFixture("tiktok/analytics_lives", "shop-lives.json");

    const r = await liveTiktok(KY("2026-08-06", "2026-08-06"));

    expect(r.phien.map((p) => p.id)).toEqual(["7670797759402822421"]);
  });

  it("biên kỳ theo GIỜ VN: phiên 08:00 sáng phải nằm trong kỳ của NGÀY VN đó", async () => {
    // ⚠️ Chọn 08:00 chứ KHÔNG phải 01:00, và đây là điểm dễ viết ra một lưới MÙ:
    // biên kỳ (`startOfDay`/`endOfDay` của date-fns) chạy theo TZ TIẾN TRÌNH, nên nếu tiến trình
    // chạy UTC thì CẢ biên LẪN phiên cùng dịch −7 giờ. Phiên 01:00 giờ VN (epoch 1786212000) vì
    // thế vẫn lọt kỳ 09/08 dưới CẢ HAI múi giờ — đo tay: VN [true], UTC [true] ⇒ không phân biệt
    // được gì. Phiên 08:00 giờ VN (1786237200 = 01:00 UTC ngày 09/08) thì rơi RA NGOÀI biên kỳ
    // 09/08 tính theo UTC (kết thúc lúc 23:59:59 UTC ngày 08/08) ⇒ ca này ĐỎ nếu app mất neo +07.
    const env = docFixtureJson<EnvelopeLive>("shop-lives.json");
    env.data.live_stream_sessions = [
      { ...env.data.live_stream_sessions[0], id: "9999", start_time: "1786237200", end_time: "1786237500" },
    ];
    await landJson("tiktok/analytics_lives", env);

    const trong = await liveTiktok(KY("2026-08-09", "2026-08-09"));
    expect(trong.phien.map((p) => p.id)).toEqual(["9999"]);
    expect(trong.phien[0].batDau).toBe("2026-08-09T08:00:00+07:00");
    expect((await liveTiktok(KY("2026-08-08", "2026-08-08"))).phien).toEqual([]);
  });

  it("chỉ tính phiên của shop TikTok Shop đang cấu hình (hai shop cùng DB không cộng đôi)", async () => {
    await landFixture("tiktok/analytics_lives", "shop-lives.json");
    // INSERT thẳng: `landRaw` từ chối shopId ngoài whitelist, mà ca cần mô phỏng là DB của một bản
    // clone có shop TikTok Shop KHÁC — dòng đó tồn tại hợp lệ, chỉ là không phải của shop này.
    await prisma.rawTiktokShopAnalyticsLive.create({
      data: {
        shopId: "9999999999999999999",
        externalId: "7777777777777777777",
        payloadHash: "h-shop-la",
        payload: {
          id: "7777777777777777777",
          start_time: "1785563299",
          end_time: "1785571018",
          title: "phiên shop lạ",
          username: "creator_la",
          sales_performance: { gmv: { amount: "5000000", currency: "VND" }, sku_orders: 9 },
        },
      },
    });

    const r = await liveTiktok(KY("2026-08-01", "2026-08-31"));

    expect(r.phien).toHaveLength(3);
    expect(r.phien.map((p) => p.id)).not.toContain("7777777777777777777");
  });

  it("phiên CÓ interaction_performance ⇒ bật cụm cột tương tác", async () => {
    const env = docFixtureJson<EnvelopeLive>("shop-lives.json");
    env.data.live_stream_sessions[0].interaction_performance = { viewers: 12, acu: 3 };
    await landJson("tiktok/analytics_lives", env);

    const r = await liveTiktok(KY("2026-08-01", "2026-08-31"));

    expect(r.coCotTuongTac).toBe(true);
    expect(r.phien.filter((p) => p.coTuongTac).map((p) => p.id)).toEqual(["7668935874625751828"]);
  });

  it("end_time dị ⇒ thời lượng null (không bịa 0); start_time dị ⇒ phiên không xếp được vào kỳ nào", async () => {
    const env = docFixtureJson<EnvelopeLive>("shop-lives.json");
    env.data.live_stream_sessions[0].end_time = "N/A";
    env.data.live_stream_sessions[1].start_time = "N/A";
    await landJson("tiktok/analytics_lives", env);

    const r = await liveTiktok(KY("2026-08-01", "2026-08-31"));

    expect(r.phien.find((p) => p.id === "7668935874625751828")!.thoiLuongGiay).toBeNull();
    expect(r.phien.map((p) => p.id)).not.toContain("7670797759402822421");
  });
});
