import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { KEY_NO_PHAI_TRA_TU_NGAY } from "@/lib/no-phai-tra/cong-bat-no-phai-tra";
import { docNguCanhLoc } from "@/lib/no-phai-tra/doc-ngu-canh-loc";
import { prisma } from "@/lib/prisma";
import { computeCashFlow } from "@/lib/reports/cash-flow";
import { docSoQuyDongChay } from "@/lib/so-quy/dong-chay-so-quy-queries";
import { docDuBaoQuy } from "@/lib/so-quy/du-bao-quy-queries";
import { tinhSoQuyThang } from "@/lib/so-quy/so-quy-queries";
import { buildSoQuySheetRows } from "@/lib/so-quy/xuat-excel-so-quy";

import { seedReference, truncateBusinessTables } from "../../helpers/test-db";

/**
 * KỲ VỌNG TÍNH TAY — fixture spec §6 (phần QUỸ), M = 01/11/2026, đơn vị triệu (tr). Số dưới đây tính bằng
 * tay từ bảng §6, KHÔNG chép từ output.
 *
 * Mở sổ 12/05 góp vốn 150 ⇒ quỹ 31/10 = 150. Thẻ A gánh META, thẻ B gánh TIKTOK_ADS từ 01/11.
 *   THU T11: CUTOVER_ADJ_IN 9 ("nợ thẻ A") + 6 ("nợ thẻ B") ngày 01/11 · SUPPLIER_REFUND 3 (#1) 30/11
 *            = 18.
 *   CHI T11: SUPPLIER_PAY 10 (#2, 05/11) + 23 (#1) + 27 (#2) ngày 20/11 · CARD_PAY A 7 (08/11) + 2 (25/11)
 *            + 1 (26/11) = 70.
 *   KHÔNG chạm quỹ: ads META 1 + 2 + 1 = 4 (thẻ A gánh) · ads TikTok 30 (thẻ B) · ví TikTok trừ 18 (sau
 *            T_TIKTOK_ADS ⇒ không cộng lại) · phí thẻ A 0,4 ngày 02/12 (`cardId` ⇒ nợ thẻ, không quỹ).
 *   ⇒ T11: đầu kỳ 150 · thu 18 · chi 70 · cuối kỳ 150 + 18 − 70 = 98. 01/12–02/12: đầu 98, thu 0, chi 0, cuối 98.
 *   Tab Dòng tiền T11: phần Expense (`cashOut`) = 0 (mọi chi phí T11 đều thẻ gánh); khoản khác ra = 70,
 *   vào = 18 — đúng bằng Σchi/Σthu của thẻ Quỹ.
 */
const vn = (iso: string) => new Date(`${iso}+07:00`);
const TR = 1_000_000;
const T11 = { from: vn("2026-11-01T00:00:00"), to: vn("2026-11-30T00:00:00") };
const DAU_T12 = { from: vn("2026-12-01T00:00:00"), to: vn("2026-12-02T00:00:00") };

beforeAll(async () => {
  await seedReference();
}, 60_000);

beforeEach(async () => {
  await truncateBusinessTables();
  await prisma.setting.deleteMany({ where: { key: KEY_NO_PHAI_TRA_TU_NGAY } });
  await seed();
});

afterEach(() => {
  vi.useRealTimers();
});

afterAll(async () => {
  await truncateBusinessTables();
  await prisma.setting.deleteMany({ where: { key: KEY_NO_PHAI_TRA_TU_NGAY } });
  await prisma.$disconnect();
});

async function seed(): Promise<void> {
  const theA = await prisma.theTinDung.create({ data: { ten: "Thẻ A", ngayChotSaoKe: 25, ngayHanTra: 10 } });
  const theB = await prisma.theTinDung.create({ data: { ten: "Thẻ B", ngayChotSaoKe: 25, ngayHanTra: 10 } });
  const M = vn("2026-11-01T00:00:00");
  await prisma.ganNenTangThe.createMany({
    data: [
      { cardId: theA.id, nenTang: "META", tuNgay: M },
      { cardId: theB.id, nenTang: "TIKTOK_ADS", tuNgay: M },
    ],
  });
  await prisma.setting.create({ data: { key: KEY_NO_PHAI_TRA_TU_NGAY, value: "2026-11-01" } });
  const p1 = await prisma.phieuNhapNo.create({
    data: { refId: "pn-1", shopId: "714995134", maPhieu: "#1", ngayPhieu: vn("2026-10-15T00:00:00"), tongTien: 20 * TR },
  });
  const p2 = await prisma.phieuNhapNo.create({
    data: { refId: "pn-2", shopId: "714995134", maPhieu: "#2", ngayPhieu: vn("2026-11-05T00:00:00"), tongTien: 100 * TR },
  });

  await prisma.cashMovement.createMany({
    data: [
      { date: vn("2026-05-12T09:00:00"), kind: "CAPITAL_IN", amount: 150 * TR, description: "Mở sổ" },
      { date: M, kind: "CUTOVER_ADJ_IN", amount: 9 * TR, description: "nợ thẻ A" },
      { date: M, kind: "CUTOVER_ADJ_IN", amount: 6 * TR, description: "nợ thẻ B" },
      { date: vn("2026-11-05T10:00:00"), kind: "SUPPLIER_PAY", amount: 10 * TR, phieuNhapId: p2.id },
      { date: vn("2026-11-20T10:00:00"), kind: "SUPPLIER_PAY", amount: 23 * TR, phieuNhapId: p1.id },
      { date: vn("2026-11-20T10:00:00"), kind: "SUPPLIER_PAY", amount: 27 * TR, phieuNhapId: p2.id },
      { date: vn("2026-11-08T10:00:00"), kind: "CARD_PAY", amount: 7 * TR, cardId: theA.id },
      { date: vn("2026-11-25T10:00:00"), kind: "CARD_PAY", amount: 2 * TR, cardId: theA.id },
      { date: vn("2026-11-26T10:00:00"), kind: "CARD_PAY", amount: 1 * TR, cardId: theA.id },
      { date: vn("2026-11-30T10:00:00"), kind: "SUPPLIER_REFUND", amount: 3 * TR, phieuNhapId: p1.id },
    ],
  });

  const ads = (ngay: string, nenTang: string, amount: number) => ({
    date: vn(`2026-11-${ngay}T00:00:00`),
    categoryId: "ads",
    adsSource: nenTang,
    source: "ADS_API" as const,
    amount,
    description: `${nenTang} ${ngay}/11`,
  });
  await prisma.expense.createMany({
    data: [
      // Meta: 1 (02/11) + 2 rải 03–24/11 (4 × 0,5) + 1 (25/11) = 4.
      ads("02", "META", 1 * TR),
      ...["03", "10", "17", "24"].map((d) => ads(d, "META", TR / 2)),
      ads("25", "META", 1 * TR),
      // TikTok: 30 rải 01–25/11 (5 × 6).
      ...["01", "07", "13", "19", "25"].map((d) => ads(d, "TIKTOK_ADS", 6 * TR)),
      // Phí thẻ A 0,4 "trừ vào thẻ A" ngày 02/12.
      {
        date: vn("2026-12-02T00:00:00"),
        categoryId: "other",
        source: "MANUAL" as const,
        amount: 400_000,
        description: "Phí thẻ A",
        cardId: theA.id,
      },
    ],
  });
  // Ví TikTok sàn trừ ads 18 (3 × 6) trong 01–25/11 — sau T_TIKTOK_ADS ⇒ KHÔNG cộng lại quỹ.
  await prisma.tiktokAdsSettlement.createMany({
    data: ["01T10:00:00", "12T10:00:00", "25T10:00:00"].map((g, i) => ({
      transactionId: `vi-${i}`,
      shopId: "100975192",
      orderCreateTime: vn(`2026-11-${g}`),
      settlementAmount: -6 * TR,
    })),
  });
}

describe("tính tay fixture §6 — phần QUỸ (M = 01/11)", () => {
  it("thẻ Quỹ T11: đầu 150 · thu 18 · chi 70 · cuối 98", async () => {
    const the = await tinhSoQuyThang(T11, await docNguCanhLoc());
    expect(the.d0).toEqual(vn("2026-05-12T00:00:00"));
    expect(the.dauKy).toBe(150 * TR);
    expect(the.thu).toBe(18 * TR);
    expect(the.chi).toBe(70 * TR);
    expect(the.cuoiKy).toBe(98 * TR);
    expect(the.dauKy + the.thu - the.chi).toBe(the.cuoiKy);
  });

  it("tới 02/12: quỹ vẫn 98 (phí thẻ 0,4 vào nợ thẻ, không vào quỹ)", async () => {
    const the = await tinhSoQuyThang(DAU_T12, await docNguCanhLoc());
    expect(the.dauKy).toBe(98 * TR);
    expect(the.thu).toBe(0);
    expect(the.chi).toBe(0);
    expect(the.cuoiKy).toBe(98 * TR);
  });

  it("dòng chạy T11 = thẻ: chỉ 9 dòng ghi tay, không dòng chi phí/ví; Excel cùng số", async () => {
    const r = await docSoQuyDongChay(T11, await docNguCanhLoc());
    if (r.trangThai !== "CO_SO") throw new Error(`mong CO_SO, nhận ${r.trangThai}`);
    expect(r.lechDoiChieu).toBeNull();
    expect(r.dong).toHaveLength(9);
    expect(r.dong.every((d) => d.nguon === "GHI_TAY")).toBe(true);
    expect(r.tongThu).toBe(18 * TR);
    expect(r.tongChi).toBe(70 * TR);
    expect(r.dauKy + r.tongThu - r.tongChi).toBe(r.cuoiKy);
    expect(r.cuoiKy).toBe(98 * TR);

    const rows = buildSoQuySheetRows(r, false);
    expect(rows.at(-2)).toMatchObject({ "Diễn giải": "Tổng", Thu: 18 * TR, Chi: 70 * TR });
    expect(rows.at(-1)!["Số dư"]).toBe(98 * TR);
    expect(rows[0]["Số dư"]).toBe(150 * TR);
  });

  it("tab Dòng tiền T11: phần Expense = 0; khoản khác ra 70, vào 18", async () => {
    const cf = await computeCashFlow(T11);
    expect(cf.cashOut).toBe(0);
    expect(cf.outBreakdown).toEqual([]);
    expect(cf.otherOut).toBe(70 * TR);
    expect(cf.otherIn).toBe(18 * TR);
  });

  it("dự báo đứng ngày 02/12: quỹ hôm nay = cuối lịch sử = 98", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(vn("2026-12-02T10:00:00"));
    const db = await docDuBaoQuy();
    if (db.trangThai !== "CO_SO") throw new Error(`mong CO_SO, nhận ${db.trangThai}`);
    expect(db.quyHomNay).toBe(98 * TR);
    expect(db.lichSu.at(-1)!.soDu).toBe(98 * TR);
  });
});
