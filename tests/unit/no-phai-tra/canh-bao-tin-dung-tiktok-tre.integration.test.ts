import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  cauCanhBaoTinDungTiktokTre,
  docCanhBaoTinDungTiktokTre,
} from "@/lib/no-phai-tra/canh-bao-tin-dung-tiktok-tre";
import { prisma } from "@/lib/prisma";

import { seedReference, truncateBusinessTables } from "../../helpers/test-db";

/**
 * Cảnh báo độ tươi ảnh chụp tín dụng TikTok tặng (DB thật `hogikids_test`). "Bây giờ" = 20/11 09:00 VN. Chi tiêu ads
 * TikTok vẫn về mà ảnh chụp `/bc/account/cost/get/` ngừng land ⇒ Lãi/Lỗ ngừng trừ tín dụng mới ⇒ phải nói ra.
 */

const vn = (ngay: string, gio = "00:00:00") => new Date(`${ngay}T${gio}+07:00`);
const BAY_GIO = vn("2026-11-20", "09:00:00");

async function donSach(): Promise<void> {
  await truncateBusinessTables();
  await prisma.rawTiktokBusinessCost.deleteMany();
  await prisma.rawTiktokBusinessReport.deleteMany();
}

beforeAll(async () => {
  await seedReference();
}, 60_000);

beforeEach(donSach);

afterAll(async () => {
  await donSach();
  await prisma.$disconnect();
});

let soRef = 0;
async function adsTiktok(ngay: string, amount = 1_200_000, cardId: string | null = null): Promise<void> {
  soRef += 1;
  await prisma.expense.create({
    data: {
      date: vn(ngay),
      categoryId: "ads",
      adsSource: "TIKTOK_ADS",
      channelId: "tiktok",
      amount,
      description: `GMV Max ${ngay}`,
      // Dòng có thẻ ghi tay bắt buộc nguồn MANUAL (CHECK `Expense_card_chi_manual`).
      source: cardId === null ? "ADS_API" : "MANUAL",
      refId: cardId === null ? `TIKTOK_ADS:${ngay}:tin-dung-tre-${soRef}` : null,
      cardId,
    },
  });
}

let soAnh = 0;
/** Một ảnh chụp Bronze của BC `bcId` land lúc `fetchedAt` (payload tối thiểu — hàm chỉ đọc `max(fetchedAt)` theo BC). */
async function anhChup(fetchedAt: Date, bcId = "bc"): Promise<void> {
  soAnh += 1;
  await prisma.rawTiktokBusinessCost.create({
    data: {
      shopId: bcId,
      externalId: `2026-11-${String(soAnh).padStart(2, "0")}`,
      payloadHash: `hash-${soAnh}`,
      payload: { trang: [], _ngay: "2026-11-01" },
      fetchedAt,
    },
  });
}

describe("docCanhBaoTinDungTiktokTre", () => {
  it("ads TikTok 19/11 về mà ảnh chụp mới nhất land 17/11 01:20 (> 48h) ⇒ cảnh báo từ 17/11", async () => {
    await adsTiktok("2026-11-19");
    await anhChup(vn("2026-11-15", "01:20:00"));
    await anhChup(vn("2026-11-17", "01:20:00"));
    const c = await docCanhBaoTinDungTiktokTre(BAY_GIO);
    expect(c).toEqual({ tuNgay: "2026-11-17" });
    expect(cauCanhBaoTinDungTiktokTre(c!)).toBe(
      "Ảnh chụp tín dụng TikTok chưa về từ 17/11 — Lãi/Lỗ có thể đang tính thừa chi phí ads (kiểm workflow n8n / quyền finance BC)",
    );
  });

  it("ảnh chụp land đêm qua (< 48h) ⇒ không cảnh báo", async () => {
    await adsTiktok("2026-11-19");
    await anhChup(vn("2026-11-20", "01:20:00"));
    expect(await docCanhBaoTinDungTiktokTre(BAY_GIO)).toBeNull();
  });

  it("đúng biên 48h ⇒ chưa báo; quá 1 phút ⇒ báo", async () => {
    await adsTiktok("2026-11-19");
    await anhChup(vn("2026-11-18", "09:00:00"));
    expect(await docCanhBaoTinDungTiktokTre(BAY_GIO)).toBeNull();
    expect(await docCanhBaoTinDungTiktokTre(vn("2026-11-20", "09:01:00"))).toEqual({ tuNgay: "2026-11-18" });
  });

  it("bảng ảnh chụp RỖNG mà có ads TikTok ⇒ cảnh báo 'chưa về lần nào'", async () => {
    await adsTiktok("2026-11-18");
    const c = await docCanhBaoTinDungTiktokTre(BAY_GIO);
    expect(c).toEqual({ tuNgay: null });
    expect(cauCanhBaoTinDungTiktokTre(c!)).toContain("Ảnh chụp tín dụng TikTok chưa về lần nào");
  });

  it("ads TikTok có thẻ ghi tay vẫn tính (tín dụng trừ mọi chi tiêu TikTok, không theo thẻ)", async () => {
    const the = await prisma.theTinDung.create({ data: { ten: "Visa", ngayChotSaoKe: 20, ngayHanTra: 5 } });
    await adsTiktok("2026-11-19", 500_000, the.id);
    expect(await docCanhBaoTinDungTiktokTre(BAY_GIO)).toEqual({ tuNgay: null });
  });

  it("không có ads TikTok trong 3 ngày gần nhất (ads 16/11, nền tảng khác) ⇒ không cảnh báo", async () => {
    await adsTiktok("2026-11-16");
    await prisma.expense.create({
      data: {
        date: vn("2026-11-19"),
        categoryId: "ads",
        adsSource: "META",
        amount: 900_000,
        description: "Meta 19/11",
        source: "ADS_API",
        refId: "META:2026-11-19:tin-dung-tre",
      },
    });
    expect(await docCanhBaoTinDungTiktokTre(BAY_GIO)).toBeNull();
  });
});

describe("docCanhBaoTinDungTiktokTre — độ tươi THEO TỪNG Business Center", () => {
  const BC_SONG = "7129545797879726081";
  const BC_CHET = "7200000000000000002";

  it("2 BC: một BC land đêm qua, BC kia ngừng từ 17/11 ⇒ VẪN cảnh báo, nêu đúng BC chết", async () => {
    await adsTiktok("2026-11-19");
    await anhChup(vn("2026-11-20", "01:20:00"), BC_SONG);
    await anhChup(vn("2026-11-17", "01:20:00"), BC_CHET);
    const c = await docCanhBaoTinDungTiktokTre(BAY_GIO);
    expect(c).toEqual({ tuNgay: "2026-11-17", bcIds: [BC_CHET] });
    expect(cauCanhBaoTinDungTiktokTre(c!)).toBe(
      `Ảnh chụp tín dụng TikTok chưa về từ 17/11 (BC ${BC_CHET}) — Lãi/Lỗ có thể đang tính thừa chi phí ads (kiểm workflow n8n / quyền finance BC)`,
    );
  });

  it("2 BC đều land đêm qua ⇒ không cảnh báo", async () => {
    await adsTiktok("2026-11-19");
    await anhChup(vn("2026-11-20", "01:20:00"), BC_SONG);
    await anhChup(vn("2026-11-20", "01:25:00"), BC_CHET);
    expect(await docCanhBaoTinDungTiktokTre(BAY_GIO)).toBeNull();
  });

  it("2 BC đều ngừng ⇒ mốc = BC ngừng LÂU nhất, nêu cả hai BC", async () => {
    await adsTiktok("2026-11-19");
    await anhChup(vn("2026-11-16", "01:20:00"), BC_SONG);
    await anhChup(vn("2026-11-17", "01:20:00"), BC_CHET);
    expect(await docCanhBaoTinDungTiktokTre(BAY_GIO)).toEqual({ tuNgay: "2026-11-16", bcIds: [BC_SONG, BC_CHET] });
  });

  it("một BC ⇒ không nêu BC (giữ nguyên câu cũ)", async () => {
    await adsTiktok("2026-11-19");
    await anhChup(vn("2026-11-17", "01:20:00"), BC_SONG);
    const c = await docCanhBaoTinDungTiktokTre(BAY_GIO);
    expect(c).toStrictEqual({ tuNgay: "2026-11-17" });
    expect(cauCanhBaoTinDungTiktokTre(c!)).not.toContain(BC_SONG);
  });
});

/**
 * BC NGHỈ HẲN: BC ngừng land ảnh chụp mà chi tiêu TikTok 3 ngày gần nhất quy hết về BC khác (refId → báo cáo thô →
 * advertiser → BC theo `TiktokAdsTinDung`) ⇒ không còn bị báo "tín dụng chưa về" mãi. Chi tiêu không quy được ⇒ xét
 * mọi BC như cũ.
 */
describe("docCanhBaoTinDungTiktokTre — BC nghỉ hẳn", () => {
  const BC_SONG = "7129545797879726081";
  const BC_NGHI = "7200000000000000002";
  const ADV_SONG = "7300000000000000001";
  const ADV_NGHI = "7300000000000000002";

  /** Dòng `Expense` ads TikTok đúng khuôn refId của đường ingest (GMV Max hoặc auction). */
  async function chiTieu(ngay: string, campaign: string, auction = false): Promise<void> {
    await prisma.expense.create({
      data: {
        date: vn(ngay),
        categoryId: "ads",
        adsSource: "TIKTOK_ADS",
        channelId: "tiktok",
        amount: 800_000,
        description: `Chiến dịch ${campaign}`,
        source: "ADS_API",
        refId: auction ? `TIKTOK_ADS:auction:${ngay}:${campaign}` : `TIKTOK_ADS:${ngay}:${campaign}`,
      },
    });
  }

  /**
   * Báo cáo thô của advertiser: `externalId` đúng khuôn `streams.ts` (`[auction:]<campaign>:<ngày>`), land tối chính
   * ngày đó (mặc định) — `fetchedAt` tường minh vì hàm chỉ đọc kho thô từ đầu cửa sổ chi tiêu − 1 ngày.
   */
  async function baoCaoTho(
    advertiserId: string,
    ngay: string,
    campaign: string,
    auction = false,
    fetchedAt: Date = vn(ngay, "23:00:00")
  ): Promise<void> {
    await prisma.rawTiktokBusinessReport.create({
      data: {
        shopId: advertiserId,
        externalId: `${auction ? "auction:" : ""}${campaign}:${ngay}`,
        payloadHash: `bc-${advertiserId}-${campaign}-${ngay}`,
        payload: { dimensions: { campaign_id: campaign, stat_time_day: `${ngay} 00:00:00` } },
        fetchedAt,
      },
    });
  }

  /** Một ngày tín dụng đã ghi — chỉ để biết advertiser thuộc BC nào. */
  async function advertiserCuaBc(advertiserId: string, bcId: string, ngay: string): Promise<void> {
    await prisma.tiktokAdsTinDung.create({
      data: { advertiserId, ngay: vn(ngay), bcId, grantExVat: 0, cashExVat: 1_000, amountExVat: 1_000, grantGomVat: 0 },
    });
  }

  async function nenHaiBc(): Promise<void> {
    await anhChup(vn("2026-11-20", "01:20:00"), BC_SONG);
    await anhChup(vn("2026-10-30", "01:20:00"), BC_NGHI);
    await advertiserCuaBc(ADV_SONG, BC_SONG, "2026-11-18");
    await advertiserCuaBc(ADV_NGHI, BC_NGHI, "2026-10-28");
  }

  it("BC ngừng land từ 30/10, chi tiêu 18–19/11 đều của advertiser BC còn sống ⇒ KHÔNG cảnh báo", async () => {
    await nenHaiBc();
    await chiTieu("2026-11-18", "c-song-1");
    await chiTieu("2026-11-19", "c-song-2", true);
    await baoCaoTho(ADV_SONG, "2026-11-18", "c-song-1");
    await baoCaoTho(ADV_SONG, "2026-11-19", "c-song-2", true);
    expect(await docCanhBaoTinDungTiktokTre(BAY_GIO)).toBeNull();
  });

  it("advertiser của BC đã ngừng land vẫn chi tiêu ⇒ VẪN cảnh báo, nêu đúng BC đó", async () => {
    await nenHaiBc();
    await chiTieu("2026-11-19", "c-song");
    await chiTieu("2026-11-19", "c-nghi");
    await baoCaoTho(ADV_SONG, "2026-11-19", "c-song");
    await baoCaoTho(ADV_NGHI, "2026-11-19", "c-nghi");
    expect(await docCanhBaoTinDungTiktokTre(BAY_GIO)).toEqual({ tuNgay: "2026-10-30", bcIds: [BC_NGHI] });
  });

  it("có chi tiêu KHÔNG quy được về BC (campaign chưa có báo cáo thô) ⇒ xét mọi BC như cũ", async () => {
    await nenHaiBc();
    await chiTieu("2026-11-19", "c-song");
    await chiTieu("2026-11-19", "c-la");
    await baoCaoTho(ADV_SONG, "2026-11-19", "c-song");
    expect(await docCanhBaoTinDungTiktokTre(BAY_GIO)).toEqual({ tuNgay: "2026-10-30", bcIds: [BC_NGHI] });
  });

  it("advertiser chi tiêu chưa từng có ảnh chụp tín dụng (không biết BC) ⇒ xét mọi BC như cũ", async () => {
    await nenHaiBc();
    await chiTieu("2026-11-19", "c-moi");
    await baoCaoTho("7300000000000000009", "2026-11-19", "c-moi");
    expect(await docCanhBaoTinDungTiktokTre(BAY_GIO)).toEqual({ tuNgay: "2026-10-30", bcIds: [BC_NGHI] });
  });

  it("advertiser chỉ thuộc BC đã nghỉ theo ánh xạ CŨ (> 30 ngày), nay chi tiêu không rõ BC ⇒ xét mọi BC như cũ", async () => {
    await anhChup(vn("2026-11-20", "01:20:00"), BC_SONG);
    await anhChup(vn("2026-10-01", "01:20:00"), BC_NGHI);
    await advertiserCuaBc(ADV_NGHI, BC_NGHI, "2026-10-01");
    await chiTieu("2026-11-19", "c-cu");
    await baoCaoTho(ADV_NGHI, "2026-11-19", "c-cu");
    expect(await docCanhBaoTinDungTiktokTre(BAY_GIO)).toEqual({ tuNgay: "2026-10-01", bcIds: [BC_NGHI] });
  });

  it("báo cáo thô land TRƯỚC cửa sổ chi tiêu − 1 ngày không được đọc (không quét cả kho) ⇒ không quy được ⇒ xét mọi BC", async () => {
    await nenHaiBc();
    await chiTieu("2026-11-19", "c-song");
    await baoCaoTho(ADV_SONG, "2026-11-19", "c-song", false, vn("2026-11-10"));
    expect(await docCanhBaoTinDungTiktokTre(BAY_GIO)).toEqual({ tuNgay: "2026-10-30", bcIds: [BC_NGHI] });
  });
});
