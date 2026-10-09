import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { getExpenseSummary } from "@/lib/expenses/expense-queries";
import type { NguCanhLoc } from "@/lib/no-phai-tra/the-cua-dong-chi";
import { prisma } from "@/lib/prisma";

import { seedReference, truncateBusinessTables } from "../../helpers/test-db";

/**
 * `getExpenseSummary` hai chế độ trên DB thật: KHÔNG opts = Sổ chi phí (mọi dòng, y cũ); `chiTienThat` =
 * tab Dòng tiền (chỉ phần TRỪ QUỸ — cùng bộ lọc Sổ quỹ). Kỳ T11/2026, M = 01/11, META→thẻ A từ 01/11.
 *
 * Fixture (triệu): T11 — ads META ADS_API 1 (02/11, thẻ A gánh) · other không thẻ 3 · other cardId A 0,5 ·
 * purchase 2. Kỳ trước (02/10–31/10, cùng 30 ngày) — ads META 0,4 (31/10) · other cardId A 0,2 (20/10,
 * trước M nên vẫn là tiền quỹ).
 * Tính tay — không opts: total 6,5 · ads 1 · prev 0,6 · adsPrev 0,4.
 *            chiTienThat: total 5 (3 + 2) · ads 0 · prev 0,6 · adsPrev 0,4 · không có dòng breakdown ads.
 */
const vn = (ymd: string) => new Date(`${ymd}T00:00:00+07:00`);
const T11 = { from: vn("2026-11-01"), to: vn("2026-11-30") };
const M = vn("2026-11-01");

let theA = "";

beforeAll(async () => {
  await seedReference();
}, 60_000);

beforeEach(async () => {
  await truncateBusinessTables();
  theA = (await prisma.theTinDung.create({ data: { ten: "Thẻ A", ngayChotSaoKe: 25, ngayHanTra: 10 } })).id;
  await prisma.expense.createMany({
    data: [
      { date: vn("2026-11-02"), categoryId: "ads", adsSource: "META", source: "ADS_API", amount: 1_000_000, description: "Meta" },
      { date: vn("2026-11-03"), categoryId: "other", source: "MANUAL", amount: 3_000_000, description: "Khác" },
      { date: vn("2026-11-04"), categoryId: "other", source: "MANUAL", amount: 500_000, description: "Phí thẻ", cardId: theA },
      { date: vn("2026-11-05"), categoryId: "purchase", source: "MANUAL", amount: 2_000_000, description: "Nhập" },
      { date: vn("2026-10-31"), categoryId: "ads", adsSource: "META", source: "ADS_API", amount: 400_000, description: "Meta T10" },
      { date: vn("2026-10-20"), categoryId: "other", source: "MANUAL", amount: 200_000, description: "Thẻ trước M", cardId: theA },
    ],
  });
});

afterAll(async () => {
  await truncateBusinessTables();
  await prisma.$disconnect();
});

describe("getExpenseSummary — Sổ chi phí vs tiền thật ra", () => {
  it("không opts ⇒ mọi dòng (Sổ chi phí, y cũ)", async () => {
    const s = await getExpenseSummary(T11);
    expect(s.total).toBe(6_500_000);
    expect(s.adsTotal).toBe(1_000_000);
    expect(s.totalPrev).toBe(600_000);
    expect(s.adsTotalPrev).toBe(400_000);
    expect(s.breakdown.map((b) => [b.categoryId, b.amount])).toEqual([
      ["other", 3_500_000],
      ["purchase", 2_000_000],
      ["ads", 1_000_000],
    ]);
  });

  it("chiTienThat ⇒ chỉ phần trừ quỹ: bỏ ads thẻ gánh + dòng cardId sau M", async () => {
    const ctx: NguCanhLoc = { mocM: M, gan: [{ cardId: theA, nenTang: "META", tuNgay: M }], viAds: [] };
    const s = await getExpenseSummary(T11, { chiTienThat: ctx });
    expect(s.total).toBe(5_000_000);
    expect(s.adsTotal).toBe(0);
    expect(s.totalPrev).toBe(600_000);
    expect(s.adsTotalPrev).toBe(400_000);
    expect(s.breakdown.map((b) => [b.categoryId, b.amount])).toEqual([
      ["other", 3_000_000],
      ["purchase", 2_000_000],
    ]);
  });

  it("chiTienThat, kỳ TRƯỚC nằm sau M ⇒ totalPrev/adsTotalPrev cũng chỉ phần trừ quỹ", async () => {
    // Kỳ 01/12–30/12 (30 ngày) ⇒ kỳ trước 01/11–30/11: ads META 1 (thẻ A gánh) + cardId A 0,5 bị loại.
    // Tính tay: totalPrev = 3 + 2 = 5tr (Sổ chi phí 6,5tr); adsTotalPrev = 0 (Sổ chi phí 1tr).
    const ctx: NguCanhLoc = { mocM: M, gan: [{ cardId: theA, nenTang: "META", tuNgay: M }], viAds: [] };
    const T12 = { from: vn("2026-12-01"), to: vn("2026-12-30") };
    const s = await getExpenseSummary(T12, { chiTienThat: ctx });
    expect(s.total).toBe(0);
    expect(s.totalPrev).toBe(5_000_000);
    expect(s.adsTotalPrev).toBe(0);
    const so = await getExpenseSummary(T12);
    expect(so.totalPrev).toBe(6_500_000);
    expect(so.adsTotalPrev).toBe(1_000_000);
  });

  it("chiTienThat với công tắc tắt ⇒ bằng đúng chế độ không opts", async () => {
    const ctx: NguCanhLoc = { mocM: null, gan: [{ cardId: theA, nenTang: "META", tuNgay: M }], viAds: [] };
    expect(await getExpenseSummary(T11, { chiTienThat: ctx })).toEqual(await getExpenseSummary(T11));
  });
});
