import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Thùng rác cho NỢ PHẢI TRẢ trên DB thật (spec §5.7, §5.8; review focus #3): 3 hồ sơ mới (`TheTinDung`
 * kèm neo `KySaoKeThe`, `PhieuNhapNo`, `ViAdsTraTruoc`) chụp + dựng lại đúng id; dòng tiền kind mới khôi
 * phục qua ĐỦ cổng (đã bật, cửa sổ ngày, thẻ đóng); trả tiền hàng khôi phục được SAU khi phiếu huỷ (nợ âm
 * "cần thu hồi"); điều chỉnh mở sổ chỉ chủ shop. M = 01/11/2026, hôm nay ghim 26/11/2026.
 */
vi.mock("@/lib/quyen/nguoi-dung-phien", async (goc) => ({
  ...(await goc<typeof import("@/lib/quyen/nguoi-dung-phien")>()),
  docNguoiDungPhien: vi.fn(),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { createCashMovement, deleteCashMovement } from "@/lib/actions/cash-movements";
import { deleteExpense } from "@/lib/actions/expenses";
import { xoaPhieu } from "@/lib/actions/phieu-nhap-no";
import { taoThe, xoaThe } from "@/lib/actions/the-tin-dung";
import { KEY_NO_PHAI_TRA_TU_NGAY, KHOA_BAT_NO_PHAI_TRA } from "@/lib/no-phai-tra/cong-bat-no-phai-tra";
import { docPhieuTheoId } from "@/lib/no-phai-tra/phieu-nhap-no-queries";
import { prisma } from "@/lib/prisma";
import { docNguoiDungPhien } from "@/lib/quyen/nguoi-dung-phien";
import { chupVaoThungRac } from "@/lib/thung-rac/ghi-thung-rac";
import { khoiPhucBanGhiDaXoa } from "@/lib/thung-rac/khoi-phuc-ban-ghi";
import { anhDongTienGanSoQuy, LoiThieuQuyenThungRac } from "@/lib/thung-rac/quyen-thung-rac";

import { nguoiDungGia } from "../../helpers/nguoi-dung-gia";
import { seedReference, truncateBusinessTables } from "../../helpers/test-db";

const vn = (ngay: string, gio = "00:00:00") => new Date(`${ngay}T${gio}+07:00`);
const tr = (n: number) => Math.round(n * 1_000_000);
const CHU = nguoiDungGia();

async function datM(ngay: string | null) {
  await prisma.setting.deleteMany({ where: { key: KEY_NO_PHAI_TRA_TU_NGAY } });
  if (ngay) await prisma.setting.create({ data: { key: KEY_NO_PHAI_TRA_TU_NGAY, value: ngay } });
}

async function taoPhieu(): Promise<string> {
  return (
    await prisma.phieuNhapNo.create({
      data: { refId: `PO:${Math.random()}`, shopId: "714995134", maPhieu: "PN-9", ngayPhieu: vn("2026-11-02"), tongTien: tr(20) },
    })
  ).id;
}

const mucThungRac = (bang: string) => prisma.banGhiDaXoa.findFirstOrThrow({ where: { bang }, orderBy: { xoaLuc: "desc" } });

beforeAll(async () => {
  await seedReference();
}, 60_000);

beforeEach(async () => {
  await truncateBusinessTables();
  await datM(null);
  vi.mocked(docNguoiDungPhien).mockResolvedValue(CHU);
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(vn("2026-11-26", "10:00:00"));
});

afterEach(async () => {
  vi.useRealTimers();
  await datM(null);
});

afterAll(async () => {
  await truncateBusinessTables();
  await prisma.$disconnect();
});

describe("hồ sơ nợ vào thùng rác + khôi phục", () => {
  it("thẻ thêm sau bật (neo 0): xoá ⇒ chụp kèm neo; khôi phục dựng lại thẻ + neo đúng id", async () => {
    await datM("2026-11-01");
    const tao = await taoThe({ ten: "Thẻ A", nganHang: "VCB", ngayChotSaoKe: 25, ngayHanTra: 10, neoBanDau: { ngayChot: "2026-11-20", soDu: 0 } });
    expect(tao.ok).toBe(true);
    const id = (tao as { data: { id: string } }).data.id;
    const neo = await prisma.kySaoKeThe.findFirstOrThrow({ where: { cardId: id } });
    expect(await xoaThe(id)).toEqual({ ok: true, data: undefined });
    expect(await prisma.theTinDung.count()).toBe(0);
    const muc = await mucThungRac("TheTinDung");
    expect((muc.anh as { kySaoKe: unknown[] }).kySaoKe).toHaveLength(1);

    expect(await khoiPhucBanGhiDaXoa(muc.id, CHU)).toEqual({ ok: true, canhBao: null });
    expect(await prisma.theTinDung.findUniqueOrThrow({ where: { id } })).toMatchObject({ ten: "Thẻ A", nganHang: "VCB" });
    expect(await prisma.kySaoKeThe.findUniqueOrThrow({ where: { id: neo.id } })).toMatchObject({
      cardId: id,
      soDu: 0,
      laNeoMoSo: true,
      ngayChot: neo.ngayChot,
    });
  });

  it("thẻ xoá lúc CHƯA bật (không neo) ⇒ sau khi bật không khôi phục được", async () => {
    const tao = await taoThe({ ten: "Thẻ B", ngayChotSaoKe: 25, ngayHanTra: 10 });
    const id = (tao as { data: { id: string } }).data.id;
    await xoaThe(id);
    await datM("2026-11-01");
    const r = await khoiPhucBanGhiDaXoa((await mucThungRac("TheTinDung")).id, CHU);
    expect(r).toMatchObject({ ok: false });
    expect((r as { lyDo: string }).lyDo).toMatch(/không có neo dư nợ/);
    expect(await prisma.theTinDung.count()).toBe(0);
  });

  it("phiếu nợ: còn dòng tiền ⇒ không xoá; trống ⇒ vào thùng rác; khôi phục trùng refId đang sống ⇒ từ chối", async () => {
    await datM("2026-11-01");
    const p = await taoPhieu();
    await createCashMovement({ date: vn("2026-11-20"), kind: "SUPPLIER_PAY", amount: tr(5), description: "", phieuNhapId: p });
    expect(await xoaPhieu({ phieuNhapId: p })).toMatchObject({ ok: false, code: "CON_DONG_TIEN" });
    await prisma.cashMovement.deleteMany();
    expect(await xoaPhieu({ phieuNhapId: p })).toEqual({ ok: true, data: undefined });
    const muc = await mucThungRac("PhieuNhapNo");
    const refId = (muc.anh as { chinh: { refId: string } }).chinh.refId;
    await prisma.phieuNhapNo.create({
      data: { refId, shopId: "714995134", maPhieu: "PN-9", ngayPhieu: vn("2026-11-02"), tongTien: tr(20) },
    });
    expect(await khoiPhucBanGhiDaXoa(muc.id, CHU)).toMatchObject({ ok: false, lyDo: expect.stringContaining(refId) });
    await prisma.phieuNhapNo.deleteMany({ where: { refId } });
    expect(await khoiPhucBanGhiDaXoa(muc.id, CHU)).toEqual({ ok: true, canhBao: null });
    expect(await prisma.phieuNhapNo.findUniqueOrThrow({ where: { id: p } })).toMatchObject({ refId, tongTien: tr(20) });
  });

  it("ví ads: chụp + khôi phục đúng id; trùng nền tảng đang sống ⇒ từ chối", async () => {
    const vi1 = await prisma.viAdsTraTruoc.create({ data: { nenTang: "SHOPEE_ADS", soDuNeo: tr(1), ngayNeo: vn("2026-10-31", "23:59:59") } });
    await prisma.$transaction(async (tx) => {
      await chupVaoThungRac(tx, { bang: "ViAdsTraTruoc", banGhi: vi1 });
      await tx.viAdsTraTruoc.delete({ where: { id: vi1.id } });
    });
    const muc = await mucThungRac("ViAdsTraTruoc");
    const khac = await prisma.viAdsTraTruoc.create({ data: { nenTang: "SHOPEE_ADS", soDuNeo: 0, ngayNeo: vn("2026-10-31") } });
    expect(await khoiPhucBanGhiDaXoa(muc.id, CHU)).toMatchObject({ ok: false });
    await prisma.viAdsTraTruoc.delete({ where: { id: khac.id } });
    expect(await khoiPhucBanGhiDaXoa(muc.id, CHU)).toEqual({ ok: true, canhBao: null });
    expect(await prisma.viAdsTraTruoc.findUniqueOrThrow({ where: { id: vi1.id } })).toMatchObject({ soDuNeo: tr(1) });
  });
});

describe("dòng tiền nợ phải trả khôi phục qua ĐỦ cổng", () => {
  it("review focus #3: xoá SUPPLIER_PAY 5tr, phiếu bị huỷ, khôi phục ⇒ ĐƯỢC, còn nợ −5tr 'cần thu hồi'", async () => {
    await datM("2026-11-01");
    const p = await taoPhieu();
    await createCashMovement({ date: vn("2026-11-20"), kind: "SUPPLIER_PAY", amount: tr(5), description: "", phieuNhapId: p });
    const dong = await prisma.cashMovement.findFirstOrThrow();
    await deleteCashMovement(dong.id);
    await prisma.phieuNhapNo.update({ where: { id: p }, data: { daHuy: true } });
    expect(await khoiPhucBanGhiDaXoa((await mucThungRac("CashMovement")).id, CHU)).toEqual({ ok: true, canhBao: null });
    expect(await docPhieuTheoId(p)).toMatchObject({ conNo: -tr(5), trangThai: "CAN_THU_HOI" });
  });

  it("hoàn tiền NCC trong thùng rác: dòng trả đã bị giảm dưới số hoàn ⇒ khôi phục bị từ chối (trần hoàn)", async () => {
    await datM("2026-11-01");
    const p = await taoPhieu();
    const dong = (kind: string, amount: number) => ({ date: vn("2026-11-20"), kind, amount, description: "", phieuNhapId: p });
    await createCashMovement(dong("SUPPLIER_PAY", tr(5)));
    await createCashMovement(dong("SUPPLIER_REFUND", tr(5)));
    const hoan = await prisma.cashMovement.findFirstOrThrow({ where: { kind: "SUPPLIER_REFUND" } });
    expect(await deleteCashMovement(hoan.id)).toEqual({ ok: true, data: undefined });
    const tra = await prisma.cashMovement.findFirstOrThrow({ where: { kind: "SUPPLIER_PAY" } });
    await prisma.cashMovement.update({ where: { id: tra.id }, data: { amount: tr(3) } });
    const r = await khoiPhucBanGhiDaXoa((await mucThungRac("CashMovement")).id, CHU);
    expect(r).toMatchObject({ ok: false, lyDo: expect.stringMatching(/vượt số đã trả/) });
    expect(await prisma.cashMovement.count({ where: { kind: "SUPPLIER_REFUND" } })).toBe(0);
  });

  it("CARD_PAY: thẻ đã đóng ⇒ từ chối; M bị gỡ ⇒ chưa bật; M dời sau ngày dòng ⇒ ngoài cửa sổ", async () => {
    await datM("2026-11-01");
    const tao = await taoThe({ ten: "Thẻ C", ngayChotSaoKe: 25, ngayHanTra: 10, neoBanDau: { ngayChot: "2026-11-01", soDu: 0 } });
    const cardId = (tao as { data: { id: string } }).data.id;
    await createCashMovement({ date: vn("2026-11-20"), kind: "CARD_PAY", amount: tr(2), description: "", cardId });
    await deleteCashMovement((await prisma.cashMovement.findFirstOrThrow()).id);
    const muc = await mucThungRac("CashMovement");

    await prisma.theTinDung.update({ where: { id: cardId }, data: { closedAt: vn("2026-11-25") } });
    expect(await khoiPhucBanGhiDaXoa(muc.id, CHU)).toMatchObject({ ok: false, lyDo: expect.stringMatching(/đã đóng/) });
    await prisma.theTinDung.update({ where: { id: cardId }, data: { closedAt: null } });

    await datM(null);
    expect(await khoiPhucBanGhiDaXoa(muc.id, CHU)).toMatchObject({ ok: false, lyDo: expect.stringMatching(/Chưa bật/) });
    await datM("2026-11-21");
    expect(await khoiPhucBanGhiDaXoa(muc.id, CHU)).toMatchObject({ ok: false, lyDo: expect.stringMatching(/ngoài cửa sổ/) });
    await datM("2026-11-01");
    expect(await khoiPhucBanGhiDaXoa(muc.id, CHU)).toEqual({ ok: true, canhBao: null });
    expect(await prisma.cashMovement.count({ where: { cardId } })).toBe(1);
    // Khôi phục xong mục đã đóng dấu — các lượt từ chối trước KHÔNG để lại dấu (ném ⇒ rollback).
    expect((await prisma.banGhiDaXoa.findUniqueOrThrow({ where: { id: muc.id } })).khoiPhucLuc).not.toBeNull();
  });

  it("khoản chi trừ thẻ ngày 30/10 (< M) ⇒ khôi phục từ chối 'trước ngày bật' — thẻ có sao kê 25/10 nên cửa sổ neo không che", async () => {
    await datM("2026-11-01");
    // Thẻ của bước bật: sao kê thật 25/10 (dòng (i)) + neo mở sổ 31/10 ⇒ neo ĐẦU TIÊN là 25/10, ngày 30/10 qua
    // cửa sổ neo thẻ; chỉ luật "Expense.cardId ≥ M" chặn được nó.
    const cardId = (await prisma.theTinDung.create({ data: { ten: "Thẻ M", ngayChotSaoKe: 25, ngayHanTra: 10 } })).id;
    await prisma.kySaoKeThe.create({ data: { cardId, ngayChot: vn("2026-10-25"), soDu: tr(4), hanTra: vn("2026-11-10") } });
    await prisma.kySaoKeThe.create({ data: { cardId, ngayChot: vn("2026-10-31"), soDu: tr(6), laNeoMoSo: true } });
    const e = await prisma.expense.create({
      data: { date: vn("2026-10-30"), categoryId: "other", amount: 300_000, description: "", source: "MANUAL", cardId },
    });
    expect(await deleteExpense(e.id, "only")).toEqual({ ok: true, data: undefined });
    const r = await khoiPhucBanGhiDaXoa((await mucThungRac("Expense")).id, CHU);
    expect(r).toMatchObject({ ok: false, lyDo: expect.stringMatching(/trước ngày bật theo dõi nợ/) });
    expect(await prisma.expense.count()).toBe(0);
  });

  it("ADS_TOPUP ngày ≤ ngày neo ví ⇒ khôi phục qua kiemHoSoNo bị từ chối (TRUOC_NGAY_NEO_VI)", async () => {
    await datM("2026-11-01");
    const viAdsId = (
      await prisma.viAdsTraTruoc.create({ data: { nenTang: "SHOPEE_ADS", soDuNeo: 0, ngayNeo: vn("2026-11-01", "23:59:59") } })
    ).id;
    expect(
      await createCashMovement({ date: vn("2026-11-05"), kind: "ADS_TOPUP", amount: tr(1), description: "", viAdsId }),
    ).toEqual({ ok: true, data: undefined });
    await deleteCashMovement((await prisma.cashMovement.findFirstOrThrow()).id);
    // Ví được neo lại muộn hơn trong lúc dòng nằm thùng rác: tiền nạp 05/11 nay đã nằm trong số dư neo.
    await prisma.viAdsTraTruoc.update({ where: { id: viAdsId }, data: { ngayNeo: vn("2026-11-06", "23:59:59") } });
    const r = await khoiPhucBanGhiDaXoa((await mucThungRac("CashMovement")).id, CHU);
    expect(r).toMatchObject({ ok: false, lyDo: expect.stringMatching(/sau ngày neo số dư ví/) });
    expect(await prisma.cashMovement.count()).toBe(0);
  });

  it("CUTOVER_*: nhân sự có quyền Sổ quỹ ⇒ thiếu quyền; chủ shop ⇒ chỉ khi ngày = M", async () => {
    await datM("2026-11-01");
    const dong = await prisma.cashMovement.create({
      data: { date: vn("2026-11-01"), kind: "CUTOVER_ADJ_IN", amount: tr(3), description: "Điều chỉnh mở sổ" },
    });
    await prisma.$transaction(async (tx) => {
      await chupVaoThungRac(tx, { bang: "CashMovement", banGhi: dong });
      await tx.cashMovement.delete({ where: { id: dong.id } });
    });
    const muc = await mucThungRac("CashMovement");
    expect(anhDongTienGanSoQuy(muc.anh)).toBe(true);
    const nhanSu = nguoiDungGia({ role: "STAFF", quyen: new Set(["tai-chinh-dong-tien:sua", "tai-chinh-so-quy:sua"]) as never });
    await expect(khoiPhucBanGhiDaXoa(muc.id, nhanSu)).rejects.toBeInstanceOf(LoiThieuQuyenThungRac);
    await datM("2026-10-31");
    expect(await khoiPhucBanGhiDaXoa(muc.id, CHU)).toMatchObject({ ok: false, lyDo: expect.stringMatching(/đúng ngày bật/) });
    await datM("2026-11-01");
    expect(await khoiPhucBanGhiDaXoa(muc.id, CHU)).toEqual({ ok: true, canhBao: null });
  });
});

/** Ví vào thùng rác (khuôn `xoaViAds`: chụp rồi xoá), trả id mục thùng rác. */
async function viVaoThungRac(soDuNeo: number, ngayNeo: string): Promise<{ viId: string; mucId: string }> {
  const vi1 = await prisma.viAdsTraTruoc.create({ data: { nenTang: "SHOPEE_ADS", soDuNeo, ngayNeo: vn(ngayNeo) } });
  await prisma.$transaction(async (tx) => {
    await chupVaoThungRac(tx, { bang: "ViAdsTraTruoc", banGhi: vi1 });
    await tx.viAdsTraTruoc.delete({ where: { id: vi1.id } });
  });
  return { viId: vi1.id, mucId: (await mucThungRac("ViAdsTraTruoc")).id };
}

/** Thẻ (kèm các dòng kỳ sao kê cho trước) vào thùng rác, trả id mục thùng rác. */
async function theVaoThungRac(ky: { ngayChot: string; soDu: number; laNeoMoSo: boolean }[]): Promise<string> {
  const the = await prisma.theTinDung.create({ data: { ten: "Thẻ R", ngayChotSaoKe: 25, ngayHanTra: 10 } });
  for (const k of ky) await prisma.kySaoKeThe.create({ data: { cardId: the.id, ...k, ngayChot: vn(k.ngayChot) } });
  await prisma.$transaction(async (tx) => {
    const kySaoKe = await tx.kySaoKeThe.findMany({ where: { cardId: the.id }, orderBy: { ngayChot: "asc" } });
    await chupVaoThungRac(tx, { bang: "TheTinDung", banGhi: the, kySaoKe });
    await tx.kySaoKeThe.deleteMany({ where: { cardId: the.id } });
    await tx.theTinDung.delete({ where: { id: the.id } });
  });
  return (await mucThungRac("TheTinDung")).id;
}

const adsShopee = (ngay: string) =>
  prisma.expense.create({
    data: { date: vn(ngay), categoryId: "ads", adsSource: "SHOPEE_ADS", amount: tr(1), description: "ads", source: "MANUAL" },
  });

describe("khôi phục ví ads SAU khi bật — chống đổi quỹ hồi tố (M = 01/11, hôm nay 26/11)", () => {
  it("chưa bật: ví số dư tạm 1tr neo 20/10 khôi phục được (hồ sơ chuẩn bị, bước bật ghi đè)", async () => {
    const { viId, mucId } = await viVaoThungRac(tr(1), "2026-10-20");
    await adsShopee("2026-11-21");
    expect(await khoiPhucBanGhiDaXoa(mucId, CHU)).toEqual({ ok: true, canhBao: null });
    expect(await prisma.viAdsTraTruoc.findUniqueOrThrow({ where: { id: viId } })).toMatchObject({ soDuNeo: tr(1) });
  });

  it("đã bật, neo 20/11 số dư 0, không chi ads SAU neo (chỉ đúng ngày neo) ⇒ khôi phục được", async () => {
    const { viId, mucId } = await viVaoThungRac(0, "2026-11-20");
    await datM("2026-11-01");
    await adsShopee("2026-11-20");
    expect(await khoiPhucBanGhiDaXoa(mucId, CHU)).toEqual({ ok: true, canhBao: null });
    expect(await prisma.viAdsTraTruoc.count({ where: { id: viId } })).toBe(1);
  });

  it("đã bật, có chi ads Shopee 21/11 (sau neo 20/11) ⇒ từ chối: khôi phục làm khoản đó thôi trừ quỹ hồi tố", async () => {
    const { mucId } = await viVaoThungRac(0, "2026-11-20");
    await datM("2026-11-01");
    await adsShopee("2026-11-21");
    const r = await khoiPhucBanGhiDaXoa(mucId, CHU);
    expect(r).toMatchObject({ ok: false, lyDo: expect.stringMatching(/1 khoản chi quảng cáo.*từ 21\/11\/2026.*hồi tố/) });
    expect(await prisma.viAdsTraTruoc.count()).toBe(0);
    expect((await prisma.banGhiDaXoa.findUniqueOrThrow({ where: { id: mucId } })).khoiPhucLuc).toBeNull();
  });

  it("đã bật, ảnh neo 30/10 (< M − 1 = 31/10) ⇒ từ chối dù không có chi ads", async () => {
    const { mucId } = await viVaoThungRac(0, "2026-10-30");
    await datM("2026-11-01");
    const r = await khoiPhucBanGhiDaXoa(mucId, CHU);
    expect(r).toMatchObject({ ok: false, lyDo: expect.stringMatching(/ngày 30\/10\/2026, trước ngày 31\/10\/2026/) });
    expect(await prisma.viAdsTraTruoc.count()).toBe(0);
  });

  it("đã bật, ảnh neo 20/11 số dư 2tr ⇒ từ chối (ví thêm sau bật phải số dư 0)", async () => {
    const { mucId } = await viVaoThungRac(tr(2), "2026-11-20");
    await datM("2026-11-01");
    const r = await khoiPhucBanGhiDaXoa(mucId, CHU);
    expect(r).toMatchObject({ ok: false, lyDo: expect.stringMatching(/số dư ban đầu khác 0/) });
    expect(await prisma.viAdsTraTruoc.count()).toBe(0);
  });
});

describe("khôi phục thẻ SAU khi bật — neo phải 0 trừ neo của bước bật; khoá SHARED bước bật", () => {
  it("ảnh có neo mở sổ 2tr ngày 20/11 (không phải M − 1) ⇒ từ chối", async () => {
    const mucId = await theVaoThungRac([{ ngayChot: "2026-11-20", soDu: tr(2), laNeoMoSo: true }]);
    await datM("2026-11-01");
    const r = await khoiPhucBanGhiDaXoa(mucId, CHU);
    expect(r).toMatchObject({ ok: false, lyDo: expect.stringMatching(/dư nợ ban đầu khác 0.*31\/10\/2026/) });
    expect(await prisma.theTinDung.count()).toBe(0);
  });

  it("ảnh có neo mở sổ 2tr đúng ngày M − 1 (neo của bước bật) ⇒ khôi phục được, neo dựng lại", async () => {
    const mucId = await theVaoThungRac([{ ngayChot: "2026-10-31", soDu: tr(2), laNeoMoSo: true }]);
    await datM("2026-11-01");
    expect(await khoiPhucBanGhiDaXoa(mucId, CHU)).toEqual({ ok: true, canhBao: null });
    expect(await prisma.kySaoKeThe.findFirstOrThrow()).toMatchObject({ soDu: tr(2), laNeoMoSo: true });
  });

  it("thẻ không neo khôi phục giữa lúc bước bật đang chạy ⇒ CHỜ bước bật commit rồi bị từ chối 'không có neo'", async () => {
    const mucId = await theVaoThungRac([]);
    let tha!: () => void;
    const cho = new Promise<void>((res) => (tha = res));
    let daGiu!: () => void;
    const giuXong = new Promise<void>((res) => (daGiu = res));
    const buocBat = prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${KHOA_BAT_NO_PHAI_TRA}::text))`;
        await tx.setting.create({ data: { key: KEY_NO_PHAI_TRA_TU_NGAY, value: "2026-11-01" } });
        daGiu();
        await cho;
      },
      { timeout: 20_000 }
    );
    await giuXong;
    const t0 = performance.now();
    const p = khoiPhucBanGhiDaXoa(mucId, CHU).then((r) => ({ r, ms: performance.now() - t0 }));
    await new Promise((res) => setTimeout(res, 800));
    tha();
    await buocBat;
    const { r, ms } = await p;
    expect(ms).toBeGreaterThanOrEqual(700);
    expect(r).toMatchObject({ ok: false, lyDo: expect.stringMatching(/không có neo dư nợ/) });
    expect(await prisma.theTinDung.count()).toBe(0);
  });
});
