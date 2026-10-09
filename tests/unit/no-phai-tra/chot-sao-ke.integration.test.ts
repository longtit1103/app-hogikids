import { randomUUID } from "node:crypto";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Chốt sao kê thẻ (`chotSaoKe`) trên DB thật — spec §5.5 (ước tính lúc chốt), §5.8 (ngày ∈ [M, hôm qua]),
 * §5.3 (yêu cầu ghi có mã). Fixture §6 thẻ A, M = 01/11/2026, hôm nay ghim 26/11/2026 10:00 VN.
 */
vi.mock("@/lib/quyen/nguoi-dung-phien", async (goc) => ({
  ...(await goc<typeof import("@/lib/quyen/nguoi-dung-phien")>()),
  docNguoiDungPhien: vi.fn(),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { Prisma } from "@/generated/prisma/client";
import { chotSaoKe } from "@/lib/actions/chot-sao-ke";
import { KEY_NO_PHAI_TRA_TU_NGAY } from "@/lib/no-phai-tra/cong-bat-no-phai-tra";
import { prisma } from "@/lib/prisma";
import { docNguoiDungPhien } from "@/lib/quyen/nguoi-dung-phien";

import { nguoiDungGia } from "../../helpers/nguoi-dung-gia";
import { seedReference, truncateBusinessTables } from "../../helpers/test-db";

const vn = (ngay: string, gio = "00:00:00") => new Date(`${ngay}T${gio}+07:00`);
const tr = (n: number) => Math.round(n * 1_000_000);

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

let soRef = 0;
async function adsMeta(ngay: string, trieu: number, gio = "00:00:00") {
  soRef += 1;
  await prisma.expense.create({
    data: {
      date: vn(ngay, gio),
      categoryId: "ads",
      adsSource: "META",
      amount: tr(trieu),
      description: "ads META",
      source: "ADS_API",
      refId: `META:${ngay}:chot-${soRef}`,
    },
  });
}

/** Thẻ A: neo 31/10 = 9; META 1+1+1+1 (02, 03, 24, 25/11 23:59); trả 7 (08/11) + 2 (25/11) ⇒ cuối 25/11 = 4,0. */
async function seedTheA(): Promise<string> {
  await prisma.setting.create({ data: { key: KEY_NO_PHAI_TRA_TU_NGAY, value: "2026-11-01" } });
  const A = (await prisma.theTinDung.create({ data: { ten: "Thẻ A", ngayChotSaoKe: 25, ngayHanTra: 10 } })).id;
  await prisma.ganNenTangThe.create({ data: { cardId: A, nenTang: "META", tuNgay: vn("2026-11-01") } });
  await prisma.kySaoKeThe.create({ data: { cardId: A, ngayChot: vn("2026-10-31"), soDu: tr(9), laNeoMoSo: true } });
  await adsMeta("2026-11-02", 1);
  await adsMeta("2026-11-03", 1);
  await adsMeta("2026-11-24", 1);
  await adsMeta("2026-11-25", 1, "23:59:00");
  for (const [ngay, trieu] of [["2026-11-08", 7], ["2026-11-25", 2]] as const) {
    await prisma.cashMovement.create({
      data: { date: vn(ngay, "10:00:00"), kind: "CARD_PAY", amount: tr(trieu), cardId: A, description: "Trả thẻ" },
    });
  }
  return A;
}

const chot = (cardId: string, ghiDe: Record<string, unknown> = {}) => ({
  yeuCauId: randomUUID(),
  cardId,
  ngayChot: "2026-11-25",
  soDu: tr(4.4),
  hanTra: "2026-12-10",
  note: "",
  ...ghiDe,
});

describe("chotSaoKe", () => {
  it("TRƯỚC khi bật ⇒ CHUA_BAT_NO_PHAI_TRA, không ghi", async () => {
    const A = (await prisma.theTinDung.create({ data: { ten: "A", ngayChotSaoKe: 25, ngayHanTra: 10 } })).id;
    expect(await chotSaoKe(chot(A))).toMatchObject({ ok: false, code: "CHUA_BAT_NO_PHAI_TRA" });
    expect(await prisma.kySaoKeThe.count()).toBe(0);
  });

  it("sao kê 4,4 ⇒ ước tính 4,0 (giao dịch đúng ngày chốt vào ước tính), chênh +0,4; ngày lưu 00:00 VN", async () => {
    const A = await seedTheA();
    const r = await chotSaoKe(chot(A, { ngayChot: vn("2026-11-25", "15:00:00") }));
    expect(r).toMatchObject({
      ok: true,
      data: { cardId: A, ngayChot: "2026-11-25", soDu: tr(4.4), uocTinh: tr(4), chenh: tr(0.4) },
    });
    expect(r).not.toHaveProperty("code");
    const ky = await prisma.kySaoKeThe.findFirstOrThrow({ where: { cardId: A, laNeoMoSo: false } });
    expect(ky).toMatchObject({ soDu: tr(4.4), uocTinhLucChot: tr(4), laNeoMoSo: false });
    expect(ky.ngayChot).toEqual(vn("2026-11-25"));
    expect(ky.hanTra).toEqual(vn("2026-12-10"));
    const nk = await prisma.auditLog.findFirstOrThrow({ where: { hanhDong: "THE_CHOT_SAO_KE", doiTuongId: ky.id } });
    expect(nk.doiTuongMoTa).toContain("chênh");
  });

  it("ngày chốt HÔM NAY ⇒ từ chối; trước M ⇒ từ chối; hạn ≤ ngày chốt ⇒ từ chối", async () => {
    const A = await seedTheA();
    expect(await chotSaoKe(chot(A, { ngayChot: "2026-11-26" }))).toMatchObject({ ok: false, field: "ngayChot" });
    expect(await chotSaoKe(chot(A, { ngayChot: "2026-10-31" }))).toMatchObject({ ok: false, field: "ngayChot" });
    expect(await chotSaoKe(chot(A, { hanTra: "2026-11-25" }))).toMatchObject({ ok: false, field: "hanTra" });
    expect(await prisma.kySaoKeThe.count({ where: { laNeoMoSo: false } })).toBe(0);
    expect(await prisma.yeuCauGhi.count()).toBe(0);
  });

  it("gửi lại CÙNG mã + cùng nội dung ⇒ DA_GHI_ROI, kết quả cũ, không thêm dòng", async () => {
    const A = await seedTheA();
    const yc = chot(A);
    const dau = await chotSaoKe(yc);
    expect(dau.ok).toBe(true);
    const lai = await chotSaoKe(yc);
    expect(lai).toEqual({ ...dau, code: "DA_GHI_ROI" });
    expect(await prisma.kySaoKeThe.count({ where: { laNeoMoSo: false } })).toBe(1);
    if (!dau.ok) throw new Error(dau.error);
    // AuditLog không bị dọn giữa các test ⇒ đếm theo đúng dòng kỳ vừa chốt.
    expect(await prisma.auditLog.count({ where: { hanhDong: "THE_CHOT_SAO_KE", doiTuongId: dau.data.id } })).toBe(1);
  });

  it("cùng mã KHÁC nội dung ⇒ từ chối", async () => {
    const A = await seedTheA();
    const yc = chot(A);
    expect((await chotSaoKe(yc)).ok).toBe(true);
    expect(await chotSaoKe({ ...yc, soDu: tr(5) })).toMatchObject({ ok: false, error: expect.stringContaining("nội dung khác") });
  });

  it("cùng ngày chốt, mã KHÁC ⇒ 'đã chốt ngày này'; mã thứ hai không để lại YeuCauGhi", async () => {
    const A = await seedTheA();
    expect((await chotSaoKe(chot(A))).ok).toBe(true);
    const lan2 = chot(A, { soDu: tr(4.5) });
    expect(await chotSaoKe(lan2)).toMatchObject({ ok: false, field: "ngayChot", error: expect.stringContaining("đã có kỳ/neo ở ngày này (25/11/2026)") });
    expect(await prisma.yeuCauGhi.findUnique({ where: { id: lan2.yeuCauId } })).toBeNull();
    expect(await prisma.kySaoKeThe.count({ where: { laNeoMoSo: false } })).toBe(1);
  });

  it("YeuCauGhi cũ cùng vân tay mà ketQua NULL ⇒ ném (không coi là đã ghi)", async () => {
    const A = await seedTheA();
    const yc = chot(A);
    const dau = await chotSaoKe(yc);
    expect(dau.ok).toBe(true);
    await prisma.yeuCauGhi.update({ where: { id: yc.yeuCauId }, data: { ketQua: Prisma.DbNull } });
    expect(await chotSaoKe(yc)).toMatchObject({ ok: false, error: "Lỗi khi chốt sao kê" });
  });

  it("nhân sự (kể cả có quyền Sổ quỹ) ⇒ KHONG_CO_QUYEN — chỉ chủ shop chốt sao kê", async () => {
    const A = await seedTheA();
    vi.mocked(docNguoiDungPhien).mockResolvedValue(
      nguoiDungGia({ id: "nv", role: "STAFF", quyen: new Set(["tai-chinh-so-quy:sua"]) })
    );
    expect(await chotSaoKe(chot(A))).toMatchObject({ ok: false, code: "KHONG_CO_QUYEN" });
  });

  it("thẻ đã đóng ⇒ từ chối", async () => {
    const A = await seedTheA();
    await prisma.theTinDung.update({ where: { id: A }, data: { closedAt: vn("2026-11-20") } });
    expect(await chotSaoKe(chot(A))).toMatchObject({ ok: false, error: "Thẻ đã đóng" });
  });
});
