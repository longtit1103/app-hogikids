import { randomUUID } from "node:crypto";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Điều kiện bật về TIỀN TRƯỚC NGÀY BẬT trên DB thật — mỗi mã: có ⇒ bước bật từ chối, không ghi gì; dọn đúng
 * cách ⇒ hết mã, bật được. M = 01/11/2026, hôm nay ghim 03/11/2026 10:00 VN; quỹ mở sổ 10/10 (150tr).
 */
vi.mock("@/lib/quyen/nguoi-dung-phien", async (goc) => ({
  ...(await goc<typeof import("@/lib/quyen/nguoi-dung-phien")>()),
  docNguoiDungPhien: vi.fn(),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { xacNhanBatNoPhaiTra } from "@/lib/actions/bat-no-phai-tra";
import { tatToanKhoanVay } from "@/lib/actions/khoan-vay";
import { ensureRecurringExpensesForMonths } from "@/lib/expenses/ensure-recurring-expenses";
import { KEY_NO_PHAI_TRA_TU_NGAY } from "@/lib/no-phai-tra/cong-bat-no-phai-tra";
import { kiemDieuKienBat, type MaDieuKienBat } from "@/lib/no-phai-tra/dieu-kien-bat-no-phai-tra";
import { docNhacTruocBat } from "@/lib/no-phai-tra/dieu-kien-bat-truoc-m";
import { docVanTayQuyTruocM } from "@/lib/no-phai-tra/doc-chenh-lech-tai-m";
import { prisma } from "@/lib/prisma";
import { docNguoiDungPhien } from "@/lib/quyen/nguoi-dung-phien";

import { nguoiDungGia } from "../../helpers/nguoi-dung-gia";
import { seedReference, truncateBusinessTables } from "../../helpers/test-db";

const vn = (ngay: string, gio = "00:00:00") => new Date(`${ngay}T${gio}+07:00`);
const tr = (n: number) => Math.round(n * 1_000_000);
const M = vn("2026-11-01");

beforeAll(async () => {
  await seedReference();
}, 60_000);

beforeEach(async () => {
  await truncateBusinessTables();
  await prisma.setting.deleteMany({ where: { key: KEY_NO_PHAI_TRA_TU_NGAY } });
  vi.mocked(docNguoiDungPhien).mockResolvedValue(nguoiDungGia());
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(vn("2026-11-03", "10:00:00"));
  await prisma.cashMovement.create({
    data: { date: vn("2026-10-10"), kind: "CAPITAL_IN", amount: tr(150), description: "mở sổ" },
  });
});

afterEach(async () => {
  vi.useRealTimers();
  await prisma.setting.deleteMany({ where: { key: KEY_NO_PHAI_TRA_TU_NGAY } });
});

afterAll(async () => {
  await truncateBusinessTables();
  await prisma.$disconnect();
});

const loiCo = async (code: MaDieuKienBat) => (await kiemDieuKienBat({ mocM: M })).find((l) => l.code === code);

/** Bấm bật như màn hình (vân tay đọc ngay trước khi bấm). Không thẻ, không ví, không điều chỉnh. */
const bat = async () =>
  xacNhanBatNoPhaiTra({
    yeuCauId: randomUUID(),
    mocM: "2026-11-01",
    the: [],
    viAds: [],
    dieuChinh: [],
    vanTayQuy: await docVanTayQuyTruocM(M),
  });

/** Bị từ chối thì không có gì được ghi. */
async function khongGhiGi(): Promise<void> {
  expect(await prisma.setting.findUnique({ where: { key: KEY_NO_PHAI_TRA_TU_NGAY } })).toBeNull();
  expect(await prisma.yeuCauGhi.count()).toBe(0);
  expect(await prisma.cashMovement.count({ where: { kind: { in: ["CUTOVER_ADJ_IN", "CUTOVER_ADJ_OUT"] } } })).toBe(0);
}

describe("CON_KY_VAY_TRUOC_M", () => {
  const vayKyHan = (ghiDe: Record<string, unknown> = {}) =>
    prisma.loan.create({
      data: {
        name: "Vay VPBank",
        kind: "TERM",
        duNoMoSo: tr(120),
        startDate: vn("2026-09-01"),
        firstDueDate: vn("2026-10-01"),
        termMonths: 12,
        annualRateBp: 1000,
        ...ghiDe,
      },
    });

  it("kỳ 15/10 (từ ngày mở sổ) chưa duyệt ⇒ chặn, liệt kê khoản + kỳ, câu chỉ đúng hai lối; đóng dấu kỳ ⇒ hết (kỳ 15/11 sau ngày bật không tính)", async () => {
    const v = await vayKyHan({ firstDueDate: vn("2026-10-15") });
    const loi = await loiCo("CON_KY_VAY_TRUOC_M");
    expect(loi?.kyVayTruocM).toEqual([{ loanId: v.id, ten: "Vay VPBank", khoaNgayKy: "2026-10-15" }]);
    expect(loi?.message).toContain('Khoản "Vay VPBank" còn kỳ 15/10/2026 chưa duyệt');
    expect(loi?.message).toContain("từ ngày mở sổ 10/10/2026 tới trước ngày bật 01/11/2026");
    expect(loi?.message).toContain("duyệt kỳ (ghi ĐÚNG số tiền đã trả)");
    expect(loi?.message).toContain("Ngân hàng không thu kỳ này");
    const r = await bat();
    expect(r).toMatchObject({ ok: false, code: "CON_KY_VAY_TRUOC_M" });
    await khongGhiGi();

    await prisma.loan.update({ where: { id: v.id }, data: { lastDueHandled: vn("2026-10-15") } });
    expect(await loiCo("CON_KY_VAY_TRUOC_M")).toBeUndefined();
    expect(await bat()).toMatchObject({ ok: true });
  });

  it("kỳ đúng NGÀY mở sổ (10/10) ⇒ chặn", async () => {
    await vayKyHan({ firstDueDate: vn("2026-10-10") });
    expect((await loiCo("CON_KY_VAY_TRUOC_M"))?.kyVayTruocM?.map((k) => k.khoaNgayKy)).toEqual(["2026-10-10"]);
  });

  it("kỳ TRƯỚC ngày mở sổ (01/10 < 10/10) chưa duyệt ⇒ KHÔNG chặn — tiền kỳ đó đã nằm trong số dư mở sổ; bật được", async () => {
    await vayKyHan({ firstDueDate: vn("2026-10-01") });
    expect(await loiCo("CON_KY_VAY_TRUOC_M")).toBeUndefined();
    expect(await bat()).toMatchObject({ ok: true });
  });

  it("kỳ trước ngày mở sổ còn treo + kỳ sau ngày mở sổ chưa duyệt ⇒ chặn, nêu kỳ từ ngày mở sổ, dặn 'không thu' cho kỳ cũ", async () => {
    // Mở sổ lùi về 15/09 ⇒ kỳ 01/09 nằm trước, kỳ 01/10 nằm trong [ngày mở sổ, ngày bật).
    await prisma.cashMovement.create({
      data: { date: vn("2026-09-15"), kind: "CAPITAL_IN", amount: tr(1), description: "mở sổ sớm" },
    });
    const v = await vayKyHan({ startDate: vn("2026-08-01"), firstDueDate: vn("2026-09-01") });
    const loi = await loiCo("CON_KY_VAY_TRUOC_M");
    expect(loi?.kyVayTruocM).toEqual([{ loanId: v.id, ten: "Vay VPBank", khoaNgayKy: "2026-10-01" }]);
    expect(loi?.message).toContain("kỳ TRƯỚC ngày mở sổ");
  });

  it("chưa mở sổ (không có dòng tiền nào) ⇒ không kỳ nào thuộc quỹ ⇒ không chặn", async () => {
    await prisma.cashMovement.deleteMany();
    await vayKyHan({ firstDueDate: vn("2026-10-15") });
    expect(await loiCo("CON_KY_VAY_TRUOC_M")).toBeUndefined();
  });

  it("kỳ đầu đúng ngày bật, khoản đã tất toán, khoản không lịch ⇒ không chặn", async () => {
    await vayKyHan({ firstDueDate: vn("2026-11-01") });
    await vayKyHan({ name: "Đã tất toán", closedAt: vn("2026-10-20") });
    await prisma.loan.create({ data: { name: "Vay người thân", duNoMoSo: tr(50), startDate: vn("2026-09-01") } });
    expect(await loiCo("CON_KY_VAY_TRUOC_M")).toBeUndefined();
  });

  it("gốc cuối kỳ (lãi cố định) và thấu chi có ngày thu lãi tháng ⇒ cùng luật", async () => {
    const bullet = await vayKyHan({ name: "Vay chính sách", kind: "BULLET", laiCoDinhMoiKy: 300_000, firstDueDate: vn("2026-10-25") });
    const od = await prisma.loan.create({
      data: { name: "Thấu chi", kind: "OVERDRAFT", startDate: vn("2026-10-01"), firstDueDate: vn("2026-10-15"), annualRateBp: 1200 },
    });
    await prisma.cashMovement.create({
      data: { date: vn("2026-10-12"), kind: "LOAN_IN", amount: tr(10), loanId: od.id, description: "rút thấu chi" },
    });
    // Thấu chi KHÔNG có ngày thu lãi tháng ⇒ không có kỳ.
    await prisma.loan.create({ data: { name: "Thấu chi 2", kind: "OVERDRAFT", startDate: vn("2026-10-01"), annualRateBp: 1200 } });
    const loi = await loiCo("CON_KY_VAY_TRUOC_M");
    expect(loi?.kyVayTruocM?.map((k) => [k.ten, k.khoaNgayKy]).sort()).toEqual([
      ["Thấu chi", "2026-10-15"],
      ["Vay chính sách", "2026-10-25"],
    ]);
    expect(loi?.kyVayTruocM?.map((k) => k.loanId).sort()).toEqual([bullet.id, od.id].sort());
  });
});

describe("CON_TIEN_GUI_CHUA_TAT_TOAN_TRUOC_M", () => {
  /**
   * Khoản trả gốc cuối kỳ mang sang (dư nợ 100tr), kỳ cuối mặc định 25/10 < M; gửi bắt buộc 3,6tr ngày 12/10; kỳ
   * cuối đã duyệt (con dấu 25/10). Tham số: ngày trả gốc + kỳ đầu (đổi kỳ cuối).
   */
  async function vayGocCuoiKy(p: { ngayTraGoc: string; firstDueDate?: string } = { ngayTraGoc: "2026-10-25" }) {
    const firstDueDate = vn(p.firstDueDate ?? "2025-12-25");
    const v = await prisma.loan.create({
      data: {
        name: "Vay chính sách",
        kind: "BULLET",
        duNoMoSo: tr(100),
        startDate: vn("2025-11-25"),
        firstDueDate,
        termMonths: 11,
        annualRateBp: 0,
        laiCoDinhMoiKy: 300_000,
        tienGuiBatBuocMoiKy: 300_000,
        lastDueHandled: vn("2026-10-25"),
      },
    });
    await prisma.cashMovement.createMany({
      data: [
        { date: vn("2026-10-12"), kind: "DEPOSIT_OUT", amount: tr(3.6), loanId: v.id, description: "Gửi bắt buộc" },
        { date: vn(p.ngayTraGoc), kind: "LOAN_REPAY", amount: tr(100), loanId: v.id, description: "Trả gốc" },
      ],
    });
    return v;
  }

  it("trả hết gốc 25/10, kỳ cuối 25/10 < M, còn tiền gửi 3,6tr ⇒ chặn; tất toán đúng ngày ngân hàng cấn trừ ⇒ hết, bật được", async () => {
    const v = await vayGocCuoiKy();
    const loi = await loiCo("CON_TIEN_GUI_CHUA_TAT_TOAN_TRUOC_M");
    expect(loi?.message).toContain('"Vay chính sách" (kỳ cuối 25/10/2026, tiền gửi 3.600.000');
    expect(loi?.message).toContain("TRƯỚC khi bật");
    expect(loi?.message).toContain("đếm tiền gửi hai lần");
    expect(await bat()).toMatchObject({ ok: false, code: "CON_TIEN_GUI_CHUA_TAT_TOAN_TRUOC_M" });
    await khongGhiGi();

    expect(await tatToanKhoanVay(v.id, { ngayTatToan: "2026-10-25" })).toMatchObject({ ok: true });
    expect(await loiCo("CON_TIEN_GUI_CHUA_TAT_TOAN_TRUOC_M")).toBeUndefined();
    expect(await bat()).toMatchObject({ ok: true });
  });

  it("gốc trả từ ngày bật (dư nợ cuối 31/10 > 0) ⇒ không chặn — ngân hàng hoàn tiền gửi từ ngày bật, tất toán sau bật là đúng", async () => {
    await vayGocCuoiKy({ ngayTraGoc: "2026-11-02" });
    expect(await loiCo("CON_TIEN_GUI_CHUA_TAT_TOAN_TRUOC_M")).toBeUndefined();
  });

  it("trả gốc sớm nhưng kỳ cuối từ ngày bật trở đi (25/11) ⇒ không chặn", async () => {
    await vayGocCuoiKy({ ngayTraGoc: "2026-10-25", firstDueDate: "2026-01-25" });
    expect(await loiCo("CON_TIEN_GUI_CHUA_TAT_TOAN_TRUOC_M")).toBeUndefined();
  });

  it("khoản không có tiền gửi đang giữ ⇒ không chặn", async () => {
    const v = await vayGocCuoiKy();
    await prisma.cashMovement.create({
      data: { date: vn("2026-10-25"), kind: "DEPOSIT_IN", amount: tr(3.6), loanId: v.id, description: "Hoàn tiền gửi" },
    });
    expect(await loiCo("CON_TIEN_GUI_CHUA_TAT_TOAN_TRUOC_M")).toBeUndefined();
  });
});

describe("CON_DINH_KY_CHUA_GHI_TRUOC_M", () => {
  it("mẫu đến hạn 15/10 chưa sinh ⇒ chặn kèm khoảng tháng; mở Sổ chi phí tháng 10 (bộ sinh ghi bù) ⇒ hết", async () => {
    await prisma.recurringExpense.create({
      data: { categoryId: "fixed", amount: tr(8), dayOfMonth: 15, description: "Tiền nhà", active: true },
    });
    const loi = await loiCo("CON_DINH_KY_CHUA_GHI_TRUOC_M");
    expect(loi?.dinhKyTruocM).toEqual({ soKhoan: 1, thang: ["10/2026"], khoaTu: "2026-10-01", khoaDen: "2026-10-31" });
    expect(loi?.message).toContain("tháng 10/2026");
    // Lối thoát khi tháng đó cố ý không chi: mở tháng sẽ sinh lại dòng đã xoá ⇒ dừng mẫu / đặt lại tháng bắt đầu.
    expect(loi?.message).toContain("mở là app sinh lại đúng dòng đã xoá");
    expect(loi?.message).toContain("dừng mẫu định kỳ đó");
    const r = await bat();
    expect(r).toMatchObject({ ok: false, code: "CON_DINH_KY_CHUA_GHI_TRUOC_M" });
    await khongGhiGi();

    expect(await ensureRecurringExpensesForMonths([vn("2026-10-01")])).toBe(1);
    expect(await loiCo("CON_DINH_KY_CHUA_GHI_TRUOC_M")).toBeUndefined();
    expect(await bat()).toMatchObject({ ok: true });
  });

  it("đến hạn đúng ngày bật, trước ngày mở sổ, mẫu đã dừng ⇒ không chặn", async () => {
    await prisma.recurringExpense.createMany({
      data: [
        { categoryId: "fixed", amount: tr(1), dayOfMonth: 1, description: "Đến hạn 01/11", active: true },
        { categoryId: "fixed", amount: tr(1), dayOfMonth: 5, description: "05/10 trước mở sổ", active: true, activeFrom: vn("2026-10-01") },
        { categoryId: "fixed", amount: tr(1), dayOfMonth: 20, description: "Đã dừng", active: false },
      ],
    });
    // Mẫu ngày 1 có lần 01/10 — trước ngày mở sổ 10/10 ⇒ không thuộc quỹ.
    expect(await loiCo("CON_DINH_KY_CHUA_GHI_TRUOC_M")).toBeUndefined();
  });
});

describe("CON_SO_TIET_KIEM_DAO_HAN_TRUOC_M", () => {
  const so = (ghiDe: Record<string, unknown> = {}) =>
    prisma.soTietKiem.create({
      data: {
        name: "Sổ 3 tháng",
        bank: "VCB",
        principal: tr(50),
        startDate: vn("2026-07-30"),
        termMonths: 3,
        maturityDate: vn("2026-10-30"),
        annualRateBp: 520,
        ...ghiDe,
      },
    });

  it("sổ đáo hạn 30/10 chưa tất toán ⇒ chặn; tất toán ⇒ hết", async () => {
    const s = await so();
    const loi = await loiCo("CON_SO_TIET_KIEM_DAO_HAN_TRUOC_M");
    expect(loi?.message).toContain('"Sổ 3 tháng" (VCB) đáo hạn 30/10/2026');
    expect(loi?.message).toContain("sửa ngày đáo hạn nếu ngân hàng THẬT SỰ tự gia hạn");
    expect(await bat()).toMatchObject({ ok: false, code: "CON_SO_TIET_KIEM_DAO_HAN_TRUOC_M" });
    await khongGhiGi();

    await prisma.soTietKiem.update({ where: { id: s.id }, data: { closedAt: vn("2026-10-30") } });
    expect(await loiCo("CON_SO_TIET_KIEM_DAO_HAN_TRUOC_M")).toBeUndefined();
  });

  it("đáo hạn đúng ngày bật hoặc sau ⇒ không chặn", async () => {
    await so({ maturityDate: vn("2026-11-01") });
    await so({ name: "Sổ 6 tháng", maturityDate: vn("2027-01-30"), termMonths: 6 });
    expect(await loiCo("CON_SO_TIET_KIEM_DAO_HAN_TRUOC_M")).toBeUndefined();
  });
});

describe("CON_LAI_NHAP_GOC_CHUA_CAP_TRUOC_M", () => {
  /** Thấu chi mang sang (rút trước ngày mở sổ), không lịch kỳ — chỉ để có khoản mang cờ lãi nhập gốc. */
  const thauChi = (ghiDe: Record<string, unknown> = {}) =>
    prisma.loan.create({
      data: {
        name: "Vay thấu chi",
        kind: "OVERDRAFT",
        duNoMoSo: tr(100),
        startDate: vn("2026-09-10"),
        annualRateBp: 1175,
        laiNhapGoc: true,
        ...ghiDe,
      },
    });
  const dongLai = (loanId: string, ngay: string, amount: number) =>
    prisma.expense.create({
      data: {
        date: vn(ngay),
        categoryId: "interest",
        amount,
        description: "Lãi vay — kỳ",
        source: "MANUAL",
        refId: `LOAN:${loanId}:${ngay}`,
      },
    });
  const nhapGoc = (loanId: string, ngay: string, amount: number) =>
    prisma.cashMovement.create({
      data: { date: vn(ngay), kind: "LAI_NHAP_GOC", amount, loanId, description: "Lãi nhập gốc" },
    });

  it("kỳ 20/10 (∈ [mở sổ, ngày bật)) duyệt kiểu trừ tài khoản ⇒ chặn, nêu khoản + kỳ + số tiền + cách xử lý; thêm dòng nhập gốc ⇒ hết, bật được", async () => {
    const v = await thauChi();
    await dongLai(v.id, "2026-10-20", 643_836);
    const loi = await loiCo("CON_LAI_NHAP_GOC_CHUA_CAP_TRUOC_M");
    expect(loi?.message).toContain('khoản "Vay thấu chi" kỳ 20/10/2026 lãi 643.836');
    expect(loi?.message).toContain("chuyển kỳ đó sang lãi nhập gốc trước khi bật");
    expect(await bat()).toMatchObject({ ok: false, code: "CON_LAI_NHAP_GOC_CHUA_CAP_TRUOC_M" });
    await khongGhiGi();

    await nhapGoc(v.id, "2026-10-20", 643_836);
    expect(await loiCo("CON_LAI_NHAP_GOC_CHUA_CAP_TRUOC_M")).toBeUndefined();
    expect(await bat()).toMatchObject({ ok: true });
  });

  it("chỉ nêu kỳ thiếu cặp: kỳ đã có cặp không nêu, kỳ thiếu cặp nêu", async () => {
    const v = await thauChi();
    await dongLai(v.id, "2026-10-15", 500_000);
    await nhapGoc(v.id, "2026-10-15", 500_000);
    await dongLai(v.id, "2026-10-25", 300_000);
    const loi = await loiCo("CON_LAI_NHAP_GOC_CHUA_CAP_TRUOC_M");
    expect(loi?.message).toContain("kỳ 25/10/2026 lãi 300.000");
    expect(loi?.message).not.toContain("15/10/2026");
  });

  it("không chặn: kỳ trước ngày mở sổ, kỳ từ ngày bật, khoản không lãi nhập gốc, khoản đã tất toán", async () => {
    const v = await thauChi();
    await dongLai(v.id, "2026-10-01", 643_836);
    await dongLai(v.id, "2026-11-01", 1_000_000);
    const thuong = await thauChi({ name: "Thấu chi thường", laiNhapGoc: false });
    await dongLai(thuong.id, "2026-10-20", 200_000);
    const daDong = await thauChi({ name: "Thấu chi đã tất toán", closedAt: vn("2026-10-28") });
    await dongLai(daDong.id, "2026-10-20", 100_000);
    expect(await loiCo("CON_LAI_NHAP_GOC_CHUA_CAP_TRUOC_M")).toBeUndefined();
  });
});

describe("ví Shopee chưa phủ tới ngày bật — nhắc, KHÔNG chặn", () => {
  const giaoDichVi = (id: string, ngay: Date) =>
    prisma.shopeeSettlement.create({
      data: { externalId: id, shopId: "shopee", txnTime: ngay, type: "REVENUE", amount: 100_000, status: "OK", runningBalance: 0 },
    });
  const donShopee = (id: string, ngay: Date) =>
    prisma.order.create({
      data: { pancakeId: id, code: id, channelId: "shopee", status: "COMPLETED", orderedAt: ngay, syncedAt: ngay },
    });
  const nhac = () => docNhacTruocBat(M, prisma);
  const khongChan = async () =>
    expect((await kiemDieuKienBat({ mocM: M })).map((l) => l.code as string)).not.toContain("VI_SHOPEE_CHUA_PHU_TOI_M");

  it("ví mới tới 28/10 ⇒ có nhắc đúng câu, vẫn BẬT ĐƯỢC; ví phủ tới ngày bật ⇒ hết nhắc", async () => {
    await giaoDichVi("v1", vn("2026-10-28", "15:00:00"));
    const [n] = await nhac();
    expect(n?.code).toBe("VI_SHOPEE_CHUA_PHU_TOI_M");
    expect(n?.message).toContain("Dữ liệu ví Shopee mới tới 28/10 — không chặn bật.");
    expect(n?.message).toContain("mục 'Trôi quỹ trước ngày bật' sẽ hiện chênh");
    expect(n?.message).toContain("sửa dòng điều chỉnh mở sổ cho khớp");
    await khongChan();
    expect(await bat()).toMatchObject({ ok: true });
    expect(await prisma.setting.findUnique({ where: { key: KEY_NO_PHAI_TRA_TU_NGAY } })).not.toBeNull();
  });

  it("giao dịch 31/10 23:30 VN vẫn là ngày trước ngày bật ⇒ còn nhắc; giao dịch từ ngày bật ⇒ hết", async () => {
    await giaoDichVi("v2", vn("2026-10-31", "23:30:00"));
    expect(await nhac()).toHaveLength(1);
    await giaoDichVi("v3", vn("2026-11-01", "08:00:00"));
    expect(await nhac()).toEqual([]);
  });

  it("chưa từng import ví: có đơn Shopee trước ngày bật ⇒ nhắc (không chặn); chỉ đơn từ ngày bật hoặc không đơn ⇒ không nhắc", async () => {
    expect(await nhac()).toEqual([]);
    await donShopee("SP-SAU", vn("2026-11-01", "09:00:00"));
    expect(await nhac()).toEqual([]);
    await donShopee("SP-TRUOC", vn("2026-10-20"));
    const [n] = await nhac();
    expect(n?.message).toContain("Chưa import dữ liệu ví Shopee nào");
    await khongChan();
    expect(await bat()).toMatchObject({ ok: true });
  });
});
