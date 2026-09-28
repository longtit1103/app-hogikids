import { format } from "date-fns";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { prisma } from "@/lib/prisma";
import { quangCaoTheoChienDich } from "@/lib/reports/marketing/quang-cao-chien-dich";

import { seedReference, truncateBusinessTables } from "./helpers/test-db";

/**
 * Bảng hiệu quả quảng cáo theo chiến dịch (`hogikids_test`).
 *
 * Hai thứ lưới này phải giữ:
 *  1. Tiền KHỚP sổ chi phí — bảng marketing không được đẻ ra con số thứ hai cho
 *     cùng một khoản chi (lớp lỗi "đuổi theo số ở hai nơi" repo đã dính nhiều lần).
 *  2. Thiếu chỉ số phải ra `null` chứ KHÔNG ra 0 — TikTok không trả impressions,
 *     hiện 0 là nói dối rằng đã đo được và bằng không.
 */

const RANGE = { from: new Date("2026-05-01T00:00:00+07:00"), to: new Date("2026-05-31T00:00:00+07:00") };
const TRONG_KY = new Date("2026-05-15T00:00:00+07:00");
const TRONG_KY_2 = new Date("2026-05-16T00:00:00+07:00");
const NGOAI_KY = new Date("2026-04-15T00:00:00+07:00");

beforeAll(async () => {
  await seedReference();
}, 60_000);

beforeEach(async () => {
  await truncateBusinessTables();
  await prisma.rawMetaAdsReport.deleteMany();
  await prisma.rawTiktokBusinessReport.deleteMany();
});

afterAll(async () => {
  await prisma.$disconnect();
});

async function taoChiAds(opts: {
  nguon: string;
  campaignId: string | null;
  ten: string;
  amount: number;
  date?: Date;
}): Promise<void> {
  const d = opts.date ?? TRONG_KY;
  const ngay = format(d, "yyyy-MM-dd");
  await prisma.expense.create({
    data: {
      date: d,
      categoryId: "ads",
      adsSource: opts.nguon,
      description: opts.ten,
      amount: opts.amount,
      source: "ADS_API",
      // campaignId null ⇒ refId NULL, đúng như `ads-import.ts` ghi cho dòng file /
      // nhập tay. Bản cũ dựng chuỗi 2 mảnh `"META:{ngày}"` — khuôn KHÔNG tồn tại ở
      // prod (đo 18/08: mọi refId đúng 3 mảnh) và còn đụng unique constraint refId.
      refId: opts.campaignId ? `${opts.nguon}:${ngay}:${opts.campaignId}` : null,
    },
  });
}

async function taoChiSoMeta(opts: {
  campaignId: string;
  externalId: string;
  impressions: number;
  clicks: number;
  date?: Date;
  fetchedAt?: Date;
}): Promise<void> {
  // format() theo giờ ĐỊA PHƯƠNG (container + dev đều +07). Bản cũ dùng
  // toISOString() nên 15/05 00:00+07 ra "2026-05-14" — fixture tự trộn UTC vào một
  // app neo +07, và chính chỗ đó làm bộ test mù trước lỗi biên ngày.
  const ngay = format(opts.date ?? TRONG_KY, "yyyy-MM-dd");
  await prisma.rawMetaAdsReport.create({
    data: {
      shopId: "meta",
      externalId: opts.externalId,
      payloadHash: `h-${opts.externalId}-${opts.impressions}`,
      fetchedAt: opts.fetchedAt ?? new Date(),
      payload: {
        campaign_id: opts.campaignId,
        campaign_name: `CD ${opts.campaignId}`,
        date_start: ngay,
        date_stop: ngay,
        impressions: String(opts.impressions),
        clicks: String(opts.clicks),
        spend: "0",
      },
    },
  });
}

/**
 * Land một dòng-ngày Bronze report TikTok Business, đúng shape n8n land:
 * `{dimensions:{campaign_id, stat_time_day}, metrics:{campaign_name, cost|spend[, orders, gross_revenue, roi]}}`.
 * `orders: undefined` = bản payload ĐỜI CŨ (trước 21/08, chưa xin metric orders) — key vắng hẳn.
 * `grossRevenue`/`roi: undefined` = bản ĐỜI CŨ hơn nữa (trước 25/08) — hai key này vắng hẳn.
 */
async function taoDonTiktok(opts: {
  campaignId: string;
  /** number = giá trị bình thường; string = giá trị DỊ ("1.5", "abc") để test cổng regex. */
  orders?: number | string;
  auction?: boolean;
  date?: Date;
  fetchedAt?: Date;
  /** number = giá trị bình thường; string = giá trị DỊ ("N/A") để test cổng regex của MẪU SỐ ROI. */
  cost?: number | string;
  /** Tiền sàn trả dạng CHUỖI, có thể mang phần thập phân ("219789.00") hoặc dị ("N/A"). */
  grossRevenue?: number | string;
  /** Chỉ để ĐỐI CHỨNG ca một-ngày — reader KHÔNG đọc key này (cộng tỉ số là số vô nghĩa). */
  roi?: number | string;
}): Promise<void> {
  const ngay = format(opts.date ?? TRONG_KY, "yyyy-MM-dd");
  const externalId = `${opts.auction ? "auction:" : ""}${opts.campaignId}:${ngay}`;
  const metrics: Record<string, string> = {
    campaign_name: `CD ${opts.campaignId}`,
    // Auction dùng metric `spend`, GMV Max dùng `cost` — hai bộ RỜI NHAU (luật `mapTiktokAdsReport`).
    [opts.auction ? "spend" : "cost"]: String(opts.cost ?? 0),
  };
  if (opts.orders !== undefined) metrics.orders = String(opts.orders);
  if (opts.grossRevenue !== undefined) metrics.gross_revenue = String(opts.grossRevenue);
  if (opts.roi !== undefined) metrics.roi = String(opts.roi);
  await prisma.rawTiktokBusinessReport.create({
    data: {
      shopId: "7090000000000000001",
      externalId,
      // payloadHash phải đổi theo MỌI metric: hai bản khác nội dung cùng khoá gốc mà trùng hash là
      // đụng unique — đúng chỗ ca "backfill land bản giàu hơn" cần hai dòng cùng externalId.
      payloadHash: `h-${externalId}-${opts.orders ?? "khong-key"}-${opts.cost ?? 0}-${opts.grossRevenue ?? "khong-gmv"}-${opts.roi ?? "khong-roi"}`,
      fetchedAt: opts.fetchedAt ?? new Date(),
      payload: {
        dimensions: { campaign_id: opts.campaignId, stat_time_day: `${ngay} 00:00:00` },
        metrics,
      },
    },
  });
}

describe("quangCaoTheoChienDich", () => {
  it("Meta: gom đúng chi tiêu + tính CTR/CPM/CPC từ tiền của sổ", async () => {
    await taoChiAds({ nguon: "META", campaignId: "C1", ten: "Váy hè", amount: 1_000_000 });
    await taoChiSoMeta({ campaignId: "C1", externalId: "m-1", impressions: 100_000, clicks: 2_000 });

    const r = await quangCaoTheoChienDich(RANGE);

    expect(r.chienDich).toHaveLength(1);
    const c = r.chienDich[0];
    expect(c.chiTieu).toBe(1_000_000);
    expect(c.hienThi).toBe(100_000);
    expect(c.click).toBe(2_000);
    expect(c.ctr).toBeCloseTo(2, 6); // 2000/100000 × 100
    expect(c.cpm).toBeCloseTo(10_000, 6); // 1.000.000/100.000 × 1000
    expect(c.cpc).toBeCloseTo(500, 6); // 1.000.000/2.000
    expect(c.donSan).toBeNull(); // Meta không có metric đơn — null chứ không 0
    expect(c.cpo).toBeNull();
    expect(r.tongChiTieu).toBe(1_000_000);
  });

  it("nguồn KHÔNG có chỉ số trả null chứ không trả 0", async () => {
    await taoChiAds({ nguon: "TIKTOK_ADS", campaignId: "T1", ten: "Bộ bà ba", amount: 500_000 });

    const r = await quangCaoTheoChienDich(RANGE);

    const c = r.chienDich[0];
    expect(c.hienThi).toBeNull();
    expect(c.click).toBeNull();
    expect(c.ctr).toBeNull();
    expect(c.cpm).toBeNull();
    expect(c.cpc).toBeNull();
    expect(c.donSan).toBeNull();
    expect(c.cpo).toBeNull();
    expect(r.nguonThieuChiSo).toEqual(["TIKTOK_ADS"]);
    expect(r.nguonCoChiSo).toEqual([]);
  });

  it("TikTok GMV Max: cộng đơn sàn báo theo kỳ + CPO tính trên tiền sổ GỒM VAT", async () => {
    // Mỗi ngày một dòng sổ — đúng khuôn prepareAdsExpenseRow ghi (refId mang ngày).
    await taoChiAds({ nguon: "TIKTOK_ADS", campaignId: "G1", ten: "Toàn shop", amount: 300_000, date: new Date("2026-05-15T00:00:00+07:00") });
    await taoChiAds({ nguon: "TIKTOK_ADS", campaignId: "G1", ten: "Toàn shop", amount: 200_000, date: new Date("2026-05-16T00:00:00+07:00") });
    await taoDonTiktok({ campaignId: "G1", orders: 3, date: new Date("2026-05-15T00:00:00+07:00") });
    await taoDonTiktok({ campaignId: "G1", orders: 2, date: new Date("2026-05-16T00:00:00+07:00") });

    const r = await quangCaoTheoChienDich(RANGE);

    const c = r.chienDich[0];
    expect(c.chiTieu).toBe(500_000);
    expect(c.donSan).toBe(5);
    expect(c.cpo).toBeCloseTo(100_000, 6); // 500.000 (gồm VAT, từ sổ) / 5 đơn
    // Đơn/CPO KHÔNG làm TikTok bị coi là "có chỉ số hiển thị/click".
    expect(r.nguonThieuChiSo).toEqual(["TIKTOK_ADS"]);
  });

  it("kỳ có ngày THIẾU key orders (payload đời cũ, chưa backfill) ⇒ Đơn null, KHÔNG cộng thiếu", async () => {
    await taoChiAds({ nguon: "TIKTOK_ADS", campaignId: "G2", ten: "Thiếu ngày", amount: 200_000, date: new Date("2026-05-15T00:00:00+07:00") });
    await taoChiAds({ nguon: "TIKTOK_ADS", campaignId: "G2", ten: "Thiếu ngày", amount: 200_000, date: new Date("2026-05-16T00:00:00+07:00") });
    await taoDonTiktok({ campaignId: "G2", orders: 4, date: new Date("2026-05-15T00:00:00+07:00") });
    // Ngày 16/05 land TRƯỚC 21/08 — metrics chỉ có campaign_name + cost, không có key orders.
    await taoDonTiktok({ campaignId: "G2", date: new Date("2026-05-16T00:00:00+07:00") });

    const r = await quangCaoTheoChienDich(RANGE);

    expect(r.chienDich[0].donSan).toBeNull(); // 4 là số THIẾU của kỳ, hiện ra là số sai không tín hiệu
    expect(r.chienDich[0].cpo).toBeNull();
  });

  it("ngày sổ CÓ tiền GMV Max mà Bronze KHÔNG có dòng nào ⇒ Đơn null (ca ads mồ côi)", async () => {
    // landRaw trong n8n là best-effort — land hỏng lẻ một ngày thì Expense vẫn ghi.
    // Review đối kháng 21/08: cổng "thiếu key orders" cũ MÙ với ca này (đếm trên dòng
    // CÓ MẶT). Cổng mới đếm phủ NGÀY theo sổ nên phải bắt được.
    await taoChiAds({ nguon: "TIKTOK_ADS", campaignId: "G7", ten: "Mồ côi", amount: 100_000, date: new Date("2026-05-15T00:00:00+07:00") });
    await taoChiAds({ nguon: "TIKTOK_ADS", campaignId: "G7", ten: "Mồ côi", amount: 100_000, date: new Date("2026-05-16T00:00:00+07:00") });
    await taoDonTiktok({ campaignId: "G7", orders: 2, date: new Date("2026-05-15T00:00:00+07:00") });
    // 16/05: KHÔNG có dòng Bronze nào.

    const r = await quangCaoTheoChienDich(RANGE);

    expect(r.chienDich[0].donSan).toBeNull();
    expect(r.chienDich[0].cpo).toBeNull();
  });

  it("orders CÓ key nhưng giá trị dị ('1.5'/'abc') ⇒ Đơn null, không ép 0 không văng query", async () => {
    await taoChiAds({ nguon: "TIKTOK_ADS", campaignId: "G8", ten: "Giá trị dị", amount: 100_000, date: new Date("2026-05-15T00:00:00+07:00") });
    await taoChiAds({ nguon: "TIKTOK_ADS", campaignId: "G8", ten: "Giá trị dị", amount: 100_000, date: new Date("2026-05-16T00:00:00+07:00") });
    await taoDonTiktok({ campaignId: "G8", orders: "1.5", date: new Date("2026-05-15T00:00:00+07:00") });
    await taoDonTiktok({ campaignId: "G8", orders: "abc", date: new Date("2026-05-16T00:00:00+07:00") });

    const r = await quangCaoTheoChienDich(RANGE);

    expect(r.chienDich[0].donSan).toBeNull();
    expect(r.chienDich[0].cpo).toBeNull();
  });

  it("campaign chạy CẢ auction lẫn GMV Max: CPO chia tiền GMV Max riêng, KHÔNG chia tổng", async () => {
    const ngay = format(TRONG_KY, "yyyy-MM-dd");
    // Sổ: 100.000đ auction (refId 4 mảnh) + 200.000đ GMV Max (refId 3 mảnh) cùng ngày.
    await prisma.expense.create({
      data: {
        date: TRONG_KY, categoryId: "ads", adsSource: "TIKTOK_ADS",
        description: "Hai loại", amount: 100_000, source: "ADS_API",
        refId: `TIKTOK_ADS:auction:${ngay}:G9`,
      },
    });
    await taoChiAds({ nguon: "TIKTOK_ADS", campaignId: "G9", ten: "Hai loại", amount: 200_000 });
    await taoDonTiktok({ campaignId: "G9", orders: 2 });
    await taoDonTiktok({ campaignId: "G9", auction: true }); // Bronze auction không bao giờ có orders

    const r = await quangCaoTheoChienDich(RANGE);

    const c = r.chienDich[0];
    expect(c.chiTieu).toBe(300_000); // cột Chi tiêu vẫn là tổng cả 2 loại — tiền không biến mất
    expect(c.donSan).toBe(2);
    // Review đối kháng 21/08: chia tổng 300.000/2 = 150.000 là CPO thổi +50% câm.
    expect(c.cpo).toBeCloseTo(100_000, 6); // 200.000 (GMV Max) / 2 đơn
  });

  it("bắn lại cùng ngày (backfill mang thêm key orders) ⇒ chỉ bản MỚI NHẤT thắng", async () => {
    await taoChiAds({ nguon: "TIKTOK_ADS", campaignId: "G3", ten: "Backfill", amount: 300_000 });
    // Bản đời cũ không có orders, land trước.
    await taoDonTiktok({ campaignId: "G3", fetchedAt: new Date("2026-05-20"), cost: 100 });
    // Backfill land bản mới CÙNG khoá (externalId y hệt) có orders.
    await taoDonTiktok({ campaignId: "G3", orders: 7, fetchedAt: new Date("2026-05-21"), cost: 100 });

    const r = await quangCaoTheoChienDich(RANGE);

    expect(r.chienDich[0].donSan).toBe(7);
  });

  it("dòng AUCTION cùng chiến dịch bị loại khỏi phép đếm đơn — không kéo Đơn về null oan", async () => {
    await taoChiAds({ nguon: "TIKTOK_ADS", campaignId: "G4", ten: "Chạy cả 2 loại", amount: 200_000 });
    await taoDonTiktok({ campaignId: "G4", orders: 2 });
    // Dòng auction không bao giờ có orders (bộ metric rời nhau) — nằm chung Bronze với tiền tố khoá.
    await taoDonTiktok({ campaignId: "G4", auction: true });

    const r = await quangCaoTheoChienDich(RANGE);

    expect(r.chienDich[0].donSan).toBe(2);
    expect(r.chienDich[0].cpo).toBeCloseTo(100_000, 6);
  });

  it("đơn sàn báo NGOÀI kỳ bị loại — biên ngày không được lệch", async () => {
    await taoChiAds({ nguon: "TIKTOK_ADS", campaignId: "G5", ten: "Biên kỳ", amount: 100_000 });
    await taoDonTiktok({ campaignId: "G5", orders: 1 });
    await taoDonTiktok({ campaignId: "G5", orders: 99, date: new Date("2026-04-30T00:00:00+07:00") });
    await taoDonTiktok({ campaignId: "G5", orders: 88, date: new Date("2026-06-01T00:00:00+07:00") });

    const r = await quangCaoTheoChienDich(RANGE);

    expect(r.chienDich[0].donSan).toBe(1);
  });

  it("đơn = 0 đo được ⇒ Đơn hiện 0 (khác null), CPO null vì không chia 0", async () => {
    await taoChiAds({ nguon: "TIKTOK_ADS", campaignId: "G6", ten: "Không ra đơn", amount: 100_000 });
    await taoDonTiktok({ campaignId: "G6", orders: 0 });

    const r = await quangCaoTheoChienDich(RANGE);

    expect(r.chienDich[0].donSan).toBe(0);
    expect(r.chienDich[0].cpo).toBeNull();
  });

  it("GMV Max: gmvSan = Σ gross_revenue, roiSan = gmvSan / Σ cost (CHƯA VAT)", async () => {
    // Sổ ghi tiền GỒM VAT (75.789 × 1,1 = 83.368) — roiSan KHÔNG được dùng số này làm mẫu.
    await taoChiAds({ nguon: "TIKTOK_ADS", campaignId: "T1", ten: "TOÀN SHOP", amount: 83_368 });
    await taoDonTiktok({ campaignId: "T1", orders: 1, cost: 75_789, grossRevenue: "219789.00", roi: "2.90" });

    const c = (await quangCaoTheoChienDich(RANGE)).chienDich[0];
    expect(c.gmvSan).toBe(219_789);
    expect(c.roiSan).toBeCloseTo(2.9, 2); // đối chứng với chính `metrics.roi` sàn trả cho ca 1 ngày
  });

  it("chiGmvMax trả ra ngoài = tiền SỔ gồm VAT của phần GMV Max; dòng Meta là null", async () => {
    // Bảng con item-level cần đúng con số này để tính dòng "Chưa phân bổ". Trả ra đây thay vì
    // để người gọi tự dò lại refId: chép cái regex ra nơi thứ hai là bảo đảm hai nơi sẽ trôi khác nhau.
    await taoChiAds({ nguon: "TIKTOK_ADS", campaignId: "T1", ten: "TOÀN SHOP", amount: 83_368 });
    await taoDonTiktok({ campaignId: "T1", orders: 1, cost: 75_789 });
    await taoChiAds({ nguon: "META", campaignId: "M1", ten: "CD Meta", amount: 90_000 });

    const r = await quangCaoTheoChienDich(RANGE);

    expect(r.chienDich.find((c) => c.campaignId === "T1")!.chiGmvMax).toBe(83_368);
    expect(r.chienDich.find((c) => c.campaignId === "M1")!.chiGmvMax).toBeNull();
  });

  it("gộp NHIỀU ngày: gmvSan cộng được, roiSan là THƯƠNG SỐ chứ không phải trung bình roi", async () => {
    await taoChiAds({ nguon: "TIKTOK_ADS", campaignId: "T2", ten: "CD2", amount: 110_000, date: TRONG_KY });
    await taoChiAds({ nguon: "TIKTOK_ADS", campaignId: "T2", ten: "CD2", amount: 220_000, date: TRONG_KY_2 });
    await taoDonTiktok({ campaignId: "T2", orders: 1, cost: 100_000, grossRevenue: "100000", roi: "1.00", date: TRONG_KY });
    await taoDonTiktok({ campaignId: "T2", orders: 3, cost: 200_000, grossRevenue: "800000", roi: "4.00", date: TRONG_KY_2 });

    const c = (await quangCaoTheoChienDich(RANGE)).chienDich[0];
    expect(c.gmvSan).toBe(900_000);
    expect(c.roiSan).toBeCloseTo(3.0, 6); // 900.000 / 300.000 — KHÔNG phải (1+4)/2 = 2,5
  });

  it("một ngày trong kỳ THIẾU key gross_revenue ⇒ gmvSan/roiSan null, nhưng donSan vẫn có số", async () => {
    await taoChiAds({ nguon: "TIKTOK_ADS", campaignId: "T3", ten: "CD3", amount: 110_000, date: TRONG_KY });
    await taoChiAds({ nguon: "TIKTOK_ADS", campaignId: "T3", ten: "CD3", amount: 110_000, date: TRONG_KY_2 });
    await taoDonTiktok({ campaignId: "T3", orders: 1, cost: 100_000, grossRevenue: "100000", roi: "1.00", date: TRONG_KY });
    await taoDonTiktok({ campaignId: "T3", orders: 2, cost: 100_000, date: TRONG_KY_2 }); // bản ĐỜI CŨ, chưa backfill
    const c = (await quangCaoTheoChienDich(RANGE)).chienDich[0];
    expect(c.donSan).toBe(3);
    expect(c.gmvSan).toBeNull();
    expect(c.roiSan).toBeNull();
  });

  it("gross_revenue dạng chuỗi DỊ (\"N/A\") ⇒ null, KHÔNG ra 0", async () => {
    await taoChiAds({ nguon: "TIKTOK_ADS", campaignId: "T4", ten: "CD4", amount: 110_000 });
    await taoDonTiktok({ campaignId: "T4", orders: 1, cost: 100_000, grossRevenue: "N/A" });
    const c = (await quangCaoTheoChienDich(RANGE)).chienDich[0];
    expect(c.gmvSan).toBeNull();
  });

  it("gmv hợp lệ nhưng cost DỊ ⇒ gmvSan/roiSan null (không phồng), donSan vẫn có số", async () => {
    // Chiều hở của cổng chỉ-kẹp-gmv: ngày 2 cộng 500.000 vào TỬ mà mẫu +0 ⇒ ROI phồng mà không tín hiệu.
    await taoChiAds({ nguon: "TIKTOK_ADS", campaignId: "T5", ten: "CD5", amount: 110_000, date: TRONG_KY });
    await taoChiAds({ nguon: "TIKTOK_ADS", campaignId: "T5", ten: "CD5", amount: 110_000, date: TRONG_KY_2 });
    await taoDonTiktok({ campaignId: "T5", orders: 1, cost: 100_000, grossRevenue: "100000", date: TRONG_KY });
    await taoDonTiktok({ campaignId: "T5", orders: 2, cost: "N/A", grossRevenue: "500000", date: TRONG_KY_2 });

    const c = (await quangCaoTheoChienDich(RANGE)).chienDich[0];
    expect(c.donSan).toBe(3); // cổng của Đơn không liên quan — orders hai ngày đều đọc được
    expect(c.gmvSan).toBeNull();
    expect(c.roiSan).toBeNull();
  });

  it("hai cổng phủ-ngày ĐỘC LẬP: orders THIẾU / gmv ĐỦ ⇒ donSan null nhưng gmvSan có số", async () => {
    await taoChiAds({ nguon: "TIKTOK_ADS", campaignId: "T6", ten: "CD6", amount: 110_000, date: TRONG_KY });
    await taoChiAds({ nguon: "TIKTOK_ADS", campaignId: "T6", ten: "CD6", amount: 110_000, date: TRONG_KY_2 });
    await taoDonTiktok({ campaignId: "T6", orders: 1, cost: 100_000, grossRevenue: "100000", date: TRONG_KY });
    // Ngày 2 KHÔNG có key orders nhưng CÓ đủ cost + gross_revenue.
    await taoDonTiktok({ campaignId: "T6", cost: 300_000, grossRevenue: "500000", date: TRONG_KY_2 });

    const c = (await quangCaoTheoChienDich(RANGE)).chienDich[0];
    expect(c.donSan).toBeNull();
    expect(c.gmvSan).toBe(600_000);
    expect(c.roiSan).toBeCloseTo(1.5, 6); // 600.000 / 400.000
  });

  it("hiển thị = 0 thì CTR/CPM là null, KHÔNG chia cho 0", async () => {
    await taoChiAds({ nguon: "META", campaignId: "C0", ten: "Chưa chạy", amount: 100_000 });
    await taoChiSoMeta({ campaignId: "C0", externalId: "m-0", impressions: 0, clicks: 0 });

    const r = await quangCaoTheoChienDich(RANGE);

    const c = r.chienDich[0];
    expect(c.hienThi).toBe(0);
    expect(c.ctr).toBeNull();
    expect(c.cpm).toBeNull();
    expect(c.cpc).toBeNull();
  });

  it("dòng Meta BẮN LẠI chỉ tính bản mới nhất — cộng cả hai là chỉ số phồng lên", async () => {
    await taoChiAds({ nguon: "META", campaignId: "C2", ten: "Set nâu", amount: 200_000 });
    await taoChiSoMeta({ campaignId: "C2", externalId: "m-2", impressions: 1_000, clicks: 10, fetchedAt: new Date("2026-05-20") });
    await taoChiSoMeta({ campaignId: "C2", externalId: "m-2", impressions: 3_000, clicks: 30, fetchedAt: new Date("2026-05-21") });

    const r = await quangCaoTheoChienDich(RANGE);

    expect(r.chienDich[0].hienThi).toBe(3_000);
    expect(r.chienDich[0].click).toBe(30);
  });

  it("nhiều dòng ads KHÔNG có mã chiến dịch: gộp 1 dòng nhãn cố định, KHÔNG mượn tên chiến dịch", async () => {
    // ads-import.ts ghi refId=null cho mọi dòng của file. Mượn description của một
    // dòng bất kỳ = nói với chủ shop rằng chiến dịch đó tiêu cả cụm tiền.
    await taoChiAds({ nguon: "META", campaignId: null, ten: "Váy hè – Retarget", amount: 400_000 });
    await taoChiAds({ nguon: "META", campaignId: null, ten: "Set nâu – Prospecting", amount: 377_000 });

    const r = await quangCaoTheoChienDich(RANGE);

    expect(r.tongChiTieu).toBe(777_000); // tiền KHÔNG được biến mất
    expect(r.chienDich).toHaveLength(1);
    const c = r.chienDich[0];
    expect(c.campaignId).toBe("");
    expect(c.khongRoChienDich).toBe(true);
    expect(c.soDongGop).toBe(2);
    expect(c.ten).toBe("(không rõ chiến dịch)");
    expect(c.ten).not.toContain("Váy hè");
    expect(c.ten).not.toContain("Set nâu");
  });

  it("refId TikTok ĐẤU GIÁ có 4 mảnh — vẫn tách đúng từng chiến dịch", async () => {
    // prepareAdsExpenseRow sinh "TIKTOK_ADS:auction:{ngày}:{campaignId}". Lấy mảnh
    // thứ 3 sẽ nhặt được NGÀY ⇒ mọi chiến dịch đấu giá cùng ngày gộp thành 1 dòng
    // mà tổng vẫn đúng nên không có tín hiệu nào báo sai.
    const ngay = format(TRONG_KY, "yyyy-MM-dd");
    for (const [cid, tien] of [["A1", 300_000], ["B2", 200_000], ["C3", 100_000]] as [string, number][]) {
      await prisma.expense.create({
        data: {
          date: TRONG_KY, categoryId: "ads", adsSource: "TIKTOK_ADS",
          description: `Đấu giá ${cid}`, amount: tien, source: "ADS_API",
          refId: `TIKTOK_ADS:auction:${ngay}:${cid}`,
        },
      });
    }

    const r = await quangCaoTheoChienDich(RANGE);

    expect(r.chienDich).toHaveLength(3);
    expect(r.chienDich.map((c) => c.campaignId)).toEqual(["A1", "B2", "C3"]);
    expect(r.chienDich.map((c) => c.chiTieu)).toEqual([300_000, 200_000, 100_000]);
    expect(r.chienDich.every((c) => !c.khongRoChienDich)).toBe(true);
  });

  it("chỉ số Meta NGOÀI kỳ bị loại — biên ngày không được lệch một ngày", async () => {
    // Ca này khoá lỗi ép `${Date}::date` trong SQL: session Postgres là UTC nên
    // mốc 01/05 00:00+07 bị dịch thành 2026-04-30, kéo thêm một ngày vào đầu kỳ ⇒
    // hiển thị/click phồng lên, CPM/CPC rẻ đi mà không có dấu hiệu gì.
    await taoChiAds({ nguon: "META", campaignId: "CB", ten: "Biên kỳ", amount: 1_000_000 });
    await taoChiSoMeta({ campaignId: "CB", externalId: "m-trong", impressions: 100_000, clicks: 1_000 });
    await taoChiSoMeta({
      campaignId: "CB", externalId: "m-truoc-1-ngay", impressions: 999_999, clicks: 9_999,
      date: new Date("2026-04-30T00:00:00+07:00"),
    });
    await taoChiSoMeta({
      campaignId: "CB", externalId: "m-sau-1-ngay", impressions: 888_888, clicks: 8_888,
      date: new Date("2026-06-01T00:00:00+07:00"),
    });

    const r = await quangCaoTheoChienDich(RANGE);

    expect(r.chienDich[0].hienThi).toBe(100_000);
    expect(r.chienDich[0].click).toBe(1_000);
    expect(r.chienDich[0].cpm).toBeCloseTo(10_000, 6);
  });

  it("cùng campaignId ở HAI nguồn: tách 2 dòng, KHÔNG mượn chỉ số chéo nguồn (cả 2 chiều)", async () => {
    await taoChiAds({ nguon: "META", campaignId: "XX", ten: "Meta XX", amount: 200_000 });
    await taoChiAds({ nguon: "TIKTOK_ADS", campaignId: "XX", ten: "TikTok XX", amount: 100_000 });
    await taoChiSoMeta({ campaignId: "XX", externalId: "m-xx", impressions: 50_000, clicks: 500 });
    await taoDonTiktok({ campaignId: "XX", orders: 3 });

    const r = await quangCaoTheoChienDich(RANGE);

    expect(r.chienDich).toHaveLength(2);
    const meta = r.chienDich.find((c) => c.nguon === "META")!;
    const tiktok = r.chienDich.find((c) => c.nguon === "TIKTOK_ADS")!;
    expect(meta.hienThi).toBe(50_000);
    expect(tiktok.hienThi).toBeNull(); // TikTok không mượn hiển thị/click của Meta
    expect(meta.donSan).toBeNull(); // Meta không mượn đơn sàn báo của TikTok
    expect(tiktok.donSan).toBe(3);
  });

  it("nguồn CÓ chỉ số không bị gắn nhãn 'thiếu chỉ số' chỉ vì một dòng không tra được", async () => {
    // Trộn: 1 dòng Meta có chỉ số + 1 dòng Meta nhập tay (refId null). META phải
    // nằm ở nguonCoChiSo và KHÔNG nằm ở nguonThieuChiSo, kẻo chú thích chân bảng
    // nói "Meta chưa trả chỉ số" ngay trên mấy dòng Meta đang hiện đủ số.
    await taoChiAds({ nguon: "META", campaignId: "CM", ten: "Có số", amount: 100_000 });
    await taoChiSoMeta({ campaignId: "CM", externalId: "m-cm", impressions: 10_000, clicks: 100 });
    await taoChiAds({ nguon: "META", campaignId: null, ten: "Gõ tay", amount: 50_000 });

    const r = await quangCaoTheoChienDich(RANGE);

    expect(r.nguonCoChiSo).toEqual(["META"]);
    expect(r.nguonThieuChiSo).toEqual([]);
  });

  it("chỉ lấy chi phí TRONG kỳ", async () => {
    await taoChiAds({ nguon: "META", campaignId: "C3", ten: "Trong kỳ", amount: 100_000 });
    await taoChiAds({ nguon: "META", campaignId: "C4", ten: "Ngoài kỳ", amount: 900_000, date: NGOAI_KY });

    const r = await quangCaoTheoChienDich(RANGE);

    expect(r.tongChiTieu).toBe(100_000);
    expect(r.chienDich.map((c) => c.ten)).toEqual(["Trong kỳ"]);
  });

  it("xếp theo chi tiêu giảm dần", async () => {
    await taoChiAds({ nguon: "META", campaignId: "A", ten: "A", amount: 100_000 });
    await taoChiAds({ nguon: "META", campaignId: "B", ten: "B", amount: 900_000 });
    await taoChiAds({ nguon: "TIKTOK_ADS", campaignId: "C", ten: "C", amount: 500_000 });

    const r = await quangCaoTheoChienDich(RANGE);

    expect(r.chienDich.map((c) => c.ten)).toEqual(["B", "C", "A"]);
  });

  it("chỉ đếm danh mục ads — chi phí khác không lọt vào bảng marketing", async () => {
    await prisma.expense.create({
      data: { date: TRONG_KY, categoryId: "shipping", description: "Ship", amount: 5_000_000, source: "MANUAL" },
    });
    await taoChiAds({ nguon: "META", campaignId: "C5", ten: "Ads thật", amount: 100_000 });

    const r = await quangCaoTheoChienDich(RANGE);

    expect(r.tongChiTieu).toBe(100_000);
    expect(r.chienDich).toHaveLength(1);
  });
});
