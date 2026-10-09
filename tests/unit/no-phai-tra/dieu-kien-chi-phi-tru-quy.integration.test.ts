import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { KEY_NO_PHAI_TRA_TU_NGAY } from "@/lib/no-phai-tra/cong-bat-no-phai-tra";
import {
  dieuKienChiPhiTruQuy,
  dieuKienViTiktokCongLai,
} from "@/lib/no-phai-tra/dieu-kien-chi-phi-tru-quy";
import { docNguCanhLoc } from "@/lib/no-phai-tra/doc-ngu-canh-loc";
import { theCuaDongChi, type NguCanhLoc } from "@/lib/no-phai-tra/the-cua-dong-chi";
import { prisma } from "@/lib/prisma";
import { bien, tinhSoQuyThang } from "@/lib/so-quy/so-quy-queries";

import { seedReference, truncateBusinessTables } from "../../helpers/test-db";

/**
 * Bộ lọc "chi phí trừ quỹ" chạy THẬT trên Postgres (`hogikids_test`) — trọng tài cho NOT/OR và cho
 * NULL của `adsSource`/`cardId` (logic ba trị của SQL: `adsSource = 'X'` với NULL là NULL, bọc NOT
 * vẫn NULL ⇒ dòng ads MANUAL không nguồn bị loại oan — bẫy mà so object Prisma không bao giờ thấy).
 *
 * Fixture (M = 01/11, META→A từ 01/11, TIKTOK_ADS→B từ 01/11, hồ sơ ví SHOPEE_ADS neo 31/10). Tiền mỗi dòng là một luỹ thừa của 2
 * (×1.000đ) để tổng chỉ ra ĐÚNG tập dòng:
 *   e1   1.000 ads META ADS_API 31/10 23:59 VN       — trước T_META ⇒ TRỪ quỹ
 *   e2   2.000 ads META ADS_API 01/11 00:00 VN       — thẻ A gánh ⇒ không trừ (b)
 *   e3   4.000 ads TIKTOK_ADS ADS_API 01/11          — thẻ B gánh ⇒ không trừ (b)
 *   e4   8.000 ads MANUAL không adsSource 05/11      — không nền tảng ⇒ TRỪ
 *   e5  16.000 other cardId=A 02/11 (MANUAL)         — ghi tay trừ thẻ ⇒ không trừ (a)
 *   e6  32.000 other không thẻ 02/11                 — TRỪ
 *   e7  64.000 purchase 10/09                        — trước M ⇒ TRỪ
 *   e8 128.000 ads IMPORT META 03/11                 — thẻ A gánh ⇒ không trừ (b)
 *   e9 256.000 ads SHOPEE_ADS MANUAL 02/11 không thẻ — ví trả trước (S1) ⇒ không trừ (c)
 * Tính tay: trừ quỹ = 1 + 8 + 32 + 64 = 105 nghìn; tắt công tắc = 1+2+…+256 = 511 nghìn.
 */
const vn = (ymd: string) => new Date(`${ymd}T00:00:00+07:00`);
const M = vn("2026-11-01");
const KHOANG = bien(vn("2026-09-01"), vn("2026-11-30"));

let theA = "";
let theB = "";

beforeAll(async () => {
  await seedReference();
}, 60_000);

beforeEach(async () => {
  await truncateBusinessTables();
  await prisma.setting.deleteMany({ where: { key: KEY_NO_PHAI_TRA_TU_NGAY } });
  theA = (await prisma.theTinDung.create({ data: { ten: "Thẻ A", ngayChotSaoKe: 25, ngayHanTra: 10 } })).id;
  theB = (await prisma.theTinDung.create({ data: { ten: "Thẻ B", ngayChotSaoKe: 25, ngayHanTra: 10 } })).id;
});

afterAll(async () => {
  await truncateBusinessTables();
  await prisma.setting.deleteMany({ where: { key: KEY_NO_PHAI_TRA_TU_NGAY } });
  await prisma.$disconnect();
});

const ctxBat = (): NguCanhLoc => ({
  mocM: M,
  gan: [
    { cardId: theA, nenTang: "META", tuNgay: M },
    { cardId: theB, nenTang: "TIKTOK_ADS", tuNgay: M },
  ],
  viAds: [{ nenTang: "SHOPEE_ADS", ngayNeo: vn("2026-10-31") }],
});

async function seedChiPhi(): Promise<void> {
  const ds = [
    { amount: 1_000, categoryId: "ads", adsSource: "META", source: "ADS_API", date: new Date("2026-10-31T16:59:00Z") },
    { amount: 2_000, categoryId: "ads", adsSource: "META", source: "ADS_API", date: new Date("2026-10-31T17:00:00Z") },
    { amount: 4_000, categoryId: "ads", adsSource: "TIKTOK_ADS", source: "ADS_API", date: vn("2026-11-01") },
    { amount: 8_000, categoryId: "ads", adsSource: null, source: "MANUAL", date: vn("2026-11-05") },
    { amount: 16_000, categoryId: "other", adsSource: null, source: "MANUAL", date: vn("2026-11-02"), cardId: theA },
    { amount: 32_000, categoryId: "other", adsSource: null, source: "MANUAL", date: vn("2026-11-02") },
    { amount: 64_000, categoryId: "purchase", adsSource: null, source: "MANUAL", date: vn("2026-09-10") },
    { amount: 128_000, categoryId: "ads", adsSource: "META", source: "IMPORT", date: vn("2026-11-03") },
    { amount: 256_000, categoryId: "ads", adsSource: "SHOPEE_ADS", source: "MANUAL", date: vn("2026-11-02") },
  ] as const;
  await prisma.expense.createMany({
    data: ds.map((d, i) => ({ ...d, description: `e${i + 1}` })),
  });
}

async function tong(ctx: NguCanhLoc): Promise<number> {
  const r = await prisma.expense.aggregate({ where: dieuKienChiPhiTruQuy(ctx, KHOANG), _sum: { amount: true } });
  return r._sum.amount ?? 0;
}

describe("dieuKienChiPhiTruQuy trên DB thật", () => {
  it("bật (M + gắn META/TikTok): trừ quỹ = e1 + e4 + e6 + e7 = 105 nghìn", async () => {
    await seedChiPhi();
    const ds = await prisma.expense.findMany({
      where: dieuKienChiPhiTruQuy(ctxBat(), KHOANG),
      select: { description: true },
      orderBy: { amount: "asc" },
    });
    expect(ds.map((d) => d.description)).toEqual(["e1", "e4", "e6", "e7"]);
    expect(await tong(ctxBat())).toBe(105_000);
  });

  it("tắt (mocM null) dù gắn + cardId: trừ quỹ = cả 9 dòng = 511 nghìn (y công thức cũ)", async () => {
    await seedChiPhi();
    expect(await tong({ ...ctxBat(), mocM: null })).toBe(511_000);
    const cu = await prisma.expense.aggregate({ where: { date: KHOANG }, _sum: { amount: true } });
    expect(cu._sum.amount).toBe(511_000);
  });

  it("M có, CHƯA gắn nền tảng nào: ads nền tảng vẫn trừ; chỉ cardId (a) và SHOPEE_ADS (c) bị loại", async () => {
    await seedChiPhi();
    // 511 − e5 16 − e9 256 = 239 nghìn.
    expect(await tong({ mocM: M, gan: [], viAds: ctxBat().viAds })).toBe(239_000);
  });

  it("M có nhưng CHƯA có hồ sơ ví ⇒ SHOPEE_ADS vẫn trừ quỹ (không ghi được nạp ví thì loại là quỹ phồng)", async () => {
    await seedChiPhi();
    // 105 + e9 256 = 361 nghìn.
    expect(await tong({ ...ctxBat(), viAds: [] })).toBe(361_000);
  });

  it("hồ sơ ví neo 31/10 (đọc từ DB): SHOPEE_ADS 31/10 23:59 trừ, 01/11 00:00 không", async () => {
    await prisma.setting.create({ data: { key: KEY_NO_PHAI_TRA_TU_NGAY, value: "2026-11-01" } });
    await prisma.viAdsTraTruoc.create({ data: { nenTang: "SHOPEE_ADS", soDuNeo: 0, ngayNeo: vn("2026-10-31") } });
    await prisma.expense.createMany({
      data: [
        { amount: 1_000, categoryId: "ads", adsSource: "SHOPEE_ADS", source: "MANUAL", date: new Date("2026-10-31T16:59:00Z"), description: "s3110" },
        { amount: 2_000, categoryId: "ads", adsSource: "SHOPEE_ADS", source: "MANUAL", date: new Date("2026-10-31T17:00:00Z"), description: "s0111" },
      ],
    });
    expect(await tong(await docNguCanhLoc())).toBe(1_000);
  });

  it("hồ sơ ví neo SAU M (10/11): cắt từ ngày sau neo — 10/11 trừ, 11/11 không", async () => {
    await prisma.expense.createMany({
      data: [
        { amount: 1_000, categoryId: "ads", adsSource: "SHOPEE_ADS", source: "MANUAL", date: vn("2026-11-10"), description: "s10" },
        { amount: 2_000, categoryId: "ads", adsSource: "SHOPEE_ADS", source: "MANUAL", date: vn("2026-11-11"), description: "s11" },
      ],
    });
    expect(await tong({ mocM: M, gan: [], viAds: [{ nenTang: "SHOPEE_ADS", ngayNeo: vn("2026-11-10") }] })).toBe(1_000);
  });

  it("dòng có cardId nhưng TRƯỚC M vẫn trừ quỹ (cardId chỉ có hiệu lực từ M)", async () => {
    await prisma.expense.create({
      data: { amount: 7_000, categoryId: "other", source: "MANUAL", date: vn("2026-10-20"), cardId: theA, description: "x" },
    });
    expect(await tong(ctxBat())).toBe(7_000);
  });

  it("gắn TikTok từ 15/11 (sau M): ads TikTok 14/11 vẫn trừ, 15/11 không", async () => {
    await prisma.expense.createMany({
      data: [
        { amount: 1_000, categoryId: "ads", adsSource: "TIKTOK_ADS", source: "ADS_API", date: vn("2026-11-14"), description: "t14" },
        { amount: 2_000, categoryId: "ads", adsSource: "TIKTOK_ADS", source: "ADS_API", date: vn("2026-11-15"), description: "t15" },
      ],
    });
    const ctx: NguCanhLoc = {
      mocM: M,
      gan: [{ cardId: theB, nenTang: "TIKTOK_ADS", tuNgay: vn("2026-11-15") }],
      viAds: [],
    };
    expect(await tong(ctx)).toBe(1_000);
  });

  it("gắn META từ 15/11 14:00 VN (giờ lẻ): ads 14/11 23:59:59 trừ, ads 15/11 00:00 KHÔNG (thẻ A gánh cả ngày)", async () => {
    // Mốc cắt phải là ĐẦU NGÀY của tuNgay: dùng tuNgay thô (14:00) thì dòng 00:00 cùng ngày vừa trừ quỹ vừa
    // cộng nợ thẻ — `theCuaDongChi` so theo khoá ngày nên gán dòng đó cho thẻ A.
    const ctx: NguCanhLoc = {
      mocM: M,
      gan: [{ cardId: theA, nenTang: "META", tuNgay: new Date("2026-11-15T14:00:00+07:00") }],
      viAds: [],
    };
    const truoc = { amount: 1_000, categoryId: "ads", adsSource: "META", source: "ADS_API" as const, date: new Date("2026-11-14T23:59:59+07:00") };
    const dauNgay = { amount: 2_000, categoryId: "ads", adsSource: "META", source: "ADS_API" as const, date: vn("2026-11-15") };
    await prisma.expense.createMany({
      data: [
        { ...truoc, description: "m14" },
        { ...dauNgay, description: "m15" },
      ],
    });
    expect(await tong(ctx)).toBe(1_000);
    expect(theCuaDongChi(ctx, { ...dauNgay, cardId: null })).toBe(theA);
    expect(theCuaDongChi(ctx, { ...truoc, cardId: null })).toBeNull();
  });
});

describe("dieuKienViTiktokCongLai trên DB thật — biên giờ VN", () => {
  async function seedVi(): Promise<void> {
    await prisma.tiktokAdsSettlement.createMany({
      data: [
        // 23:59 VN 31/10 — trước T_TIKTOK_ADS ⇒ cộng lại.
        { transactionId: "v-truoc", shopId: "s", orderCreateTime: new Date("2026-10-31T16:59:00Z"), settlementAmount: -1_000 },
        // 00:01 VN 01/11 — từ T trở đi thẻ B gánh ads, ví không cộng lại nữa.
        { transactionId: "v-sau", shopId: "s", orderCreateTime: new Date("2026-10-31T17:01:00Z"), settlementAmount: -2_000 },
      ],
    });
  }
  async function tongVi(ctx: NguCanhLoc): Promise<number> {
    const r = await prisma.tiktokAdsSettlement.aggregate({
      where: dieuKienViTiktokCongLai(ctx, KHOANG),
      _sum: { settlementAmount: true },
    });
    return r._sum.settlementAmount ?? 0;
  }

  it("TIKTOK_ADS gắn từ 01/11: chỉ dòng 23:59 VN 31/10 cộng lại", async () => {
    await seedVi();
    expect(await tongVi(ctxBat())).toBe(-1_000);
  });

  it("TIKTOK_ADS chưa gắn: cả hai dòng cộng lại (y cũ)", async () => {
    await seedVi();
    expect(await tongVi({ mocM: M, gan: [{ cardId: theA, nenTang: "META", tuNgay: M }], viAds: [] })).toBe(-3_000);
    expect(await tongVi({ ...ctxBat(), mocM: null })).toBe(-3_000);
  });
});

describe("docAdsTiktok — sổ và ví cắt CÙNG mốc T_TIKTOK_ADS (qua tinhSoQuyThang)", () => {
  /**
   * M = 01/11, TIKTOK_ADS → thẻ B từ 15/11. Ads TikTok (sổ chi phí) 10tr 05/11 + 30tr 20/11; ví TikTok sàn trừ
   * 6tr (05/11) + 18tr (20/11). Tính tay: chỉ phần TRƯỚC 15/11 còn trong quỹ ⇒ soChiPhi 10tr, sanTruVi 6tr.
   * Sổ không lọc (40tr) mà ví cắt (6tr) là cờ "ví vượt sổ" không bao giờ kêu.
   */
  const TR = 1_000_000;
  const T11 = { from: vn("2026-11-01"), to: vn("2026-11-30") };
  const ctxTiktok = (): NguCanhLoc => ({
    mocM: M,
    gan: [{ cardId: theB, nenTang: "TIKTOK_ADS", tuNgay: vn("2026-11-15") }],
    viAds: [],
  });

  async function seedAdsTiktok(): Promise<void> {
    await prisma.cashMovement.create({
      data: { date: new Date("2026-05-12T09:00:00+07:00"), kind: "CAPITAL_IN", amount: 150 * TR, description: "Mở sổ" },
    });
    await prisma.expense.createMany({
      data: [
        { amount: 10 * TR, categoryId: "ads", adsSource: "TIKTOK_ADS", source: "ADS_API", date: vn("2026-11-05"), description: "tt05" },
        { amount: 30 * TR, categoryId: "ads", adsSource: "TIKTOK_ADS", source: "ADS_API", date: vn("2026-11-20"), description: "tt20" },
      ],
    });
    await prisma.tiktokAdsSettlement.createMany({
      data: [
        { transactionId: "vi-05", shopId: "100975192", orderCreateTime: new Date("2026-11-05T10:00:00+07:00"), settlementAmount: -6 * TR },
        { transactionId: "vi-20", shopId: "100975192", orderCreateTime: new Date("2026-11-20T10:00:00+07:00"), settlementAmount: -18 * TR },
      ],
    });
  }

  it("soChiPhi 10tr, sanTruVi 6tr; ví không vượt sổ", async () => {
    await seedAdsTiktok();
    const the = await tinhSoQuyThang(T11, ctxTiktok());
    expect(the.adsTiktok).toEqual({ soChiPhi: 10 * TR, sanTruVi: 6 * TR });
    expect(the.canhBao.adsViVuotSo).toBe(false);
  });

  it("ví trừ thêm 5tr trước T (06/11) ⇒ ví 11tr > sổ 10tr ⇒ cờ ví vượt sổ kêu", async () => {
    await seedAdsTiktok();
    await prisma.tiktokAdsSettlement.create({
      data: { transactionId: "vi-06", shopId: "100975192", orderCreateTime: new Date("2026-11-06T10:00:00+07:00"), settlementAmount: -5 * TR },
    });
    const the = await tinhSoQuyThang(T11, ctxTiktok());
    expect(the.adsTiktok).toEqual({ soChiPhi: 10 * TR, sanTruVi: 11 * TR });
    expect(the.canhBao.adsViVuotSo).toBe(true);
  });
});

describe("docNguCanhLoc", () => {
  it("chưa có Setting ⇒ mocM null", async () => {
    const ctx = await docNguCanhLoc();
    expect(ctx.mocM).toBeNull();
    expect(ctx.gan).toEqual([]);
    expect(ctx.viAds).toEqual([]);
  });

  it("đọc M (00:00 VN) + lịch sử gắn", async () => {
    await prisma.setting.create({ data: { key: KEY_NO_PHAI_TRA_TU_NGAY, value: "2026-11-01" } });
    await prisma.ganNenTangThe.create({ data: { cardId: theA, nenTang: "META", tuNgay: M } });
    const ctx = await docNguCanhLoc();
    expect(ctx.mocM).toEqual(M);
    expect(ctx.gan).toEqual([{ cardId: theA, nenTang: "META", tuNgay: M }]);
    expect(ctx.viAds).toEqual([]);
  });

  it("đọc hồ sơ ví trả trước (nenTang + ngayNeo)", async () => {
    await prisma.viAdsTraTruoc.create({ data: { nenTang: "SHOPEE_ADS", soDuNeo: 5_000, ngayNeo: vn("2026-10-31") } });
    expect((await docNguCanhLoc()).viAds).toEqual([{ nenTang: "SHOPEE_ADS", ngayNeo: vn("2026-10-31") }]);
  });
});
