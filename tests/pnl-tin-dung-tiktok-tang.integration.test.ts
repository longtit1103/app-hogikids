import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { prisma } from "@/lib/prisma";
import { computeDailySeries } from "@/lib/reports/daily-series";
import { calcPnl, computeChannelPnl } from "@/lib/reports/pnl";

import { seedReference, truncateBusinessTables } from "./helpers/test-db";

/**
 * Tín dụng TikTok tặng đi từ DB THẬT (`hogikids_test`, bảng `TiktokAdsTinDung`) vào P&L. Phủ đúng chỗ kiểu dữ liệu
 * KHÔNG bảo vệ được: `opts.tinDungTang` là optional — quên truyền ở một call site (loader `calcPnl`, chuỗi ngày
 * `computeDailySeries`) thì không lỗi compile, chỉ ra số sai. Kỳ cố định 10/2026, neo giờ VN.
 */

const RANGE = { from: new Date(2026, 9, 1), to: new Date(2026, 9, 31) };
const NGAY_14 = new Date("2026-10-14T00:00:00+07:00");
const NGAY_31 = new Date("2026-10-31T00:00:00+07:00");
const NGOAI_KY = new Date("2026-11-01T00:00:00+07:00");
const BC = "7129545797879726081";

beforeAll(async () => {
  await seedReference();
}, 60_000);

beforeEach(async () => {
  await truncateBusinessTables();
});

afterAll(async () => {
  await prisma.$disconnect();
});

async function seedAdsTikTok(): Promise<void> {
  await prisma.expense.createMany({
    data: [
      {
        date: NGAY_14,
        categoryId: "ads",
        adsSource: "TIKTOK_ADS",
        channelId: "tiktok",
        description: "GMV Max",
        amount: 1_430_000,
        source: "ADS_API",
        refId: "TIKTOK_ADS:2026-10-14:C1",
      },
      {
        date: NGAY_31,
        categoryId: "ads",
        adsSource: "TIKTOK_ADS",
        channelId: "tiktok",
        description: "GMV Max",
        amount: 143_000,
        source: "ADS_API",
        refId: "TIKTOK_ADS:2026-10-31:C1",
      },
    ],
  });
}

const tinDung = (advertiserId: string, ngay: Date, grantGomVat: number) => ({
  advertiserId,
  ngay,
  bcId: BC,
  grantExVat: Math.round(grantGomVat / 1.1),
  cashExVat: 0,
  amountExVat: Math.round(grantGomVat / 1.1),
  grantGomVat,
});

describe("calcPnl — đọc TiktokAdsTinDung trong kỳ", () => {
  it("trừ tín dụng trong kỳ (kể cả ngày cuối kỳ); dòng ngoài kỳ bị loại", async () => {
    await seedAdsTikTok();
    await prisma.tiktokAdsTinDung.createMany({
      data: [
        tinDung("ADV-A", NGAY_14, 1_100_000),
        tinDung("ADV-B", NGAY_14, 110_000),
        tinDung("ADV-A", NGAY_31, 33_000),
        tinDung("ADV-A", NGOAI_KY, 9_999_000),
      ],
    });

    const b = await calcPnl(RANGE);
    expect(b.adsTinDungTang).toBe(1_243_000);
    expect(b.ads).toBe(1_573_000 - 1_243_000);
    expect(b.adsBySource.TIKTOK_ADS).toBe(330_000);
    expect(b.netProfit).toBe(-330_000);
  });

  it("kỳ KHÔNG có tín dụng ⇒ số y như trước (đối chứng)", async () => {
    await seedAdsTikTok();
    const b = await calcPnl(RANGE);
    expect(b.adsTinDungTang).toBe(0);
    expect(b.ads).toBe(1_573_000);
    expect(b.netProfit).toBe(-1_573_000);
  });

  it("lăng kính kênh qua loader: kênh tiktok trừ, kênh facebook không; /kenh đọc đúng số", async () => {
    await seedAdsTikTok();
    await prisma.tiktokAdsTinDung.create({ data: tinDung("ADV-A", NGAY_14, 1_100_000) });

    expect((await calcPnl(RANGE, { channelId: "tiktok" })).ads).toBe(473_000);
    expect((await calcPnl(RANGE, { channelId: "facebook" })).adsTinDungTang).toBe(0);
    const kenh = await computeChannelPnl(RANGE);
    expect(kenh.find((k) => k.channelId === "tiktok")?.ads).toBe(473_000);
  });
});

describe("kẹp THEO NGÀY qua loader — tháng = Σ ngày, kể cả ngày có tín dụng mà không có chi tiêu", () => {
  it("tín dụng 13/10 (Sổ chưa có chi tiêu TikTok ngày đó) KHÔNG trừ vào chi tiêu ngày khác", async () => {
    await seedAdsTikTok();
    const NGAY_13 = new Date("2026-10-13T00:00:00+07:00");
    await prisma.tiktokAdsTinDung.createMany({
      data: [tinDung("ADV-A", NGAY_13, 500_000), tinDung("ADV-A", NGAY_14, 1_100_000), tinDung("ADV-A", NGAY_31, 33_000)],
    });

    const [series, ky] = await Promise.all([computeDailySeries(RANGE), calcPnl(RANGE)]);
    // 13/10 trừ 0; 14/10 trừ 1.100.000; 31/10 trừ 33.000. Kẹp cả kỳ cũ sẽ trừ cả 500.000 của 13/10.
    expect(ky.adsTinDungTang).toBe(1_133_000);
    expect(ky.netProfit).toBe(-(1_573_000 - 1_133_000));
    expect(series.reduce((s, p) => s + p.netProfit, 0)).toBe(ky.netProfit);
    expect(series.find((p) => p.date === "2026-10-13")?.netProfit).toBe(0);
  });

  it("tín dụng lớn hơn chi tiêu NGÀY đó ⇒ kẹp theo ngày, phần dư KHÔNG tràn sang ngày khác", async () => {
    await seedAdsTikTok();
    await prisma.tiktokAdsTinDung.createMany({
      data: [tinDung("ADV-A", NGAY_31, 999_000)],
    });
    const [series, ky] = await Promise.all([computeDailySeries(RANGE), calcPnl(RANGE)]);
    expect(ky.adsTinDungTang).toBe(143_000);
    expect(series.reduce((s, p) => s + p.netProfit, 0)).toBe(ky.netProfit);
  });
});

describe("computeDailySeries — tín dụng bucket theo NGÀY", () => {
  it("Σ netProfit từng ngày = netProfit cả kỳ khi có tín dụng; tín dụng rơi đúng ngày chi tiêu", async () => {
    await seedAdsTikTok();
    await prisma.tiktokAdsTinDung.createMany({
      data: [tinDung("ADV-A", NGAY_14, 1_100_000), tinDung("ADV-A", NGAY_31, 33_000)],
    });

    const [series, ky] = await Promise.all([computeDailySeries(RANGE), calcPnl(RANGE)]);
    expect(ky.adsTinDungTang).toBe(1_133_000); // non-vacuity
    expect(series.reduce((s, p) => s + p.netProfit, 0)).toBe(ky.netProfit);
    expect(series.find((p) => p.date === "2026-10-14")?.netProfit).toBe(-330_000);
    expect(series.find((p) => p.date === "2026-10-31")?.netProfit).toBe(-110_000);
  });
});
