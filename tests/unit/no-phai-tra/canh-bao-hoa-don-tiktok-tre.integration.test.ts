import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { docCanhBaoHoaDonTiktok } from "@/lib/no-phai-tra/canh-bao-hoa-don-tiktok-tre";
import { KEY_NO_PHAI_TRA_TU_NGAY } from "@/lib/no-phai-tra/cong-bat-no-phai-tra";
import { prisma } from "@/lib/prisma";

import { seedReference, truncateBusinessTables } from "../../helpers/test-db";

/**
 * Cảnh báo độ tươi hoá đơn TikTok trừ thẻ (DB thật `hogikids_test`). M = 01/11/2026, thẻ gánh TIKTOK_ADS từ 01/11,
 * "bây giờ" = 20/11 09:00 VN. Chi tiêu ads TikTok vẫn về mà hoá đơn ngừng ⇒ dư nợ thẻ ước tính THIẾU ⇒ phải nói ra.
 */

const vn = (ngay: string, gio = "00:00:00") => new Date(`${ngay}T${gio}+07:00`);
const BAY_GIO = vn("2026-11-20", "09:00:00");

beforeAll(async () => {
  await seedReference();
}, 60_000);

beforeEach(async () => {
  await truncateBusinessTables();
  await prisma.setting.deleteMany({ where: { key: KEY_NO_PHAI_TRA_TU_NGAY } });
});

afterEach(async () => {
  await prisma.setting.deleteMany({ where: { key: KEY_NO_PHAI_TRA_TU_NGAY } });
});

afterAll(async () => {
  await truncateBusinessTables();
  await prisma.$disconnect();
});

async function batVaGan(gan = true): Promise<void> {
  await prisma.setting.create({ data: { key: KEY_NO_PHAI_TRA_TU_NGAY, value: "2026-11-01" } });
  const the = await prisma.theTinDung.create({ data: { ten: "Visa", ngayChotSaoKe: 20, ngayHanTra: 5 } });
  if (gan) await prisma.ganNenTangThe.create({ data: { cardId: the.id, nenTang: "TIKTOK_ADS", tuNgay: vn("2026-11-01") } });
}

let soRef = 0;
async function adsTiktok(ngay: string, amount: number): Promise<void> {
  soRef += 1;
  await prisma.expense.create({
    data: {
      date: vn(ngay),
      categoryId: "ads",
      adsSource: "TIKTOK_ADS",
      channelId: "tiktok",
      amount,
      description: `GMV Max ${ngay}`,
      source: "ADS_API",
      refId: `TIKTOK_ADS:${ngay}:canh-bao-${soRef}`,
    },
  });
}

let soHd = 0;
async function hoaDon(ngay: string, { billing = "CASH", gio = "12:00:00" } = {}): Promise<void> {
  soHd += 1;
  await prisma.tiktokAdsHoaDon.create({
    data: {
      transactionId: `cb-${soHd}`,
      bcId: "bc",
      advertiserId: "adv",
      createTime: vn(ngay, gio),
      amount: 143_000,
      transactionType: "BILL_PAYMENT",
      billingType: billing,
      amountType: "POSITIVE",
    },
  });
}

let soTinDung = 0;
async function tinDung(ngay: string, grantGomVat: number): Promise<void> {
  soTinDung += 1;
  await prisma.tiktokAdsTinDung.create({
    data: {
      advertiserId: `adv-${soTinDung}`,
      ngay: vn(ngay),
      bcId: "bc",
      grantExVat: Math.round(grantGomVat / 1.1),
      cashExVat: 0,
      amountExVat: Math.round(grantGomVat / 1.1),
      grantGomVat,
    },
  });
}

describe("docCanhBaoHoaDonTiktok", () => {
  it("chi tiêu 19/11 về mà hoá đơn trừ thẻ cuối cùng là 15/11 ⇒ cảnh báo từ 17/11", async () => {
    await batVaGan();
    await adsTiktok("2026-11-18", 1_200_000);
    await adsTiktok("2026-11-19", 1_200_000);
    await hoaDon("2026-11-15");
    expect(await docCanhBaoHoaDonTiktok(BAY_GIO)).toEqual({ tuNgay: "2026-11-17" });
  });

  it("có hoá đơn trừ thẻ từ 17/11 (00:00 VN) ⇒ không cảnh báo", async () => {
    await batVaGan();
    await adsTiktok("2026-11-19", 1_200_000);
    await hoaDon("2026-11-17", { gio: "00:00:00" });
    expect(await docCanhBaoHoaDonTiktok(BAY_GIO)).toBeNull();
  });

  it("chỉ có hoá đơn tín dụng tặng (CREDIT) — không phải lần trừ thẻ ⇒ vẫn cảnh báo", async () => {
    await batVaGan();
    await adsTiktok("2026-11-19", 1_200_000);
    await hoaDon("2026-11-18", { billing: "CREDIT" });
    expect(await docCanhBaoHoaDonTiktok(BAY_GIO)).toEqual({ tuNgay: "2026-11-17" });
  });

  it("TIKTOK_ADS không gắn thẻ ⇒ không cảnh báo (nợ thẻ không đọc hoá đơn TikTok)", async () => {
    await batVaGan(false);
    await adsTiktok("2026-11-19", 1_200_000);
    expect(await docCanhBaoHoaDonTiktok(BAY_GIO)).toBeNull();
  });

  it("chưa bật theo dõi nợ (M rỗng) ⇒ không cảnh báo", async () => {
    await adsTiktok("2026-11-19", 1_200_000);
    expect(await docCanhBaoHoaDonTiktok(BAY_GIO)).toBeNull();
  });

  it("chi tiêu thấp (chưa chạm ngưỡng xuất hoá đơn) ⇒ không báo động giả", async () => {
    await batVaGan();
    await adsTiktok("2026-11-19", 100_000);
    expect(await docCanhBaoHoaDonTiktok(BAY_GIO)).toBeNull();
  });

  it("tín dụng tặng trả gần trọn chi tiêu 3 ngày (phần trả tiền < ngưỡng) ⇒ không có hoá đơn là đúng, không báo", async () => {
    await batVaGan();
    await adsTiktok("2026-11-18", 600_000);
    await adsTiktok("2026-11-19", 600_000);
    await tinDung("2026-11-18", 550_000);
    await tinDung("2026-11-19", 500_000);
    // 1.200.000 − 1.050.000 = 150.000 < 300.000.
    expect(await docCanhBaoHoaDonTiktok(BAY_GIO)).toBeNull();
  });

  it("tín dụng chỉ trả một phần (phần trả tiền ≥ ngưỡng) mà không hoá đơn ⇒ vẫn cảnh báo; tín dụng NGOÀI khoảng không trừ", async () => {
    await batVaGan();
    await adsTiktok("2026-11-18", 600_000);
    await adsTiktok("2026-11-19", 600_000);
    await tinDung("2026-11-19", 500_000);
    // Tín dụng 16/11 nằm trước D − 2 (17/11) ⇒ không được trừ.
    await tinDung("2026-11-16", 5_000_000);
    // 1.200.000 − 500.000 = 700.000 ≥ 300.000.
    expect(await docCanhBaoHoaDonTiktok(BAY_GIO)).toEqual({ tuNgay: "2026-11-17" });
  });

  it("chi tiêu cuối cùng cũ hơn 3 ngày (shop ngừng chạy ads) ⇒ không cảnh báo", async () => {
    await batVaGan();
    await adsTiktok("2026-11-15", 1_200_000);
    expect(await docCanhBaoHoaDonTiktok(BAY_GIO)).toBeNull();
  });
});
