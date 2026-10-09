import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { getCashMovementSummary } from "@/lib/cash-movements/cash-movement-queries";
import { prisma } from "@/lib/prisma";
import { docSoQuyDongChay } from "@/lib/so-quy/dong-chay-so-quy-queries";
import { docTongNguon, tinhSoQuyThang } from "@/lib/so-quy/so-quy-queries";
import { buildSoQuySheetRows } from "@/lib/so-quy/xuat-excel-so-quy";

import { seedReference, truncateBusinessTables } from "../../helpers/test-db";

/**
 * Luật `ADS_TOPUP` theo `cardId` trên DB thật (`hogikids_test`) — ở CẢ BA đường đọc `CashMovement`
 * nhóm/đọc theo `cardId`: tổng thẻ Quỹ (`docTongNguon`), dòng chạy (`docSuKien`), tổng tab Dòng tiền
 * (`getCashMovementSummary`). Nạp ví ads TỪ NGÂN HÀNG (không `cardId`) là tiền rời quỹ ⇒ nguồn
 * `napViTuBank`; nạp BẰNG THẺ (có `cardId`) không chạm quỹ (tiền ra khỏi quỹ lúc trả thẻ, không phải
 * lúc nạp) ⇒ bị LOẠI hẳn, không thành dòng số 0. Coi thẻ như ngân hàng là quỹ bị trừ hai lần.
 *
 * Fixture: mở sổ 15/09 (góp vốn 50tr), T10 có nạp ngân hàng 10tr + nạp thẻ 7tr ⇒ T10 chi đúng 10tr.
 */

const vn = (iso: string) => new Date(`${iso}+07:00`);

const T10 = { from: vn("2026-10-01T00:00:00"), to: vn("2026-10-31T00:00:00") };
const D0 = vn("2026-09-15T00:00:00");

const GOP_VON = 50_000_000;
const NAP_BANK = 10_000_000;
const NAP_THE = 7_000_000;

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

async function seed(): Promise<{ idBank: string; idThe: string }> {
  const vi = await prisma.viAdsTraTruoc.create({
    data: { nenTang: "META", soDuNeo: 0, ngayNeo: vn("2026-09-30T00:00:00") },
  });
  const the = await prisma.theTinDung.create({
    data: { ten: "Thẻ test", ngayChotSaoKe: 20, ngayHanTra: 5 },
  });
  await prisma.cashMovement.create({
    data: { date: vn("2026-09-15T10:00:00"), kind: "CAPITAL_IN", amount: GOP_VON, description: "Mở sổ" },
  });
  const bank = await prisma.cashMovement.create({
    data: {
      date: vn("2026-10-05T09:00:00"),
      kind: "ADS_TOPUP",
      amount: NAP_BANK,
      description: "Nạp ví Meta từ ngân hàng",
      viAdsId: vi.id,
    },
  });
  const theRow = await prisma.cashMovement.create({
    data: {
      date: vn("2026-10-06T09:00:00"),
      kind: "ADS_TOPUP",
      amount: NAP_THE,
      description: "Nạp ví Meta bằng thẻ",
      viAdsId: vi.id,
      cardId: the.id,
    },
  });
  return { idBank: bank.id, idThe: theRow.id };
}

describe("ADS_TOPUP theo cardId — thẻ Quỹ = dòng chạy = Excel = tab Dòng tiền", () => {
  it("docTongNguon: chỉ nạp ngân hàng vào napViTuBank, nạp thẻ không vào nguồn nào", async () => {
    await seed();
    const t = await docTongNguon(T10.from, T10.to);
    expect(t.napViTuBank).toBe(NAP_BANK);
    expect(t.ghiTayVao).toBe(0);
    expect(t.ghiTayRa).toBe(0);
  });

  it("tinhSoQuyThang: T10 chi = 10tr (không 17tr), cuối kỳ = 40tr", async () => {
    await seed();
    const the = await tinhSoQuyThang(T10);
    expect(the.d0).toEqual(D0);
    expect(the.dauKy).toBe(GOP_VON);
    expect(the.thu).toBe(0);
    expect(the.chi).toBe(NAP_BANK);
    expect(the.cuoiKy).toBe(GOP_VON - NAP_BANK);
  });

  it("dòng chạy: dòng nạp bằng thẻ bị LOẠI (không thành dòng số 0), dòng ngân hàng chi 10tr", async () => {
    const { idBank, idThe } = await seed();
    const r = await docSoQuyDongChay(T10);
    if (r.trangThai !== "CO_SO") throw new Error(`Kỳ T10 phải có sổ, nhận ${r.trangThai}`);

    expect(r.dong.map((d) => d.key)).toEqual([`GHI_TAY:${idBank}`]);
    expect(r.dong.some((d) => d.key === `GHI_TAY:${idThe}`)).toBe(false);
    expect(r.dong[0]).toMatchObject({ nguon: "GHI_TAY", thu: 0, chi: NAP_BANK });
    expect(r.tongChi).toBe(NAP_BANK);
    expect(r.tongThu).toBe(0);
    expect(r.cuoiKy).toBe(r.the.cuoiKy);
    expect(r.lechDoiChieu).toBeNull();

    // Excel dựng từ chính dòng chạy ⇒ cùng số: 1 dòng chi + Tổng chi 10tr + cuối kỳ 40tr.
    const rows = buildSoQuySheetRows(r, false);
    const dongGiua = rows.slice(1, -2);
    expect(dongGiua).toHaveLength(1);
    expect(dongGiua[0].Chi).toBe(NAP_BANK);
    expect(rows.at(-2)).toMatchObject({ "Diễn giải": "Tổng", Thu: 0, Chi: NAP_BANK });
    expect(rows.at(-1)!["Số dư"]).toBe(GOP_VON - NAP_BANK);
  });

  it("getCashMovementSummary (tab Dòng tiền): OUT = 10tr, ADS_TOPUP chỉ mang phần ngân hàng", async () => {
    await seed();
    const s = await getCashMovementSummary(T10);
    expect(s.inTotal).toBe(0);
    expect(s.outTotal).toBe(NAP_BANK);
    expect(s.byKind).toEqual([
      expect.objectContaining({ kind: "ADS_TOPUP", direction: "OUT", amount: NAP_BANK }),
    ]);
  });
});
