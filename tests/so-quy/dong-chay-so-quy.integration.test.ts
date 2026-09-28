import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { prisma } from "@/lib/prisma";
import type { DongSoQuy, NguonDongQuy, SoQuyDongChay } from "@/lib/so-quy/dong-chay-so-quy-types";
import { docSoQuyDongChay } from "@/lib/so-quy/dong-chay-so-quy-queries";
import { docTongNguon, tinhSoQuyThang } from "@/lib/so-quy/so-quy-queries";

import { seedReference, truncateBusinessTables } from "../helpers/test-db";

/**
 * Sổ quỹ dạng dòng chạy trên DB thật (`hogikids_test`): bảng phải là CHI TIẾT của đúng con số thẻ
 * "Quỹ còn lại" — cùng 8 nguồn, cùng cột ngày, cùng bộ lọc, cùng biên kỳ.
 *
 * Fixture vắt BIÊN có chủ đích: dòng ở 00:00:00 VN ngày 1 và 23:59:59.999 VN ngày cuối tháng (phải
 * vào), 1 giây trước / đúng 00:00 sau biên (phải ra), dòng TRƯỚC ngày mở sổ (không bao giờ vào), và
 * các dòng cùng bảng nhưng sai bộ lọc (TikTok chưa PAID, PAID thiếu ngày, ví Shopee không phải lệnh
 * rút, đơn direct chưa xong, đơn kênh khác lỡ mang tiền trả tại shop). Chọn sai cột ngày / bỏ một bộ
 * lọc — ở bộ lọc chung `boLocNguonQuy` (thẻ và bảng cùng đổi) hay ở riêng đường đọc dòng chạy — là một
 * trong các khẳng định dưới đây đỏ: số TÍNH TAY bắt ca hai bên cùng sai, đối chiếu thẻ bắt ca lệch nhau.
 *
 * Ngày mở sổ D0 = 15/09/2026, kỳ chính T10/2026.
 */

const vn = (iso: string) => new Date(`${iso}+07:00`);

const T8 = { from: vn("2026-08-01T00:00:00"), to: vn("2026-08-31T00:00:00") };
const T9 = { from: vn("2026-09-01T00:00:00"), to: vn("2026-09-30T00:00:00") };
const T10 = { from: vn("2026-10-01T00:00:00"), to: vn("2026-10-31T00:00:00") };
const T11 = { from: vn("2026-11-01T00:00:00"), to: vn("2026-11-30T00:00:00") };

const D0 = vn("2026-09-15T00:00:00");
const CUOI_T9 = "2026-09-30T23:59:59";
const DAU_T10 = "2026-10-01T00:00:00";
const CUOI_T10 = "2026-10-31T23:59:59.999";
const DAU_T11 = "2026-11-01T00:00:00";

/** Số tính TAY từ fixture — trọng tài độc lập với cả thẻ lẫn bảng (hai bên sai giống nhau vẫn bị bắt). */
const CUOI_KY_T9 = 101_800_000; // 100 − 3 + 4 + 0,7 + 0,1
const CUOI_KY_T10 = 134_230_000; // 101,8 + 90,93 − 58,5

beforeAll(async () => {
  await seedReference();
}, 60_000);

beforeEach(async () => {
  await truncateBusinessTables();
});

afterAll(async () => {
  await truncateBusinessTables();
  await prisma.$disconnect();
});

const don = (
  pancakeId: string,
  channelId: string,
  status: "COMPLETED" | "RETURNED" | "PENDING",
  orderedAt: Date,
  paidAtShop: number
) => ({
  pancakeId,
  code: `MA-${pancakeId}`,
  channelId,
  status,
  orderedAt,
  itemsTotal: 999_000_000, // CỐ Ý lệch số đã trả: quỹ phải đọc paidAtShop, KHÔNG đọc doanh thu
  paidAtShop,
  syncedAt: new Date(),
});

const adsApi = (refId: string, ngay: string, adsSource: string, amount: number) => ({
  date: vn(`${ngay}T00:00:00`), // ingest ADS_API neo 00:00 VN
  categoryId: "ads",
  adsSource,
  description: `Chiến dịch ${refId}`,
  amount,
  source: "ADS_API" as const,
  refId,
});

async function seedFixture(): Promise<void> {
  await prisma.cashMovement.createMany({
    data: [
      // Dòng đầu tiên ⇒ D0 = 15/09 (ngày mở sổ neo đầu ngày).
      { date: vn("2026-09-15T10:00:00"), kind: "CAPITAL_IN", amount: 100_000_000, description: "Mở sổ" },
      { date: vn(CUOI_T9), kind: "OTHER_IN", amount: 4_000_000, description: "Thu khác sát biên T9" },
      { date: vn(DAU_T10), kind: "CAPITAL_IN", amount: 50_000_000, description: "Góp thêm đầu T10" },
      { date: vn(CUOI_T10), kind: "CAPITAL_OUT", amount: 10_000_000, description: "" },
      { date: vn(DAU_T11), kind: "OTHER_IN", amount: 7_000_000, description: "Sang T11" },
    ],
  });

  const tt = (paymentId: string, status: string, paidTime: Date | null, v: number) => ({
    paymentId,
    shopId: "100975192",
    status,
    paidTime,
    settlementValue: v,
    amountValue: v,
  });
  await prisma.tiktokPayment.createMany({
    data: [
      tt("dc-pay-1", "PAID", vn("2026-10-05T09:00:00"), 30_000_000),
      tt("dc-pay-dau-t10", "PAID", vn(DAU_T10), 1_000_000),
      tt("dc-pay-failed", "FAILED", vn("2026-10-06T09:00:00"), 66_000_000),
      tt("dc-pay-thieu-ngay", "PAID", null, 55_000_000),
      tt("dc-pay-truoc-d0", "PAID", vn("2026-09-10T09:00:00"), 77_000_000),
    ],
  });

  const sp = (externalId: string, type: string, txnTime: Date, amount: number) => ({
    externalId,
    shopId: "1942992175",
    txnTime,
    type,
    amount,
    status: "ok",
    runningBalance: 0,
  });
  await prisma.shopeeSettlement.createMany({
    data: [
      sp("dc-sp-rut", "WITHDRAWAL", vn("2026-10-06T11:00:00"), -5_000_000),
      sp("dc-sp-dao-rut", "WITHDRAWAL", vn("2026-10-07T11:00:00"), 1_000_000), // dòng đảo lệnh rút
      sp("dc-sp-doanh-thu", "REVENUE", vn("2026-10-06T11:00:00"), 8_000_000),
      sp("dc-sp-dieu-chinh", "ADJUSTMENT", vn("2026-10-06T11:00:00"), -600_000),
      sp("dc-sp-rut-t11", "WITHDRAWAL", vn(DAU_T11), -2_000_000),
    ],
  });

  await prisma.expense.createMany({
    data: [
      { date: vn("2026-09-14T23:59:59"), categoryId: "other", description: "Trước D0 1 giây", amount: 9_900_000, source: "MANUAL" },
      { date: vn("2026-09-20T00:00:00"), categoryId: "shipping", description: "Ship T9", amount: 3_000_000, source: "MANUAL" },
      { date: vn("2026-10-09T00:00:00"), categoryId: "purchase", description: "Nhập hàng", amount: 40_000_000, source: "MANUAL" },
      { date: vn("2026-10-12T00:00:00"), categoryId: "ads", adsSource: "META", description: "Ads Meta gõ tay", amount: 1_000_000, source: "MANUAL" },
      { date: vn("2026-10-31T00:00:00"), categoryId: "fixed", description: "Mặt bằng", amount: 5_000_000, source: "RECURRING" },
      adsApi("META:2026-10-12:c1", "2026-10-12", "META", 100_000),
      adsApi("META:2026-10-12:c2", "2026-10-12", "META", 200_000),
      adsApi("META:2026-10-12:c3", "2026-10-12", "META", 300_000),
      adsApi("TIKTOK_ADS:2026-10-12:c1", "2026-10-12", "TIKTOK_ADS", 250_000),
      adsApi("TIKTOK_ADS:2026-10-12:c2", "2026-10-12", "TIKTOK_ADS", 150_000),
      adsApi("META:2026-10-13:c1", "2026-10-13", "META", 500_000),
      adsApi("META:2026-11-01:c1", "2026-11-01", "META", 800_000),
    ],
  });

  const ads = (transactionId: string, orderCreateTime: Date, settlementAmount: number) => ({
    transactionId,
    shopId: "100975192",
    orderCreateTime,
    settlementAmount,
  });
  await prisma.tiktokAdsSettlement.createMany({
    data: [
      ads("dc-ads-cuoi-t9", vn(CUOI_T9), -700_000),
      ads("dc-ads-1", vn("2026-10-08T15:00:00"), -1_500_000),
      ads("dc-ads-cuoi-t10", vn(CUOI_T10), -500_000),
      ads("dc-ads-t11", vn(DAU_T11), -9_000_000),
    ],
  });

  await prisma.thuNhap.create({
    data: { date: vn("2026-10-20T00:00:00"), kind: "LAI_TIET_KIEM", amount: 2_000_000, description: "Lãi sổ A" },
  });

  await prisma.order.createMany({
    data: [
      don("dc-bt-cuoi-t9", "direct", "COMPLETED", vn(CUOI_T9), 100_000),
      don("dc-bt-dau-t10", "direct", "COMPLETED", vn(DAU_T10), 410_000),
      don("dc-bt-cuoi-t10", "direct", "COMPLETED", vn(CUOI_T10), 520_000),
      don("dc-bt-t11", "direct", "COMPLETED", vn(DAU_T11), 330_000),
      don("dc-bt-hoan", "direct", "RETURNED", vn("2026-10-10T10:00:00"), 300_000),
      don("dc-bt-cho", "direct", "PENDING", vn("2026-10-11T10:00:00"), 200_000),
      // Đơn sàn lỡ mang paidAtShop (không bao giờ xảy ra qua mapping) vẫn KHÔNG được vào quỹ.
      don("dc-san-1", "tiktok", "COMPLETED", vn("2026-10-21T10:00:00"), 777_000),
    ],
  });
}

type CoSo = Extract<SoQuyDongChay, { trangThai: "CO_SO" }>;

async function docCoSo(range: { from: Date; to: Date }): Promise<CoSo> {
  const r = await docSoQuyDongChay(range);
  if (r.trangThai !== "CO_SO") throw new Error(`mong CO_SO, nhận ${r.trangThai}`);
  return r;
}

const theoNguon = (dong: DongSoQuy[], nguon: NguonDongQuy) => dong.filter((d) => d.nguon === nguon);
/** Σ (thu − chi) của một nhóm nguồn — đóng góp CÓ DẤU vào quỹ. */
const rong = (dong: DongSoQuy[], ...nguon: NguonDongQuy[]) =>
  dong.filter((d) => nguon.includes(d.nguon)).reduce((s, d) => s + d.thu - d.chi, 0);

describe("docSoQuyDongChay — khớp thẻ Quỹ trên DB thật", () => {
  it("T10: cuối kỳ dòng chạy = thẻ = số tính tay; không lệch; số dư dòng cuối = cuối kỳ", async () => {
    await seedFixture();
    const r = await docCoSo(T10);
    const the = await tinhSoQuyThang(T10);

    expect(r.d0).toEqual(D0);
    expect(r.tu).toEqual(T10.from); // kỳ bắt đầu SAU D0 ⇒ tu = đầu kỳ
    expect(r.dauKy).toBe(the.dauKy);
    expect(r.dauKy).toBe(CUOI_KY_T9);
    expect(r.cuoiKy).toBe(the.cuoiKy);
    expect(r.cuoiKy).toBe(CUOI_KY_T10);
    expect(r.lechDoiChieu).toBeNull();
    // Nguyên số liệu thẻ đi kèm (cảnh báo, quỹ hôm nay) — cùng kỳ, không đọc lại khác đi.
    expect(r.the).toEqual(the);
    expect(r.dauKy + r.tongThu - r.tongChi).toBe(r.cuoiKy);
    expect(r.dong.at(-1)!.soDu).toBe(r.cuoiKy);
    // Hiệu thu − chi bằng của thẻ dù từng vế có thể khác (thẻ bù trừ rút/đảo rút Shopee trước).
    expect(r.tongThu - r.tongChi).toBe(the.thu - the.chi);

    // Không dòng nào mang cả hai vế; xếp cũ → mới.
    for (const d of r.dong) expect(d.thu === 0 || d.chi === 0).toBe(true);
    for (let i = 1; i < r.dong.length; i++) {
      expect(r.dong[i].ngay.getTime()).toBeGreaterThanOrEqual(r.dong[i - 1].ngay.getTime());
    }
  });

  it("T10: Σ đóng góp theo từng nguồn = đúng trường của docTongNguon(tu, den)", async () => {
    await seedFixture();
    const r = await docCoSo(T10);
    const t = await docTongNguon(r.tu, r.den);
    const ghiTay = theoNguon(r.dong, "GHI_TAY");

    expect(ghiTay.reduce((s, d) => s + d.thu, 0)).toBe(t.ghiTayVao);
    expect(ghiTay.reduce((s, d) => s + d.chi, 0)).toBe(t.ghiTayRa);
    expect(rong(r.dong, "TIKTOK_VE_BANK")).toBe(t.tiktokVeBank);
    expect(rong(r.dong, "SHOPEE_RUT_VI")).toBe(-t.shopeeRutViCoDau);
    expect(-rong(r.dong, "CHI_PHI", "CHI_PHI_ADS_GOP")).toBe(t.chiPhi);
    expect(rong(r.dong, "ADS_TIKTOK_TRU_VI")).toBe(-t.adsTiktokViCoDau);
    expect(rong(r.dong, "THU_NHAP")).toBe(t.thuNhap);
    expect(rong(r.dong, "BAN_TRUC_TIEP")).toBe(t.banTrucTiep);

    // Số tuyệt đối — bắt ca cả thẻ lẫn bảng cùng đọc sai một nguồn.
    expect(t).toEqual({
      ghiTayVao: 50_000_000,
      ghiTayRa: 10_000_000,
      tiktokVeBank: 31_000_000,
      shopeeRutViCoDau: -4_000_000,
      chiPhi: 47_500_000,
      adsTiktokViCoDau: -2_000_000,
      thuNhap: 2_000_000,
      banTrucTiep: 930_000,
    });
  });

  it("T10: đúng tập dòng — biên vào, ngoài biên/sai bộ lọc/trước D0 ra", async () => {
    await seedFixture();
    const r = await docCoSo(T10);
    const dem = (n: NguonDongQuy) => theoNguon(r.dong, n).length;

    expect(dem("GHI_TAY")).toBe(2); // 00:00 ngày 1 + 23:59:59.999 ngày cuối; 1 giây trước + 00:00 T11 ra
    expect(dem("TIKTOK_VE_BANK")).toBe(2); // FAILED · PAID thiếu ngày · trước D0 đều ra
    expect(dem("SHOPEE_RUT_VI")).toBe(2); // REVENUE/ADJUSTMENT ra
    expect(dem("CHI_PHI")).toBe(3); // nhập hàng + ads gõ tay + định kỳ — ads gõ tay KHÔNG bị gộp
    expect(dem("CHI_PHI_ADS_GOP")).toBe(3);
    expect(dem("ADS_TIKTOK_TRU_VI")).toBe(2);
    expect(dem("THU_NHAP")).toBe(1);
    expect(dem("BAN_TRUC_TIEP")).toBe(2); // hoàn · chờ · kênh sàn · T11 · cuối T9 đều ra

    const shopee = theoNguon(r.dong, "SHOPEE_RUT_VI");
    expect(shopee.map((d) => [d.thu, d.chi])).toEqual([
      [5_000_000, 0], // rút (âm) ⇒ thu
      [0, 1_000_000], // đảo rút (dương) ⇒ chi
    ]);
    expect(theoNguon(r.dong, "ADS_TIKTOK_TRU_VI").every((d) => d.thu > 0 && d.chi === 0)).toBe(true);

    const ban = theoNguon(r.dong, "BAN_TRUC_TIEP");
    expect(ban.map((d) => d.dienGiai)).toEqual([
      "Bán trực tiếp — đơn MA-dc-bt-dau-t10",
      "Bán trực tiếp — đơn MA-dc-bt-cuoi-t10",
    ]);
    expect(ban[0].ngay).toEqual(vn(DAU_T10));
    expect(ban[1].ngay).toEqual(vn(CUOI_T10));

    const ghiTay = theoNguon(r.dong, "GHI_TAY");
    expect(ghiTay.map((d) => d.dienGiai)).toEqual(["Góp vốn / nhập quỹ — Góp thêm đầu T10", "Rút vốn"]);
    expect(theoNguon(r.dong, "THU_NHAP")[0].dienGiai).toBe("Lãi tiết kiệm — Lãi sổ A");
    expect(theoNguon(r.dong, "CHI_PHI").map((d) => d.dienGiai)).toContain("Nhập hàng — Nhập hàng");
  });

  it("ads ADS_API gộp 1 dòng / ngày VN / nền tảng, tổng giữ nguyên", async () => {
    await seedFixture();
    const r = await docCoSo(T10);
    const gop = theoNguon(r.dong, "CHI_PHI_ADS_GOP");

    expect(gop.map((d) => [d.key, d.chi, d.dienGiai])).toEqual([
      ["CHI_PHI_ADS_GOP:2026-10-12:META", 600_000, "Quảng cáo Meta — 3 chiến dịch"],
      ["CHI_PHI_ADS_GOP:2026-10-12:TIKTOK_ADS", 400_000, "Quảng cáo TikTok Ads — 2 chiến dịch"],
      ["CHI_PHI_ADS_GOP:2026-10-13:META", 500_000, "Quảng cáo Meta — 1 chiến dịch"],
    ]);
    expect(gop[0].ngay).toEqual(vn("2026-10-12T00:00:00"));

    const tongAdsApi = await prisma.expense.aggregate({
      where: { source: "ADS_API", date: { gte: T10.from, lte: vn(CUOI_T10) } },
      _sum: { amount: true },
    });
    expect(gop.reduce((s, d) => s + d.chi, 0)).toBe(tongAdsApi._sum.amount);
  });

  it("khoản ngược chiều: ads tự động ÂM + sàn hoàn ads về ví (DƯƠNG) — dấu từng dòng đúng, vẫn khớp thẻ", async () => {
    await seedFixture();
    await prisma.expense.createMany({
      data: [
        adsApi("META:2026-10-12:hoan", "2026-10-12", "META", -250_000), // nhóm META 12/10 còn trừ ròng
        adsApi("TIKTOK_ADS:2026-10-14:hoan", "2026-10-14", "TIKTOK_ADS", -80_000), // cả ngày chỉ có hoàn
      ],
    });
    await prisma.tiktokAdsSettlement.create({
      data: { transactionId: "dc-ads-hoan", shopId: "100975192", orderCreateTime: vn("2026-10-15T10:00:00"), settlementAmount: 300_000 },
    });

    const r = await docCoSo(T10);
    expect(r.lechDoiChieu).toBeNull();
    expect(r.cuoiKy).toBe((await tinhSoQuyThang(T10)).cuoiKy);
    expect(r.cuoiKy).toBe(CUOI_KY_T10 + 250_000 + 80_000 - 300_000); // tính tay

    const theoKey = Object.fromEntries(r.dong.map((d) => [d.key, [d.thu, d.chi]]));
    expect(theoKey["CHI_PHI_ADS_GOP:2026-10-12:META"]).toEqual([0, 350_000]);
    expect(theoKey["CHI_PHI_ADS_GOP:2026-10-14:TIKTOK_ADS"]).toEqual([80_000, 0]);
    const hoanVi = r.dong.find((d) => d.nguon === "ADS_TIKTOK_TRU_VI" && d.chi > 0);
    expect(hoanVi && [hoanVi.thu, hoanVi.chi]).toEqual([0, 300_000]);

    const t = await docTongNguon(r.tu, r.den);
    expect(-rong(r.dong, "CHI_PHI", "CHI_PHI_ADS_GOP")).toBe(t.chiPhi);
    expect(rong(r.dong, "ADS_TIKTOK_TRU_VI")).toBe(-t.adsTiktokViCoDau);
  });

  it("kỳ chứa D0: tu = D0, dòng trước D0 (kể cả 1 giây) không vào; đầu kỳ 0; nối liền tháng sau", async () => {
    await seedFixture();
    const t9 = await docCoSo(T9);
    expect(t9.tu).toEqual(D0);
    expect(t9.dauKy).toBe(0);
    expect(t9.cuoiKy).toBe(CUOI_KY_T9);
    expect(t9.cuoiKy).toBe((await tinhSoQuyThang(T9)).cuoiKy);
    expect(t9.lechDoiChieu).toBeNull();
    expect(theoNguon(t9.dong, "TIKTOK_VE_BANK")).toHaveLength(0); // lệnh 10/09 trước D0
    expect(theoNguon(t9.dong, "CHI_PHI").map((d) => d.dienGiai)).toEqual(["Vận chuyển — Ship T9"]);
    expect(t9.dong.map((d) => d.ngay.getTime()).some((x) => x === vn(CUOI_T9).getTime())).toBe(true);

    const t10 = await docCoSo(T10);
    const t11 = await docCoSo(T11);
    expect(t10.dauKy).toBe(t9.cuoiKy);
    expect(t11.dauKy).toBe(t10.cuoiKy);
    expect(t11.lechDoiChieu).toBeNull();
    expect(t11.dong.filter((d) => d.ngay.getTime() === vn(DAU_T11).getTime())).toHaveLength(5);
  });

  it("3 trạng thái: chưa mở sổ · kỳ trọn trước D0 · có sổ (kỳ rỗng vẫn là CO_SO, không dòng)", async () => {
    expect(await docSoQuyDongChay(T10)).toEqual({ trangThai: "CHUA_MO_SO" });

    await prisma.cashMovement.create({
      data: { date: vn("2026-09-15T10:00:00"), kind: "CAPITAL_IN", amount: 1_000_000, description: "Mở sổ" },
    });
    expect(await docSoQuyDongChay(T8)).toEqual({ trangThai: "TRUOC_MO_SO", d0: D0 });

    const rong10 = await docCoSo(T10);
    expect(rong10.dong).toEqual([]);
    expect([rong10.dauKy, rong10.cuoiKy, rong10.tongThu, rong10.tongChi]).toEqual([1_000_000, 1_000_000, 0, 0]);
    expect(rong10.lechDoiChieu).toBeNull();
  });
});
