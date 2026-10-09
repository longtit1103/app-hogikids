import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { KEY_NO_PHAI_TRA_TU_NGAY } from "@/lib/no-phai-tra/cong-bat-no-phai-tra";
import { docNguCanhLoc } from "@/lib/no-phai-tra/doc-ngu-canh-loc";
import { soDuViAds } from "@/lib/no-phai-tra/so-du-vi-ads";
import { prisma } from "@/lib/prisma";
import { tinhSoQuyThang } from "@/lib/so-quy/so-quy-queries";

import { seedReference, truncateBusinessTables } from "../../helpers/test-db";

/**
 * Ví ads Shopee nạp trước (S1, spec §5.9) trên DB thật: ví ĐỌC mọi lần nạp (ngân hàng lẫn thẻ — ví không
 * phân biệt nguồn), quỹ chỉ trừ lần nạp từ ngân hàng; chi chạy ads Shopee từ M trừ VÍ, không trừ quỹ.
 *
 * Fixture (M = 01/11, neo ví 31/10 = 0, mở sổ 12/05 góp vốn 150tr): nạp ngân hàng 10tr 05/11; Expense
 * SHOPEE_ADS 2tr rải 06–10/11. Tính tay: ví(10/11) = 0 + 10 − 2 = 8tr; quỹ T11: chi 10tr (nạp), không
 * phải 12tr ⇒ cuối kỳ 140tr. Thêm nạp bằng thẻ 5tr 07/11 ⇒ ví 13tr, quỹ T11 vẫn chi 10tr.
 */
const vn = (iso: string) => new Date(`${iso}+07:00`);
const T11 = { from: vn("2026-11-01T00:00:00"), to: vn("2026-11-30T00:00:00") };

let viId = "";

beforeAll(async () => {
  await seedReference();
}, 60_000);

beforeEach(async () => {
  await truncateBusinessTables();
  await prisma.setting.upsert({
    where: { key: KEY_NO_PHAI_TRA_TU_NGAY },
    create: { key: KEY_NO_PHAI_TRA_TU_NGAY, value: "2026-11-01" },
    update: { value: "2026-11-01" },
  });
  await prisma.cashMovement.create({
    data: { date: vn("2026-05-12T09:00:00"), kind: "CAPITAL_IN", amount: 150_000_000, description: "Mở sổ" },
  });
  viId = (
    await prisma.viAdsTraTruoc.create({
      data: { nenTang: "SHOPEE_ADS", soDuNeo: 0, ngayNeo: vn("2026-10-31T00:00:00") },
    })
  ).id;
  await prisma.cashMovement.create({
    data: { date: vn("2026-11-05T09:00:00"), kind: "ADS_TOPUP", amount: 10_000_000, description: "Nạp ví", viAdsId: viId },
  });
  await prisma.expense.createMany({
    data: ["06", "07", "08", "09", "10"].map((d) => ({
      date: vn(`2026-11-${d}T00:00:00`),
      categoryId: "ads",
      adsSource: "SHOPEE_ADS",
      source: "MANUAL" as const,
      amount: 400_000,
      description: `Shopee Ads ${d}/11`,
    })),
  });
});

afterAll(async () => {
  await truncateBusinessTables();
  await prisma.setting.deleteMany({ where: { key: KEY_NO_PHAI_TRA_TU_NGAY } });
  await prisma.$disconnect();
});

describe("soDuViAds + quỹ theo nguồn nạp", () => {
  it("nạp ngân hàng 10tr, chạy 2tr ⇒ ví 8tr; quỹ T11 chi 10tr, cuối 140tr", async () => {
    expect(await soDuViAds("SHOPEE_ADS", vn("2026-11-10T00:00:00"))).toBe(8_000_000);
    const the = await tinhSoQuyThang(T11, await docNguCanhLoc());
    expect(the.chi).toBe(10_000_000);
    expect(the.cuoiKy).toBe(140_000_000);
  });

  it("thêm nạp bằng thẻ 5tr ⇒ ví 13tr, quỹ không đổi", async () => {
    const the = await prisma.theTinDung.create({ data: { ten: "Thẻ", ngayChotSaoKe: 25, ngayHanTra: 10 } });
    await prisma.cashMovement.create({
      data: {
        date: vn("2026-11-07T09:00:00"),
        kind: "ADS_TOPUP",
        amount: 5_000_000,
        description: "Nạp ví bằng thẻ",
        viAdsId: viId,
        cardId: the.id,
      },
    });
    expect(await soDuViAds("SHOPEE_ADS", vn("2026-11-10T00:00:00"))).toBe(13_000_000);
    const so = await tinhSoQuyThang(T11, await docNguCanhLoc());
    expect(so.chi).toBe(10_000_000);
  });

  it("công tắc tắt ⇒ chi ads Shopee vẫn trừ quỹ như cũ (chi 12tr)", async () => {
    await prisma.setting.deleteMany({ where: { key: KEY_NO_PHAI_TRA_TU_NGAY } });
    const the = await tinhSoQuyThang(T11, await docNguCanhLoc());
    expect(the.chi).toBe(12_000_000);
  });

  it("nền tảng chưa có hồ sơ ví ⇒ null", async () => {
    expect(await soDuViAds("META", vn("2026-11-10T00:00:00"))).toBeNull();
  });
});
