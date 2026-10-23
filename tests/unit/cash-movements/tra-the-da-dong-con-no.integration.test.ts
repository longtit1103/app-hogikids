import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Thẻ tín dụng ĐÃ ĐÓNG còn dư nợ (ads về muộn gán thẻ đóng theo đúng lịch sử mốc gắn) trên DB thật
 * (`hogikids_test`). M = 01/11/2026, "hôm nay" ghim 26/11/2026 bằng fake timer CHỈ cho `Date`.
 *
 * Lối duy nhất tất toán: `CARD_PAY` MỚI vào thẻ đóng khi thẻ còn nợ > 0 (dư nợ tính trong transaction sau khoá thẻ).
 * KHÔNG kẹp số trả theo dư nợ ước tính — ngân hàng trừ nhiều hơn là ca thật, phần vượt thành "trả thừa". Lần trả ĐÃ
 * CÓ của thẻ đóng: xoá / sửa giảm / sửa tăng đều được (dư nợ chỉ quay về số trước đó). Mọi đường khác vào thẻ đóng
 * vẫn chặn: khoản chi trừ thẻ, gắn nền tảng.
 * Dư nợ dựng bằng neo mở sổ `soDu > 0` ghi thẳng DB (khuôn bước bật) — nguồn nợ không quan trọng với cổng.
 */
vi.mock("@/lib/quyen/nguoi-dung-phien", async (goc) => ({
  ...(await goc<typeof import("@/lib/quyen/nguoi-dung-phien")>()),
  docNguoiDungPhien: vi.fn(),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { createCashMovement, deleteCashMovement, updateCashMovement } from "@/lib/actions/cash-movements";
import { createExpense } from "@/lib/actions/expenses";
import { ganNenTang } from "@/lib/actions/the-tin-dung";
import { KEY_NO_PHAI_TRA_TU_NGAY } from "@/lib/no-phai-tra/cong-bat-no-phai-tra";
import { docDuNoCacThe } from "@/lib/no-phai-tra/du-no-the";
import { prisma } from "@/lib/prisma";
import { docNguoiDungPhien } from "@/lib/quyen/nguoi-dung-phien";

import { nguoiDungGia } from "../../helpers/nguoi-dung-gia";
import { seedReference, truncateBusinessTables } from "../../helpers/test-db";

const vn = (ngay: string, gio = "00:00:00") => new Date(`${ngay}T${gio}+07:00`);
const tr = (n: number) => Math.round(n * 1_000_000);

async function batM(ngay = "2026-11-01") {
  await prisma.setting.deleteMany({ where: { key: KEY_NO_PHAI_TRA_TU_NGAY } });
  await prisma.setting.create({ data: { key: KEY_NO_PHAI_TRA_TU_NGAY, value: ngay } });
}

/** Thẻ đã ĐÓNG ngày 25/11 với neo mở sổ 31/10 mang dư nợ `noTrieu` triệu. */
async function taoTheDong(noTrieu: number): Promise<string> {
  const id = (
    await prisma.theTinDung.create({
      data: { ten: "Thẻ cũ", ngayChotSaoKe: 25, ngayHanTra: 10, closedAt: vn("2026-11-25") },
    })
  ).id;
  await prisma.kySaoKeThe.create({
    data: { cardId: id, ngayChot: vn("2026-10-31"), soDu: tr(noTrieu), laNeoMoSo: true },
  });
  return id;
}

const traThe = (cardId: string, amount: number, date = "2026-11-26") => ({
  date: vn(date),
  kind: "CARD_PAY",
  amount,
  description: "Trả nốt thẻ cũ",
  cardId,
});

async function duNoCua(cardId: string): Promise<number | null> {
  return (await docDuNoCacThe(new Date())).find((d) => d.cardId === cardId)?.duNo ?? null;
}

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

describe("trả thẻ vào thẻ đã đóng còn nợ", () => {
  it("thẻ đóng KHÔNG còn nợ ⇒ vẫn THE_DA_DONG, không dòng nào", async () => {
    await batM();
    const cardId = await taoTheDong(0);
    expect(await createCashMovement(traThe(cardId, tr(1)))).toMatchObject({
      ok: false,
      code: "THE_DA_DONG",
      field: "cardId",
    });
    expect(await prisma.cashMovement.count()).toBe(0);
  });

  it("còn nợ 5tr: trả 3tr được; trả 3tr nữa (vượt ước tính) VẪN được ⇒ dư nợ âm; hết nợ rồi trả thêm ⇒ chặn", async () => {
    await batM();
    const cardId = await taoTheDong(5);
    expect(await duNoCua(cardId)).toBe(tr(5));

    expect(await createCashMovement(traThe(cardId, tr(3)))).toEqual({ ok: true, data: undefined });
    expect(await duNoCua(cardId)).toBe(tr(2));

    // Ngân hàng trừ nhiều hơn ước tính (phí/lãi chưa ghi): ghi đúng số thật, thẻ hiện "trả thừa".
    expect(await createCashMovement(traThe(cardId, tr(3)))).toEqual({ ok: true, data: undefined });
    expect(await duNoCua(cardId)).toBe(-tr(1));

    expect(await createCashMovement(traThe(cardId, 1_000))).toMatchObject({
      ok: false,
      code: "THE_DA_DONG",
      field: "cardId",
    });
    expect(await prisma.cashMovement.count()).toBe(2);
  });

  it("sửa lần trả của thẻ đóng: sửa mô tả / giảm / tăng vượt đều được, kể cả khi thẻ đã hết nợ", async () => {
    await batM();
    const cardId = await taoTheDong(5);
    expect(await createCashMovement(traThe(cardId, tr(5)))).toEqual({ ok: true, data: undefined });
    const dong = await prisma.cashMovement.findFirstOrThrow();
    expect(await duNoCua(cardId)).toBe(0);

    // Nợ đã 0 — vẫn sửa mô tả / giảm số được (sửa nhầm lẫn), nợ hiện lại đúng phần giảm.
    expect(await updateCashMovement(dong.id, { ...traThe(cardId, tr(5)), description: "Sửa mô tả" })).toEqual({
      ok: true,
      data: undefined,
    });
    expect(await updateCashMovement(dong.id, traThe(cardId, tr(4)))).toEqual({ ok: true, data: undefined });
    expect(await duNoCua(cardId)).toBe(tr(1));

    expect(await updateCashMovement(dong.id, traThe(cardId, tr(6)))).toEqual({ ok: true, data: undefined });
    expect((await prisma.cashMovement.findUniqueOrThrow({ where: { id: dong.id } })).amount).toBe(tr(6));
    expect(await duNoCua(cardId)).toBe(-tr(1));

    // Đang trả thừa (nợ −1tr) vẫn giảm về được.
    expect(await updateCashMovement(dong.id, traThe(cardId, tr(2)))).toEqual({ ok: true, data: undefined });
    expect(await duNoCua(cardId)).toBe(tr(3));
  });

  it("xoá lần trả của thẻ đóng ⇒ được, dư nợ tăng lại đúng số đã trả; ghi lại lần trả mới khi còn nợ vẫn được", async () => {
    await batM();
    const cardId = await taoTheDong(5);
    expect(await createCashMovement(traThe(cardId, tr(5)))).toEqual({ ok: true, data: undefined });
    expect(await duNoCua(cardId)).toBe(0);
    const dong = await prisma.cashMovement.findFirstOrThrow();

    expect(await deleteCashMovement(dong.id)).toEqual({ ok: true, data: undefined });
    expect(await prisma.cashMovement.count({ where: { id: dong.id } })).toBe(0);
    expect(await duNoCua(cardId)).toBe(tr(5));

    expect(await createCashMovement(traThe(cardId, tr(5)))).toEqual({ ok: true, data: undefined });
    expect(await duNoCua(cardId)).toBe(0);
  });

  it("chuyển lần trả của thẻ đóng sang thẻ khác ⇒ chặn, dòng giữ nguyên thẻ cũ", async () => {
    await batM();
    const cardId = await taoTheDong(5);
    const theMo = (
      await prisma.theTinDung.create({ data: { ten: "Thẻ mới", ngayChotSaoKe: 25, ngayHanTra: 10 } })
    ).id;
    await prisma.kySaoKeThe.create({ data: { cardId: theMo, ngayChot: vn("2026-10-31"), soDu: 0, laNeoMoSo: true } });
    expect(await createCashMovement(traThe(cardId, tr(2)))).toEqual({ ok: true, data: undefined });
    const dong = await prisma.cashMovement.findFirstOrThrow();

    expect(await updateCashMovement(dong.id, traThe(theMo, tr(2)))).toMatchObject({ ok: false, code: "THE_DA_DONG" });
    expect((await prisma.cashMovement.findUniqueOrThrow({ where: { id: dong.id } })).cardId).toBe(cardId);
  });

  it("thẻ đóng còn nợ vẫn KHÔNG nhận khoản chi trừ thẻ, cũng không gắn thêm nền tảng", async () => {
    await batM();
    const cardId = await taoTheDong(5);
    const chi = { date: vn("2026-11-20"), categoryId: "other", amount: 300_000, description: "Phí", channelId: null, cardId };
    expect(await createExpense(chi)).toMatchObject({ ok: false, code: "THE_DA_DONG" });
    expect(await prisma.expense.count()).toBe(0);
    expect(await ganNenTang({ cardId, nenTang: "META", tuNgay: "2026-12-05" })).toMatchObject({
      ok: false,
      error: "Thẻ đã đóng — không gắn thêm nền tảng",
    });
    expect(await prisma.ganNenTangThe.count({ where: { cardId } })).toBe(0);
  });
});
