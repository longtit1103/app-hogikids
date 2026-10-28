import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Thùng rác cho NỢ PHẢI TRẢ trên DB thật (spec §5.7, §5.8; review focus #3): 3 hồ sơ mới (`TheTinDung`
 * kèm neo `KySaoKeThe`, `PhieuNhapNo`, `ViAdsTraTruoc`) chụp + dựng lại đúng id; dòng tiền kind mới khôi
 * phục qua ĐỦ cổng (đã bật, cửa sổ ngày, thẻ đóng); trả tiền hàng khôi phục được SAU khi phiếu huỷ (nợ âm
 * "cần thu hồi"); điều chỉnh mở sổ chỉ chủ shop. Dòng tiền kind cũ / thu nhập ngày < M và khoản thấu chi bắt đầu
 * < M không khôi phục được sau bật (đã chốt vào điều chỉnh mở sổ). M = 01/11/2026, hôm nay ghim 26/11/2026.
 */
vi.mock("@/lib/quyen/nguoi-dung-phien", async (goc) => ({
  ...(await goc<typeof import("@/lib/quyen/nguoi-dung-phien")>()),
  docNguoiDungPhien: vi.fn(),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import type { CashMovement, ThuNhap } from "@/generated/prisma/client";
import { createCashMovement, deleteCashMovement } from "@/lib/actions/cash-movements";
import { deleteExpense } from "@/lib/actions/expenses";
import { xoaPhieu } from "@/lib/actions/phieu-nhap-no";
import { taoThe, xoaThe } from "@/lib/actions/the-tin-dung";
import { KEY_NO_PHAI_TRA_TU_NGAY, KHOA_BAT_NO_PHAI_TRA } from "@/lib/no-phai-tra/cong-bat-no-phai-tra";
import { docDuNoCacThe } from "@/lib/no-phai-tra/du-no-the";
import { docPhieuTheoId } from "@/lib/no-phai-tra/phieu-nhap-no-queries";
import { prisma } from "@/lib/prisma";
import { docNguoiDungPhien } from "@/lib/quyen/nguoi-dung-phien";
import { chupVaoThungRac } from "@/lib/thung-rac/ghi-thung-rac";
import { khoiPhucBanGhiDaXoa } from "@/lib/thung-rac/khoi-phuc-ban-ghi";
import { anhDongTienGanSoQuy, LoiThieuQuyenThungRac, phamViThungRac } from "@/lib/thung-rac/quyen-thung-rac";
import { listThungRac } from "@/lib/thung-rac/thung-rac-queries";

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
    // Thẻ của bước bật: sao kê thật 25/10 (dòng (i)) + neo mở sổ 31/10 ⇒ neo ĐẦU TIÊN là 25/10, ngày 30/10 qua
    // cửa sổ neo thẻ. Hai luật chặn được nó: khoá sổ chi phí trước M (mọi Expense < M — đứng trước) và
    // "Expense.cardId ≥ M" (lưới thứ hai). Xoá TRƯỚC khi bật: sau bật, xoá dòng < M cũng bị khoá sổ chặn.
    const cardId = (await prisma.theTinDung.create({ data: { ten: "Thẻ M", ngayChotSaoKe: 25, ngayHanTra: 10 } })).id;
    await prisma.kySaoKeThe.create({ data: { cardId, ngayChot: vn("2026-10-25"), soDu: tr(4), hanTra: vn("2026-11-10") } });
    await prisma.kySaoKeThe.create({ data: { cardId, ngayChot: vn("2026-10-31"), soDu: tr(6), laNeoMoSo: true } });
    const e = await prisma.expense.create({
      data: { date: vn("2026-10-30"), categoryId: "other", amount: 300_000, description: "", source: "MANUAL", cardId },
    });
    expect(await deleteExpense(e.id, "only")).toEqual({ ok: true, data: undefined });
    await datM("2026-11-01");
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

describe("dòng tiền / thu nhập TRƯỚC M và thấu chi trước M — khôi phục sau bật (M = 01/11)", () => {
  const CAU_TRUOC_M = /Dòng tiền ngày 20\/10\/2026 trước ngày bật theo dõi nợ \(01\/11\/2026\) đã chốt vào số dư mở sổ/;

  it("góp vốn 05/11 (≥ M) xoá sau bật rồi khôi phục ⇒ được", async () => {
    await datM("2026-11-01");
    expect(
      await createCashMovement({ date: vn("2026-11-05"), kind: "CAPITAL_IN", amount: tr(10), description: "Góp vốn" }),
    ).toEqual({ ok: true, data: undefined });
    expect(await deleteCashMovement((await prisma.cashMovement.findFirstOrThrow()).id)).toEqual({ ok: true, data: undefined });
    expect(await khoiPhucBanGhiDaXoa((await mucThungRac("CashMovement")).id, CHU)).toEqual({ ok: true, canhBao: null });
    expect(await prisma.cashMovement.count()).toBe(1);
  });

  it("góp vốn 20/10 xoá TRƯỚC bật ⇒ sau bật khôi phục bị từ chối (con dấu tan), cột trạng thái cùng câu; gỡ M ⇒ khôi phục được", async () => {
    const dong = await prisma.cashMovement.create({
      data: { date: vn("2026-10-20"), kind: "CAPITAL_IN", amount: tr(10), description: "Góp vốn" },
    });
    expect(await deleteCashMovement(dong.id)).toEqual({ ok: true, data: undefined });
    const muc = await mucThungRac("CashMovement");
    await datM("2026-11-01");

    expect(await khoiPhucBanGhiDaXoa(muc.id, CHU)).toMatchObject({ ok: false, lyDo: expect.stringMatching(CAU_TRUOC_M) });
    expect(await prisma.cashMovement.count()).toBe(0);
    expect((await prisma.banGhiDaXoa.findUniqueOrThrow({ where: { id: muc.id } })).khoiPhucLuc).toBeNull();
    const { rows } = await listThungRac(phamViThungRac(CHU));
    expect(rows.find((r) => r.id === muc.id)?.lyDo).toMatch(CAU_TRUOC_M);

    await datM(null);
    expect(await khoiPhucBanGhiDaXoa(muc.id, CHU)).toEqual({ ok: true, canhBao: null });
    expect(await prisma.cashMovement.count()).toBe(1);
  });

  it("thu nhập (lãi tiết kiệm) 20/10 trong thùng rác ⇒ sau bật khôi phục bị từ chối", async () => {
    const tn = await prisma.thuNhap.create({
      data: { date: vn("2026-10-20"), kind: "LAI_TIET_KIEM", amount: 300_000, description: "Lãi" },
    });
    await prisma.$transaction(async (tx) => {
      await chupVaoThungRac(tx, { bang: "ThuNhap", banGhi: tn });
      await tx.thuNhap.delete({ where: { id: tn.id } });
    });
    await datM("2026-11-01");
    const r = await khoiPhucBanGhiDaXoa((await mucThungRac("ThuNhap")).id, CHU);
    expect(r).toMatchObject({ ok: false, lyDo: expect.stringMatching(CAU_TRUOC_M) });
    expect(await prisma.thuNhap.count()).toBe(0);
  });

  /** Sổ tiết kiệm vào thùng rác cùng các dòng tiền / thu nhập cho trước — đúng THỨ TỰ truyền vào. */
  async function soVaoThungRac(
    dong: { date: string; kind: "SAVINGS_OUT" | "SAVINGS_IN"; amount: number }[],
    thuNhap: string[] = [],
  ): Promise<string> {
    const so = await prisma.soTietKiem.create({
      data: {
        name: "Sổ R",
        bank: "VCB",
        principal: tr(50),
        startDate: vn("2026-10-20"),
        termMonths: 6,
        maturityDate: vn("2027-04-20"),
        annualRateBp: 520,
      },
    });
    const cms: CashMovement[] = [];
    for (const d of dong) {
      cms.push(await prisma.cashMovement.create({ data: { ...d, date: vn(d.date), description: "", savingsId: so.id } }));
    }
    const tns: ThuNhap[] = [];
    for (const ngay of thuNhap) {
      tns.push(
        await prisma.thuNhap.create({
          data: { date: vn(ngay), kind: "LAI_TIET_KIEM", amount: 100_000, description: "", savingsId: so.id },
        }),
      );
    }
    await prisma.$transaction(async (tx) => {
      await chupVaoThungRac(tx, { bang: "SoTietKiem", banGhi: so, cashMovements: cms, thuNhap: tns });
      await tx.thuNhap.deleteMany({ where: { savingsId: so.id } });
      await tx.cashMovement.deleteMany({ where: { savingsId: so.id } });
      await tx.soTietKiem.delete({ where: { id: so.id } });
    });
    // Theo `banGhiId`: đồng hồ `Date` bị ghim nên hai mục cùng `xoaLuc`, "mới nhất" không phân biệt được.
    return (await prisma.banGhiDaXoa.findFirstOrThrow({ where: { bang: "SoTietKiem", banGhiId: so.id } })).id;
  }

  it("cụm sổ tiết kiệm: dòng < M nằm SAU dòng ≥ M trong ảnh vẫn bị bắt ⇒ từ chối cả cụm", async () => {
    const mucId = await soVaoThungRac([
      { date: "2026-11-05", kind: "SAVINGS_IN", amount: tr(1) },
      { date: "2026-10-20", kind: "SAVINGS_OUT", amount: tr(50) },
    ]);
    await datM("2026-11-01");
    expect(await khoiPhucBanGhiDaXoa(mucId, CHU)).toMatchObject({ ok: false, lyDo: expect.stringMatching(CAU_TRUOC_M) });
    expect(await prisma.soTietKiem.count()).toBe(0);
    expect(await prisma.cashMovement.count()).toBe(0);
  });

  it("cụm sổ tiết kiệm: dòng tiền ≥ M nhưng thu nhập kèm theo 20/10 ⇒ từ chối; toàn bộ ≥ M ⇒ được", async () => {
    const coThuNhapTruocM = await soVaoThungRac([{ date: "2026-11-05", kind: "SAVINGS_OUT", amount: tr(50) }], ["2026-10-20"]);
    await datM("2026-11-01");
    expect(await khoiPhucBanGhiDaXoa(coThuNhapTruocM, CHU)).toMatchObject({ ok: false, lyDo: expect.stringMatching(CAU_TRUOC_M) });

    await datM(null);
    const hopLe = await soVaoThungRac([{ date: "2026-11-05", kind: "SAVINGS_OUT", amount: tr(50) }]);
    await datM("2026-11-01");
    expect(await khoiPhucBanGhiDaXoa(hopLe, CHU)).toEqual({ ok: true, canhBao: null });
    expect(await prisma.cashMovement.count()).toBe(1);
  });

  /** Khoản vay không dòng tiền (mang sang) vào thùng rác. */
  async function khoanVayVaoThungRac(data: Record<string, unknown>): Promise<string> {
    const loan = await prisma.loan.create({
      data: { name: "Vay R", startDate: vn("2026-10-20"), duNoMoSo: tr(30), ...data },
    });
    await prisma.$transaction(async (tx) => {
      await chupVaoThungRac(tx, { bang: "Loan", banGhi: loan, cashMovements: [] });
      await tx.loan.delete({ where: { id: loan.id } });
    });
    return (await prisma.banGhiDaXoa.findFirstOrThrow({ where: { bang: "Loan", banGhiId: loan.id } })).id;
  }

  it("khoản vay thường mang sang bắt đầu 20/10 (không dòng tiền) ⇒ khôi phục được sau bật", async () => {
    const mucId = await khoanVayVaoThungRac({ kind: "TERM", termMonths: 12, firstDueDate: vn("2026-11-20") });
    await datM("2026-11-01");
    expect(await khoiPhucBanGhiDaXoa(mucId, CHU)).toEqual({ ok: true, canhBao: null });
    expect(await prisma.loan.count()).toBe(1);
  });

  it("thấu chi bắt đầu 20/10 (mang sang, không dòng tiền) ⇒ sau bật từ chối; chưa bật được; thấu chi bắt đầu 05/11 ⇒ được", async () => {
    const truocM = await khoanVayVaoThungRac({ kind: "OVERDRAFT" });
    await datM("2026-11-01");
    expect(await khoiPhucBanGhiDaXoa(truocM, CHU)).toMatchObject({
      ok: false,
      lyDo: expect.stringMatching(/Khoản thấu chi bắt đầu 20\/10\/2026 trước ngày bật theo dõi nợ \(01\/11\/2026\)/),
    });
    expect(await prisma.loan.count()).toBe(0);
    const { rows } = await listThungRac(phamViThungRac(CHU));
    expect(rows.find((r) => r.id === truocM)?.lyDo).toMatch(/Khoản thấu chi bắt đầu 20\/10\/2026/);

    await datM(null);
    expect(await khoiPhucBanGhiDaXoa(truocM, CHU)).toEqual({ ok: true, canhBao: null });

    const sauM = await khoanVayVaoThungRac({ kind: "OVERDRAFT", startDate: vn("2026-11-05") });
    await datM("2026-11-01");
    expect(await khoiPhucBanGhiDaXoa(sauM, CHU)).toEqual({ ok: true, canhBao: null });
    expect(await prisma.loan.count()).toBe(2);
  });

  it("khôi phục góp vốn 20/10 giữa lúc bước bật đang giữ khoá ⇒ CHỜ bước bật commit rồi bị từ chối", async () => {
    const dong = await prisma.cashMovement.create({
      data: { date: vn("2026-10-20"), kind: "CAPITAL_IN", amount: tr(10), description: "Góp vốn" },
    });
    await deleteCashMovement(dong.id);
    const mucId = (await mucThungRac("CashMovement")).id;
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
    expect(r).toMatchObject({ ok: false, lyDo: expect.stringMatching(CAU_TRUOC_M) });
    expect(await prisma.cashMovement.count()).toBe(0);
  });
});

/**
 * Thẻ ĐÃ ĐÓNG còn nợ (ads về muộn gán thẻ theo đúng lịch sử mốc gắn): lối DUY NHẤT tất toán phần nợ đó là `CARD_PAY`
 * vào chính thẻ — nhập tay đã cho (nợ > 0, ngày sau neo đang dùng). Khôi phục thùng rác là cùng một đường ghi tiền
 * nên phải theo đúng luật ấy: cổng tổng quát "cha đã tất toán" KHÔNG được chặn trước `CARD_PAY`, còn khoản chi trừ
 * thẻ / nạp ví bằng thẻ vào thẻ đóng thì vẫn chặn. M = 01/11, hôm nay 26/11; thẻ neo 01/11 = 0, chi 500.000 ngày
 * 10/11, đóng 20/11.
 */
describe("khôi phục trả thẻ vào thẻ ĐÃ ĐÓNG còn nợ", () => {
  const NO = 500_000;

  async function theDongConNo(): Promise<string> {
    await datM("2026-11-01");
    const tao = await taoThe({ ten: "Thẻ Đ", ngayChotSaoKe: 25, ngayHanTra: 10, neoBanDau: { ngayChot: "2026-11-01", soDu: 0 } });
    const cardId = (tao as { data: { id: string } }).data.id;
    await prisma.expense.create({
      data: { date: vn("2026-11-10"), categoryId: "other", amount: NO, description: "ads về muộn", source: "MANUAL", cardId },
    });
    await prisma.theTinDung.update({ where: { id: cardId }, data: { closedAt: vn("2026-11-20") } });
    return cardId;
  }
  const duNoThe = async (cardId: string) => (await docDuNoCacThe(vn("2026-11-26"))).find((d) => d.cardId === cardId)?.duNo;

  /** Trả 500.000 vào thẻ đóng (được phép) rồi xoá ⇒ mục thùng rác. */
  async function traRoiXoa(cardId: string, ngay = "2026-11-22"): Promise<string> {
    expect(await createCashMovement({ date: vn(ngay), kind: "CARD_PAY", amount: NO, description: "", cardId })).toEqual({
      ok: true,
      data: undefined,
    });
    expect(await duNoThe(cardId)).toBe(0);
    const dong = await prisma.cashMovement.findFirstOrThrow({ where: { cardId, kind: "CARD_PAY" } });
    expect(await deleteCashMovement(dong.id)).toEqual({ ok: true, data: undefined });
    expect(await duNoThe(cardId)).toBe(NO);
    return (await mucThungRac("CashMovement")).id;
  }

  it("còn nợ 500.000, ngày trả sau neo ⇒ cột trạng thái 'khôi phục được', khôi phục OK, dư nợ về 0", async () => {
    const cardId = await theDongConNo();
    const mucId = await traRoiXoa(cardId);
    const { rows } = await listThungRac(phamViThungRac(CHU));
    expect(rows.find((r) => r.id === mucId)?.lyDo).toBeNull();
    expect(await khoiPhucBanGhiDaXoa(mucId, CHU)).toEqual({ ok: true, canhBao: null });
    expect(await prisma.cashMovement.count({ where: { cardId, kind: "CARD_PAY" } })).toBe(1);
    expect(await duNoThe(cardId)).toBe(0);
  });

  it("thẻ đóng đã hết nợ (lần trả khác đã ghi) ⇒ vẫn từ chối, không ghi", async () => {
    const cardId = await theDongConNo();
    const mucId = await traRoiXoa(cardId);
    await createCashMovement({ date: vn("2026-11-23"), kind: "CARD_PAY", amount: NO, description: "", cardId });
    expect(await duNoThe(cardId)).toBe(0);
    const r = await khoiPhucBanGhiDaXoa(mucId, CHU);
    expect(r).toMatchObject({ ok: false, lyDo: expect.stringMatching(/đã đóng và không còn nợ/) });
    expect(await prisma.cashMovement.count({ where: { cardId, kind: "CARD_PAY" } })).toBe(1);
    expect((await prisma.banGhiDaXoa.findUniqueOrThrow({ where: { id: mucId } })).khoiPhucLuc).toBeNull();
  });

  it("ngày trả ≤ ngày chốt sao kê đang dùng (sao kê 25/11 chốt sau khi xoá) ⇒ từ chối", async () => {
    const cardId = await theDongConNo();
    const mucId = await traRoiXoa(cardId, "2026-11-22");
    await prisma.kySaoKeThe.create({ data: { cardId, ngayChot: vn("2026-11-25"), soDu: NO, hanTra: vn("2026-12-10") } });
    const r = await khoiPhucBanGhiDaXoa(mucId, CHU);
    expect(r).toMatchObject({ ok: false, lyDo: expect.stringMatching(/ngày trả phải sau ngày chốt sao kê gần nhất/) });
    expect(await prisma.cashMovement.count({ where: { cardId, kind: "CARD_PAY" } })).toBe(0);
  });

  it("khoản chi trừ thẻ / nạp ví bằng thẻ vào thẻ đóng ⇒ vẫn chặn 'thẻ đã đóng'", async () => {
    const cardId = await theDongConNo();
    const e = await prisma.expense.create({
      data: { date: vn("2026-11-12"), categoryId: "other", amount: 100_000, description: "", source: "MANUAL", cardId },
    });
    await prisma.$transaction(async (tx) => {
      await chupVaoThungRac(tx, { bang: "Expense", banGhi: e, tenDanhMuc: "Khác" });
      await tx.expense.delete({ where: { id: e.id } });
    });
    const mucChi = await mucThungRac("Expense");
    expect(await khoiPhucBanGhiDaXoa(mucChi.id, CHU)).toMatchObject({
      ok: false,
      lyDo: "Thẻ tín dụng đã đóng — không khôi phục dòng tiền / khoản chi vào thẻ đã đóng",
    });

    const viAdsId = (
      await prisma.viAdsTraTruoc.create({ data: { nenTang: "SHOPEE_ADS", soDuNeo: 0, ngayNeo: vn("2026-11-01", "23:59:59") } })
    ).id;
    const nap = await prisma.cashMovement.create({
      data: { date: vn("2026-11-05"), kind: "ADS_TOPUP", amount: 200_000, description: "", viAdsId, cardId },
    });
    await prisma.$transaction(async (tx) => {
      await chupVaoThungRac(tx, { bang: "CashMovement", banGhi: nap });
      await tx.cashMovement.delete({ where: { id: nap.id } });
    });
    const mucNap = await mucThungRac("CashMovement");
    expect(await khoiPhucBanGhiDaXoa(mucNap.id, CHU)).toMatchObject({
      ok: false,
      lyDo: "Thẻ tín dụng đã đóng — không khôi phục dòng tiền / khoản chi vào thẻ đã đóng",
    });
    expect(await prisma.expense.count({ where: { id: e.id } })).toBe(0);
    expect(await prisma.cashMovement.count({ where: { kind: "ADS_TOPUP" } })).toBe(0);
  });
});
