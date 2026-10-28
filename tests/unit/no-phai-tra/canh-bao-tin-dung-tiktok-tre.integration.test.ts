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
