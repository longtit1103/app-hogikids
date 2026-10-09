import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Cửa sổ ngày theo NEO ĐẦU TIÊN của thẻ (spec §5.8) trên DB thật. M = 01/11/2026, hôm nay 26/11/2026.
 *
 * Phản ví dụ của review: thẻ thêm SAU bật có neo `soDu = 0` ngày 25/11. Dư nợ (`duNo`) chỉ đếm giao dịch
 * `> 25/11`, còn quỹ đã loại khoản chi trừ thẻ / nạp ví bằng thẻ ⇒ một khoản ngày ≤ 25/11 rơi khỏi CẢ quỹ
 * lẫn nợ (và `CARD_PAY` ngày đó trừ quỹ mà không giảm nợ). Mọi giao dịch gắn thẻ ngày ≤ neo ⇒ từ chối ô
 * ngày, mã `TRUOC_NGAY_NEO_THE`, trên cả ba đường ghi (chi phí, dòng tiền, khôi phục thùng rác).
 */
vi.mock("@/lib/quyen/nguoi-dung-phien", async (goc) => ({
  ...(await goc<typeof import("@/lib/quyen/nguoi-dung-phien")>()),
  docNguoiDungPhien: vi.fn(),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { createCashMovement, deleteCashMovement } from "@/lib/actions/cash-movements";
import { createExpense, deleteExpense, updateExpense } from "@/lib/actions/expenses";
import { taoThe } from "@/lib/actions/the-tin-dung";
import { KEY_NO_PHAI_TRA_TU_NGAY } from "@/lib/no-phai-tra/cong-bat-no-phai-tra";
import { uocTinhDuNoTai } from "@/lib/no-phai-tra/uoc-tinh-du-no-tai";
import { prisma } from "@/lib/prisma";
import { docNguoiDungPhien } from "@/lib/quyen/nguoi-dung-phien";
import { khoiPhucBanGhiDaXoa } from "@/lib/thung-rac/khoi-phuc-ban-ghi";

import { nguoiDungGia } from "../../helpers/nguoi-dung-gia";
import { seedReference, truncateBusinessTables } from "../../helpers/test-db";

const vn = (ngay: string, gio = "00:00:00") => new Date(`${ngay}T${gio}+07:00`);
const tr = (n: number) => Math.round(n * 1_000_000);
const CHU = nguoiDungGia();
const CAU_NEO = "Thẻ Visa mới chỉ theo dõi từ sau 25/11/2026 (ngày neo)";

async function batM() {
  await prisma.setting.deleteMany({ where: { key: KEY_NO_PHAI_TRA_TU_NGAY } });
  await prisma.setting.create({ data: { key: KEY_NO_PHAI_TRA_TU_NGAY, value: "2026-11-01" } });
}

/** Thẻ thêm SAU bật qua action thật — neo 25/11 `soDu = 0` (mặc định form = hôm qua). */
async function theThemSauBat(): Promise<string> {
  const r = await taoThe({
    ten: "Visa mới",
    ngayChotSaoKe: 25,
    ngayHanTra: 10,
    neoBanDau: { ngayChot: "2026-11-25", soDu: 0 },
  });
  expect(r.ok).toBe(true);
  return (r as { data: { id: string } }).data.id;
}

const chiTruThe = (cardId: string | null, ngay: string) => ({
  date: vn(ngay),
  categoryId: "other",
  amount: 300_000,
  description: "Phí thẻ",
  channelId: null,
  cardId,
});

const mucThungRac = (bang: string) => prisma.banGhiDaXoa.findFirstOrThrow({ where: { bang }, orderBy: { xoaLuc: "desc" } });

beforeAll(async () => {
  await seedReference();
}, 60_000);

beforeEach(async () => {
  await truncateBusinessTables();
  await batM();
  vi.mocked(docNguoiDungPhien).mockResolvedValue(CHU);
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(vn("2026-11-26", "10:00:00"));
});

afterEach(async () => {
  vi.useRealTimers();
  await prisma.setting.deleteMany({ where: { key: KEY_NO_PHAI_TRA_TU_NGAY } });
});

afterAll(async () => {
  await truncateBusinessTables();
  await prisma.$disconnect();
});

describe("giao dịch gắn thẻ phải SAU ngày neo đầu tiên của thẻ", () => {
  it("chi phí trừ thẻ 20/11 (neo 25/11) ⇒ từ chối ô ngày; đúng ngày neo cũng từ chối; 26/11 ⇒ ghi + vào nợ", async () => {
    const cardId = await theThemSauBat();
    for (const ngay of ["2026-11-20", "2026-11-25"]) {
      expect(await createExpense(chiTruThe(cardId, ngay))).toEqual({
        ok: false,
        field: "date",
        code: "TRUOC_NGAY_NEO_THE",
        error: CAU_NEO,
      });
    }
    expect(await prisma.expense.count()).toBe(0);
    expect(await uocTinhDuNoTai(cardId, "2026-11-26")).toBe(0);

    expect(await createExpense(chiTruThe(cardId, "2026-11-26"))).toEqual({ ok: true, data: undefined });
    expect(await uocTinhDuNoTai(cardId, "2026-11-26")).toBe(300_000);
  });

  it("sửa khoản chi KHÔNG thẻ ngày 20/11 sang trừ thẻ ⇒ từ chối, dòng giữ nguyên (vẫn trừ quỹ)", async () => {
    const cardId = await theThemSauBat();
    expect(await createExpense(chiTruThe(null, "2026-11-20"))).toEqual({ ok: true, data: undefined });
    const dong = await prisma.expense.findFirstOrThrow();
    expect(await updateExpense(dong.id, chiTruThe(cardId, "2026-11-20"))).toMatchObject({
      ok: false,
      code: "TRUOC_NGAY_NEO_THE",
    });
    expect((await prisma.expense.findUniqueOrThrow({ where: { id: dong.id } })).cardId).toBeNull();
  });

  it("ADS_TOPUP nạp bằng thẻ 20/11 ⇒ từ chối (ví +1tr từ hư không); 26/11 ⇒ ghi, nợ thẻ +1tr", async () => {
    const cardId = await theThemSauBat();
    const viAdsId = (
      await prisma.viAdsTraTruoc.create({ data: { nenTang: "SHOPEE_ADS", soDuNeo: 0, ngayNeo: vn("2026-11-05", "23:59:59") } })
    ).id;
    const nap = (ngay: string) => ({ date: vn(ngay), kind: "ADS_TOPUP", amount: tr(1), description: "", viAdsId, cardId });
    expect(await createCashMovement(nap("2026-11-20"))).toMatchObject({
      ok: false,
      field: "date",
      code: "TRUOC_NGAY_NEO_THE",
    });
    expect(await prisma.cashMovement.count()).toBe(0);
    expect(await createCashMovement(nap("2026-11-26"))).toEqual({ ok: true, data: undefined });
    expect(await uocTinhDuNoTai(cardId, "2026-11-26")).toBe(tr(1));
  });

  it("CARD_PAY 21/11 ⇒ từ chối (quỹ −500k mà nợ không giảm); 26/11 ⇒ ghi, nợ giảm đúng", async () => {
    const cardId = await theThemSauBat();
    const tra = (ngay: string) => ({ date: vn(ngay), kind: "CARD_PAY", amount: 500_000, description: "", cardId });
    expect(await createCashMovement(tra("2026-11-21"))).toEqual({
      ok: false,
      field: "date",
      code: "TRUOC_NGAY_NEO_THE",
      error: CAU_NEO,
    });
    expect(await prisma.cashMovement.count()).toBe(0);
    expect(await createCashMovement(tra("2026-11-26"))).toEqual({ ok: true, data: undefined });
    expect(await uocTinhDuNoTai(cardId, "2026-11-26")).toBe(-500_000);
  });

  it("thẻ của bước bật (neo M−1) ⇒ mọi ngày ≥ M vẫn ghi được (không đổi hành vi cũ)", async () => {
    const cardId = (await prisma.theTinDung.create({ data: { ten: "Thẻ B", ngayChotSaoKe: 25, ngayHanTra: 10 } })).id;
    await prisma.kySaoKeThe.create({ data: { cardId, ngayChot: vn("2026-10-31"), soDu: 0, laNeoMoSo: true } });
    expect(await createExpense(chiTruThe(cardId, "2026-11-01"))).toEqual({ ok: true, data: undefined });
    expect(
      await createCashMovement({ date: vn("2026-11-01"), kind: "CARD_PAY", amount: 1, description: "", cardId }),
    ).toEqual({ ok: true, data: undefined });
  });

  it("thẻ không có neo nào (dữ liệu hỏng) ⇒ từ chối, không ghi", async () => {
    const cardId = (await prisma.theTinDung.create({ data: { ten: "Thẻ trơn", ngayChotSaoKe: 25, ngayHanTra: 10 } })).id;
    expect(await createExpense(chiTruThe(cardId, "2026-11-26"))).toMatchObject({ ok: false, code: "TRUOC_NGAY_NEO_THE" });
    expect(await prisma.expense.count()).toBe(0);
  });
});

describe("khôi phục thùng rác cùng cửa sổ neo thẻ", () => {
  it("khoản chi trừ thẻ ngày 20/11 (lọt vào trước khi vá) ⇒ khôi phục bị từ chối, nêu ngày neo", async () => {
    const cardId = await theThemSauBat();
    const dong = await prisma.expense.create({ data: { ...chiTruThe(cardId, "2026-11-20"), source: "MANUAL" } });
    expect(await deleteExpense(dong.id, "only")).toEqual({ ok: true, data: undefined });
    const r = await khoiPhucBanGhiDaXoa((await mucThungRac("Expense")).id, CHU);
    expect(r).toEqual({ ok: false, lyDo: CAU_NEO });
    expect(await prisma.expense.count()).toBe(0);
  });

  it("CARD_PAY ngày 21/11 trong thùng rác ⇒ khôi phục bị từ chối", async () => {
    const cardId = await theThemSauBat();
    const dong = await prisma.cashMovement.create({
      data: { date: vn("2026-11-21"), kind: "CARD_PAY", amount: 500_000, description: "", cardId },
    });
    expect(await deleteCashMovement(dong.id)).toEqual({ ok: true, data: undefined });
    expect(await khoiPhucBanGhiDaXoa((await mucThungRac("CashMovement")).id, CHU)).toEqual({ ok: false, lyDo: CAU_NEO });
    expect(await prisma.cashMovement.count()).toBe(0);
  });
});
