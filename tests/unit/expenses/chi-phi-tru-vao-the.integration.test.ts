import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * "Trừ vào thẻ" (`Expense.cardId`, spec §5.6) trên DB thật. M = 01/11/2026, hôm nay ghim 26/11/2026.
 * Luật: chỉ khoản chi NHẬP TAY, ngày ≥ M, thẻ còn mở, KHÔNG cho danh mục quảng cáo (ads trả thẻ đi theo
 * nền tảng gắn thẻ); gắn/gỡ/đổi/xoá đều khoá thẻ cũ lẫn mới.
 */
vi.mock("@/lib/quyen/nguoi-dung-phien", async (goc) => ({
  ...(await goc<typeof import("@/lib/quyen/nguoi-dung-phien")>()),
  docNguoiDungPhien: vi.fn(),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { createExpense, deleteExpense, updateExpense } from "@/lib/actions/expenses";
import { getExpensesPage } from "@/lib/expenses/expense-queries";
import { KEY_NO_PHAI_TRA_TU_NGAY } from "@/lib/no-phai-tra/cong-bat-no-phai-tra";
import { khoaThe } from "@/lib/no-phai-tra/the-tin-dung-queries";
import { prisma } from "@/lib/prisma";
import { docNguoiDungPhien } from "@/lib/quyen/nguoi-dung-phien";

import { nguoiDungGia } from "../../helpers/nguoi-dung-gia";
import { seedReference, truncateBusinessTables } from "../../helpers/test-db";

const vn = (ngay: string, gio = "00:00:00") => new Date(`${ngay}T${gio}+07:00`);

async function batM() {
  await prisma.setting.deleteMany({ where: { key: KEY_NO_PHAI_TRA_TU_NGAY } });
  await prisma.setting.create({ data: { key: KEY_NO_PHAI_TRA_TU_NGAY, value: "2026-11-01" } });
}

/** Thẻ của bước bật: neo mở sổ tại M−1 (31/10) ⇒ mọi ngày ≥ M qua cửa sổ neo đầu tiên. */
async function taoThe(ten = "Thẻ A", ngayNeo = "2026-10-31"): Promise<string> {
  const the = await prisma.theTinDung.create({ data: { ten, ngayChotSaoKe: 25, ngayHanTra: 10 } });
  await prisma.kySaoKeThe.create({ data: { cardId: the.id, ngayChot: vn(ngayNeo), soDu: 0, laNeoMoSo: true } });
  return the.id;
}

const chi = (p: Record<string, unknown> = {}) => ({
  date: vn("2026-11-20"),
  categoryId: "other",
  amount: 300_000,
  description: "Phí thường niên thẻ",
  channelId: null,
  ...p,
});

beforeAll(async () => {
  await seedReference();
}, 60_000);

beforeEach(async () => {
  await truncateBusinessTables();
  await prisma.setting.deleteMany({ where: { key: KEY_NO_PHAI_TRA_TU_NGAY } });
  vi.mocked(docNguoiDungPhien).mockResolvedValue(nguoiDungGia());
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

describe("tạo khoản chi trừ vào thẻ", () => {
  it("danh mục quảng cáo + thẻ ⇒ từ chối ô thẻ (kể cả sau khi bật)", async () => {
    await batM();
    const cardId = await taoThe();
    const res = await createExpense(chi({ categoryId: "ads", adsSource: "META", cardId }));
    expect(res).toMatchObject({ ok: false, field: "cardId" });
    expect(await prisma.expense.count()).toBe(0);
  });

  it("chi khác + thẻ, MANUAL, ngày ≥ M ⇒ ghi kèm cardId", async () => {
    await batM();
    const cardId = await taoThe();
    expect(await createExpense(chi({ cardId }))).toEqual({ ok: true, data: undefined });
    expect(await prisma.expense.findFirstOrThrow()).toMatchObject({ cardId, source: "MANUAL" });
  });

  it("danh sách Sổ chi phí trả về cardId + tên thẻ (form sửa điền sẵn, bảng hiện nhãn); dòng không thẻ ⇒ null", async () => {
    await batM();
    const cardId = await taoThe("Visa VCB");
    expect(await createExpense(chi({ cardId }))).toEqual({ ok: true, data: undefined });
    expect(await createExpense(chi({ description: "Không thẻ", amount: 100_000 }))).toEqual({ ok: true, data: undefined });
    const { rows } = await getExpensesPage({
      range: { from: vn("2026-11-01"), to: vn("2026-11-30") },
      sort: "amount_desc",
      page: 1,
    });
    expect(rows.map((r) => ({ cardId: r.cardId, tenThe: r.tenThe }))).toEqual([
      { cardId, tenThe: "Visa VCB" },
      { cardId: null, tenThe: null },
    ]);
  });

  it("chưa bật ⇒ CHUA_BAT_NO_PHAI_TRA; ngày < M ⇒ từ chối ô ngày; không thẻ thì như cũ", async () => {
    const cardId = await taoThe();
    expect(await createExpense(chi({ cardId }))).toMatchObject({ ok: false, code: "CHUA_BAT_NO_PHAI_TRA" });
    await batM();
    expect(await createExpense(chi({ cardId, date: vn("2026-10-31") }))).toMatchObject({ ok: false, field: "date" });
    expect(await prisma.expense.count()).toBe(0);
    expect(await createExpense(chi({ date: vn("2026-10-31") }))).toEqual({ ok: true, data: undefined });
  });

  it("lặp hàng tháng + thẻ ⇒ zod; dòng RECURRING mang thẻ ⇒ CHECK Expense_card_chi_manual", async () => {
    await batM();
    const cardId = await taoThe();
    expect(await createExpense(chi({ cardId, recurringMonthly: true }))).toMatchObject({ ok: false, field: "cardId" });
    await expect(
      prisma.expense.create({ data: { ...chi({ cardId }), source: "RECURRING" } as never }),
    ).rejects.toThrow(/Expense_card_chi_manual/);
  });

  it("thẻ đã đóng ⇒ THE_DA_DONG", async () => {
    await batM();
    const cardId = await taoThe();
    await prisma.theTinDung.update({ where: { id: cardId }, data: { closedAt: vn("2026-11-20") } });
    expect(await createExpense(chi({ cardId }))).toMatchObject({ ok: false, code: "THE_DA_DONG" });
  });
});

describe("sửa / xoá khoản chi trừ vào thẻ", () => {
  it("form không gửi ô thẻ ⇒ GIỮ thẻ; gửi null ⇒ gỡ thẻ; đổi sang ads khi đang giữ thẻ ⇒ từ chối", async () => {
    await batM();
    const cardId = await taoThe();
    await createExpense(chi({ cardId }));
    const e = await prisma.expense.findFirstOrThrow();
    const khongThe = chi({ amount: 400_000 }); // không có khoá cardId = form cũ
    expect(await updateExpense(e.id, khongThe)).toEqual({ ok: true, data: undefined });
    expect(await prisma.expense.findUniqueOrThrow({ where: { id: e.id } })).toMatchObject({ cardId, amount: 400_000 });
    expect(await updateExpense(e.id, { ...khongThe, categoryId: "ads", adsSource: "META" })).toMatchObject({
      ok: false,
      field: "cardId",
    });
    expect(await updateExpense(e.id, { ...khongThe, cardId: null })).toEqual({ ok: true, data: undefined });
    expect((await prisma.expense.findUniqueOrThrow({ where: { id: e.id } })).cardId).toBeNull();
  });

  it("chuyển A → B khoá CẢ thẻ cũ: lượt đóng A đang giữ khoá ⇒ chờ rồi thấy A đã đóng, dòng giữ A", async () => {
    await batM();
    const a = await taoThe("Thẻ A");
    const b = await taoThe("Thẻ B");
    await createExpense(chi({ cardId: a }));
    const e = await prisma.expense.findFirstOrThrow();

    let tha!: () => void;
    const cho = new Promise<void>((res) => (tha = res));
    let daGiu!: () => void;
    const giuXong = new Promise<void>((res) => (daGiu = res));
    const giu = prisma.$transaction(
      async (tx) => {
        await khoaThe(tx, a);
        await tx.theTinDung.update({ where: { id: a }, data: { closedAt: vn("2026-11-26") } });
        daGiu();
        await cho;
      },
      { timeout: 20_000 },
    );
    await giuXong;
    const t0 = performance.now();
    const p = updateExpense(e.id, chi({ cardId: b })).then((r) => ({ r, ms: performance.now() - t0 }));
    await new Promise((res) => setTimeout(res, 800));
    tha();
    await giu;
    const { r, ms } = await p;
    expect(ms).toBeGreaterThan(600);
    expect(r).toMatchObject({ ok: false, code: "THE_DA_DONG" });
    expect((await prisma.expense.findUniqueOrThrow({ where: { id: e.id } })).cardId).toBe(a);
  });

  it("dòng IMPORT không gắn thẻ được; xoá khoản chi của thẻ đã đóng ⇒ từ chối", async () => {
    await batM();
    const cardId = await taoThe();
    const imp = await prisma.expense.create({
      data: { date: vn("2026-11-20"), categoryId: "other", amount: 1, description: "", source: "IMPORT" },
    });
    expect(await updateExpense(imp.id, chi({ cardId }))).toMatchObject({ ok: false, field: "cardId" });
    await createExpense(chi({ cardId }));
    const e = await prisma.expense.findFirstOrThrow({ where: { cardId } });
    await prisma.theTinDung.update({ where: { id: cardId }, data: { closedAt: vn("2026-11-25") } });
    expect(await deleteExpense(e.id, "only")).toMatchObject({ ok: false, code: "THE_DA_DONG" });
    expect(await prisma.expense.count({ where: { id: e.id } })).toBe(1);
  });
});

describe("quyền gắn thẻ: ngoài chi-phi:sua còn đòi tai-chinh-so-quy:sua", () => {
  const nhanSu = (...q: string[]) => nguoiDungGia({ role: "STAFF", quyen: new Set(q) as never });

  it("chỉ chi-phi:sua ⇒ tạo khoản chi gắn thẻ bị từ chối, câu lỗi KHÔNG lộ tên thẻ; không thẻ ⇒ như cũ", async () => {
    await batM();
    const cardId = await taoThe("Thẻ Bí Mật");
    // Thẻ đóng: nếu cổng thẻ chạy trước cổng quyền, câu "Thẻ Bí Mật đã đóng" sẽ lộ tên.
    await prisma.theTinDung.update({ where: { id: cardId }, data: { closedAt: vn("2026-11-20") } });
    vi.mocked(docNguoiDungPhien).mockResolvedValue(nhanSu("chi-phi:sua"));
    const res = await createExpense(chi({ cardId }));
    expect(res).toMatchObject({ ok: false, code: "KHONG_CO_QUYEN" });
    expect(JSON.stringify(res)).not.toContain("Bí Mật");
    expect(await prisma.expense.count()).toBe(0);
    expect(await createExpense(chi())).toEqual({ ok: true, data: undefined });

    vi.mocked(docNguoiDungPhien).mockResolvedValue(nhanSu("chi-phi:sua", "tai-chinh-so-quy:sua"));
    await prisma.theTinDung.update({ where: { id: cardId }, data: { closedAt: null } });
    expect(await createExpense(chi({ cardId }))).toEqual({ ok: true, data: undefined });
  });

  it("chỉ chi-phi:sua ⇒ sửa số khoản chi đang trừ thẻ (không gửi ô thẻ) được; gỡ/đổi thẻ ⇒ từ chối", async () => {
    await batM();
    const a = await taoThe("Thẻ A");
    const b = await taoThe("Thẻ B");
    expect(await createExpense(chi({ cardId: a }))).toEqual({ ok: true, data: undefined });
    const e = await prisma.expense.findFirstOrThrow();
    vi.mocked(docNguoiDungPhien).mockResolvedValue(nhanSu("chi-phi:sua"));
    // `chi()` không mang khoá `cardId` ⇒ form cũ / form không hiện ô thẻ: giữ thẻ đang có.
    expect(await updateExpense(e.id, chi({ amount: 350_000 }))).toEqual({ ok: true, data: undefined });
    expect(await updateExpense(e.id, chi({ cardId: null }))).toMatchObject({ ok: false, code: "KHONG_CO_QUYEN" });
    expect(await updateExpense(e.id, chi({ cardId: b }))).toMatchObject({ ok: false, code: "KHONG_CO_QUYEN" });
    expect(await prisma.expense.findUniqueOrThrow({ where: { id: e.id } })).toMatchObject({ cardId: a, amount: 350_000 });
  });
});
