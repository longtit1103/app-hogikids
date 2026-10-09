import { randomUUID } from "node:crypto";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Mã từ chối của bước xác nhận bật nợ phải trả — mỗi mã MỘT ca trên DB thật, kèm hậu kiểm "không ghi gì"
 * (Setting, kỳ sao kê, điều chỉnh). Bổ sung cho `bat-no-phai-tra.integration.test.ts` (luồng chính + điều
 * kiện tiên quyết khác). M = 01/11/2026, hôm nay ghim 03/11/2026 10:00 VN; quỹ mở sổ 10/10.
 */
vi.mock("@/lib/quyen/nguoi-dung-phien", async (goc) => ({
  ...(await goc<typeof import("@/lib/quyen/nguoi-dung-phien")>()),
  docNguoiDungPhien: vi.fn(),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { xacNhanBatNoPhaiTra } from "@/lib/actions/bat-no-phai-tra";
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
  vi.setSystemTime(vn("2026-11-03", "10:00:00"));
});

afterEach(async () => {
  vi.useRealTimers();
  await prisma.setting.deleteMany({ where: { key: KEY_NO_PHAI_TRA_TU_NGAY } });
});

afterAll(async () => {
  await truncateBusinessTables();
  await prisma.$disconnect();
});

type SaoKe = { ngayChot: string; soDu: number; hanTra: string; daTraTruocMoSo: number };
type KhaiThe = { cardId: string; saoKeCuoi: SaoKe | null; duNoCuoiMTru1: number };

async function seed(moSo = true): Promise<string> {
  if (moSo) {
    await prisma.cashMovement.create({
      data: { date: vn("2026-10-10"), kind: "CAPITAL_IN", amount: tr(150), description: "mở sổ" },
    });
  }
  return (await prisma.theTinDung.create({ data: { ten: "Thẻ A", ngayChotSaoKe: 25, ngayHanTra: 10 } })).id;
}

const saoKe = (ghiDe: Partial<SaoKe> = {}): SaoKe => ({
  ngayChot: "2026-10-25",
  soDu: tr(12),
  hanTra: "2026-11-10",
  daTraTruocMoSo: tr(5),
  ...ghiDe,
});

const bat = (the: KhaiThe[], ghiDe: Record<string, unknown> = {}) =>
  xacNhanBatNoPhaiTra({
    yeuCauId: randomUUID(),
    mocM: "2026-11-01",
    the,
    viAds: [],
    dieuChinh: [{ chieu: "IN", soTien: tr(9), moTa: "nợ thẻ A" }],
    ...ghiDe,
  });

/** Bị từ chối thì không có gì được ghi: Setting, kỳ sao kê, điều chỉnh. */
async function khongGhiGi(): Promise<void> {
  expect(await prisma.setting.findUnique({ where: { key: KEY_NO_PHAI_TRA_TU_NGAY } })).toBeNull();
  expect(await prisma.kySaoKeThe.count()).toBe(0);
  expect(await prisma.cashMovement.count({ where: { kind: { in: ["CUTOVER_ADJ_IN", "CUTOVER_ADJ_OUT"] } } })).toBe(0);
}

describe("xacNhanBatNoPhaiTra — mã từ chối", () => {
  it("CHUA_MO_SO: chưa có dòng nhập quỹ nào", async () => {
    const A = await seed(false);
    expect(await bat([{ cardId: A, saoKeCuoi: saoKe(), duNoCuoiMTru1: tr(9) }])).toMatchObject({
      ok: false,
      code: "CHUA_MO_SO",
    });
    await khongGhiGi();
  });

  it("M_TRUOC_MO_SO: ngày bật 05/10 trước ngày mở sổ 10/10", async () => {
    const A = await seed();
    const r = await bat([{ cardId: A, saoKeCuoi: null, duNoCuoiMTru1: tr(9) }], { mocM: "2026-10-05" });
    expect(r).toMatchObject({ ok: false, code: "M_TRUOC_MO_SO" });
    expect(r.ok === false && r.error).toContain("10/10/2026");
    await khongGhiGi();
  });

  it("THE_TRUNG: một thẻ khai hai lần", async () => {
    const A = await seed();
    const k: KhaiThe = { cardId: A, saoKeCuoi: null, duNoCuoiMTru1: tr(9) };
    expect(await bat([k, k])).toMatchObject({ ok: false, code: "THE_TRUNG" });
    await khongGhiGi();
  });

  it("THE_KHONG_HOP_LE: khai thẻ đã đóng", async () => {
    const A = await seed();
    const C = await prisma.theTinDung.create({
      data: { ten: "Thẻ C", ngayChotSaoKe: 25, ngayHanTra: 10, closedAt: vn("2026-10-20") },
    });
    expect(
      await bat([
        { cardId: A, saoKeCuoi: null, duNoCuoiMTru1: tr(9) },
        { cardId: C.id, saoKeCuoi: null, duNoCuoiMTru1: 0 },
      ])
    ).toMatchObject({ ok: false, code: "THE_KHONG_HOP_LE" });
    await khongGhiGi();
  });

  it("SAO_KE_SAU_M: sao kê chốt đúng ngày M (01/11) — phải chốt trước ngày bật", async () => {
    const A = await seed();
    expect(
      await bat([{ cardId: A, saoKeCuoi: saoKe({ ngayChot: "2026-11-01", hanTra: "2026-11-20" }), duNoCuoiMTru1: tr(9) }])
    ).toMatchObject({ ok: false, code: "SAO_KE_SAU_M" });
    await khongGhiGi();
  });

  it("HAN_TRUOC_CHOT: hạn trả trùng ngày chốt", async () => {
    const A = await seed();
    expect(
      await bat([{ cardId: A, saoKeCuoi: saoKe({ hanTra: "2026-10-25" }), duNoCuoiMTru1: tr(9) }])
    ).toMatchObject({ ok: false, code: "HAN_TRUOC_CHOT" });
    await khongGhiGi();
  });

  it("DA_TRA_VUOT_SAO_KE: đã trả trước ngày bật lớn hơn số sao kê", async () => {
    const A = await seed();
    expect(
      await bat([{ cardId: A, saoKeCuoi: saoKe({ soDu: tr(12), daTraTruocMoSo: tr(12) + 1 }), duNoCuoiMTru1: tr(9) }])
    ).toMatchObject({ ok: false, code: "DA_TRA_VUOT_SAO_KE" });
    await khongGhiGi();
  });

  it("VI_TRUNG: một ví khai hai lần", async () => {
    const A = await seed();
    const vi1 = await prisma.viAdsTraTruoc.create({ data: { nenTang: "SHOPEE_ADS", soDuNeo: 0, ngayNeo: vn("2026-10-20") } });
    expect(
      await bat([{ cardId: A, saoKeCuoi: null, duNoCuoiMTru1: tr(9) }], {
        viAds: [
          { viAdsId: vi1.id, soDuNeo: tr(1) },
          { viAdsId: vi1.id, soDuNeo: tr(1) },
        ],
      })
    ).toMatchObject({ ok: false, code: "VI_TRUNG" });
    await khongGhiGi();
  });
});

describe("xacNhanBatNoPhaiTra — neo mở sổ cũ", () => {
  it("thẻ đã có neo mở sổ (vd hồ sơ khôi phục) ⇒ neo cũ bị THAY bằng neo cuối M−1, mỗi thẻ đúng một neo", async () => {
    const A = await seed();
    await prisma.kySaoKeThe.create({
      data: { cardId: A, ngayChot: vn("2026-10-20"), soDu: tr(1), laNeoMoSo: true },
    });
    expect(await bat([{ cardId: A, saoKeCuoi: null, duNoCuoiMTru1: tr(9) }])).toMatchObject({ ok: true });
    const neo = await prisma.kySaoKeThe.findMany({ where: { cardId: A, laNeoMoSo: true } });
    expect(neo).toHaveLength(1);
    expect(neo[0].soDu).toBe(tr(9));
    expect(neo[0].ngayChot).toEqual(vn("2026-10-31"));
    expect(await prisma.kySaoKeThe.count({ where: { cardId: A } })).toBe(1);
  });
});
