import { randomUUID } from "node:crypto";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Lối "Sửa số tiền trước mốc" trên DB thật (`hogikids_test`). Bất biến cần giữ sau khi bật nợ phải trả:
 * `Q(M−1) + Σ CUTOVER_net = hằng số` — quỹ app cuối M−1 (`docSoLieuTruocM`, cùng hàm bước bật dùng) cộng điều chỉnh
 * mở sổ là tiền thật đầu ngày M. Đổi số tiền một dòng chi < M (Δ) làm Q(M−1) đổi −Δ ⇒ lối sửa thêm MỘT dòng điều
 * chỉnh ±Δ ngày M; dòng ngày < D0 (ngày mở sổ, ngoài quỹ) thì KHÔNG bù. Quỹ hôm nay không đổi một đồng, chỉ Lãi/Lỗ
 * tháng của dòng chi đổi đúng Δ.
 *
 * M = 01/10/2026, hôm nay ghim 13/10/2026 10:00 VN (fake timer chỉ `Date`), mở sổ D0 = 07/09/2026 (góp vốn 100tr).
 */

/** Rào gặp nhau cho ca hai lượt sửa đồng thời: mỗi lượt đã đọc dòng chi, đứng chờ lượt kia trước khi ghi. */
const rao = vi.hoisted(() => ({ bat: false, cho: [] as (() => void)[] }));
vi.mock("@/lib/so-quy/so-quy-queries", async (goc) => {
  const that = await goc<typeof import("@/lib/so-quy/so-quy-queries")>();
  return {
    ...that,
    ngayMoSo: async (...a: Parameters<typeof that.ngayMoSo>) => {
      if (rao.bat) {
        await new Promise<void>((res) => {
          rao.cho.push(res);
          if (rao.cho.length >= 2) for (const f of rao.cho.splice(0)) f();
          setTimeout(res, 3_000);
        });
      }
      return that.ngayMoSo(...a);
    },
  };
});
vi.mock("@/lib/quyen/nguoi-dung-phien", async (goc) => ({
  ...(await goc<typeof import("@/lib/quyen/nguoi-dung-phien")>()),
  docNguoiDungPhien: vi.fn(),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { xacNhanBatNoPhaiTra } from "@/lib/actions/bat-no-phai-tra";
import { updateExpense } from "@/lib/actions/expenses";
import { ensureRecurringExpensesChiTiet } from "@/lib/expenses/ensure-recurring-expenses";
import { suaSoTienTruocMoc } from "@/lib/actions/sua-tien-truoc-moc";
import { LOI_DANG_PHUC_HOI, thuGiuKhoaPhucHoi } from "@/lib/backup/khoa-bao-tri";
import { KEY_NO_PHAI_TRA_TU_NGAY, KHOA_BAT_NO_PHAI_TRA } from "@/lib/no-phai-tra/cong-bat-no-phai-tra";
import { docSoLieuTruocM } from "@/lib/no-phai-tra/doc-chenh-lech-tai-m";
import { docNguCanhLoc } from "@/lib/no-phai-tra/doc-ngu-canh-loc";
import { docDieuChinhDaGhi } from "@/lib/no-phai-tra/doc-trang-no-phai-tra";
import { docDuNoCacThe } from "@/lib/no-phai-tra/du-no-the";
import { prisma } from "@/lib/prisma";
import { docNguoiDungPhien } from "@/lib/quyen/nguoi-dung-phien";
import { calcPnl } from "@/lib/reports/pnl";
import { tinhQuyTuTong } from "@/lib/so-quy/cong-thuc-so-quy";
import { docTongNguon, ngayMoSo } from "@/lib/so-quy/so-quy-queries";

import { donKhoaPhucHoi } from "../../helpers/khoa-bao-tri-reset";
import { nguoiDungGia } from "../../helpers/nguoi-dung-gia";
import { seedReference, truncateBusinessTables } from "../../helpers/test-db";

const vn = (ngay: string, gio = "00:00:00") => new Date(`${ngay}T${gio}+07:00`);
const tr = (n: number) => Math.round(n * 1_000_000);
const M = "2026-10-01";
const KIND_CUTOVER = ["CUTOVER_ADJ_IN", "CUTOVER_ADJ_OUT"] as const;

beforeAll(async () => {
  await seedReference();
}, 60_000);

beforeEach(async () => {
  await truncateBusinessTables();
  await prisma.setting.deleteMany({ where: { key: KEY_NO_PHAI_TRA_TU_NGAY } });
  vi.mocked(docNguoiDungPhien).mockResolvedValue(nguoiDungGia());
  rao.bat = false;
  rao.cho = [];
  donKhoaPhucHoi();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(vn("2026-10-13", "10:00:00"));
  await prisma.cashMovement.create({
    data: { date: vn("2026-09-07"), kind: "CAPITAL_IN", amount: tr(100), description: "Góp vốn mở sổ" },
  });
});

afterEach(async () => {
  vi.useRealTimers();
  rao.bat = false;
  donKhoaPhucHoi();
  await prisma.setting.deleteMany({ where: { key: KEY_NO_PHAI_TRA_TU_NGAY } });
});

afterAll(async () => {
  await truncateBusinessTables();
  await prisma.$disconnect();
});

type DongChi = {
  date: Date;
  amount: number;
  categoryId?: string;
  description?: string;
  source?: "MANUAL" | "IMPORT" | "ADS_API" | "RECURRING";
  refId?: string;
  adsSource?: string;
  cardId?: string;
  recurringId?: string;
  recurringMonth?: string;
};

const taoChi = (d: DongChi) =>
  prisma.expense.create({
    data: {
      categoryId: "fixed",
      description: "Tiền nhà",
      source: "MANUAL",
      ...d,
    },
  });

/** Bước bật THẬT: vân tay đọc ngay trước khi bấm (không ai ghi chen), điều chỉnh tuỳ ca. */
async function bat(
  dieuChinh: { chieu: "IN" | "OUT"; soTien: number; moTa: string }[] = [],
  the: { cardId: string; saoKeCuoi: null; duNoCuoiMTru1: number }[] = []
) {
  const { vanTay } = await docSoLieuTruocM(vn(M));
  return xacNhanBatNoPhaiTra({ yeuCauId: randomUUID(), mocM: M, the, viAds: [], dieuChinh, vanTayQuy: vanTay });
}

async function batOk(...a: Parameters<typeof bat>): Promise<void> {
  const r = await bat(...a);
  expect(r, JSON.stringify(r)).toMatchObject({ ok: true });
}

async function tongCutoverNet(): Promise<number> {
  const rows = await prisma.cashMovement.findMany({ where: { kind: { in: [...KIND_CUTOVER] } } });
  return rows.reduce((s, r) => s + (r.kind === "CUTOVER_ADJ_IN" ? r.amount : -r.amount), 0);
}

/** Q(M−1) — cùng hàm bước bật dùng để chốt điều chỉnh. */
const quyTruocM = async () => (await docSoLieuTruocM(vn(M))).vanTay.quyApp;

/** Vế trái bất biến: Q(M−1) + Σ CUTOVER_net. */
const batBien = async () => (await quyTruocM()) + (await tongCutoverNet());

/** Quỹ app hôm nay theo công thức Sổ quỹ thật (ngữ cảnh lọc sau bật). */
async function quyHomNay(): Promise<number> {
  const d0 = await ngayMoSo();
  return tinhQuyTuTong(await docTongNguon(d0, new Date(), await docNguCanhLoc()));
}

const loiLoThang = async (tu: string, den: string) => (await calcPnl({ from: vn(tu), to: vn(den, "23:59:59") })).netProfit;

const demNhatKyDongBu = () =>
  prisma.auditLog.count({ where: { hanhDong: "DONG_TIEN_TAO", ghiChu: { equals: { lyDo: "SUA_TIEN_TRUOC_MOC" } } } });

const sua = (id: string, amountCuDaThay: number, amountMoi: number, lyDo = "Hoá đơn ghi sai") =>
  suaSoTienTruocMoc(id, { amountMoi, amountCuDaThay, lyDo });

/** Toàn bộ sổ chi phí + dòng tiền + Setting — so trước/sau để khẳng định "DB không đổi". */
async function chupSo() {
  return {
    chi: await prisma.expense.findMany({ orderBy: { id: "asc" } }),
    tien: await prisma.cashMovement.findMany({ orderBy: { id: "asc" } }),
    m: (await prisma.setting.findUnique({ where: { key: KEY_NO_PHAI_TRA_TU_NGAY } }))?.value ?? null,
  };
}

describe("sửa số tiền dòng chi trong quỹ (D0 ≤ ngày < M) ⇒ bù điều chỉnh mở sổ, quỹ từ M không đổi", () => {
  it("Δ > 0: 8tr → 9tr ⇒ thêm CUTOVER_ADJ_IN 1tr ngày M; bất biến giữ tuyệt đối, quỹ hôm nay không đổi, Lãi/Lỗ tháng 9 giảm 1tr", async () => {
    const chi = await taoChi({ date: vn("2026-09-15"), amount: tr(8), description: "Tiền nhà tháng 9" });
    await batOk([{ chieu: "OUT", soTien: tr(2), moTa: "Chênh chưa giải thích" }]);
    const dongBat = await prisma.cashMovement.findFirstOrThrow({ where: { kind: { in: [...KIND_CUTOVER] } } });

    const [k, q, quyM1, pnl9] = [await batBien(), await quyHomNay(), await quyTruocM(), await loiLoThang("2026-09-01", "2026-09-30")];
    expect(k).toBe(tr(100) - tr(8) - tr(2));

    const r = await sua(chi.id, tr(8), tr(9), "Hoá đơn tiền nhà ghi thiếu");
    expect(r).toEqual({ ok: true, data: { coBu: true, chieu: "IN", soTienBu: tr(1) } });

    expect(await batBien()).toBe(k);
    expect(await quyHomNay()).toBe(q);
    expect(await quyTruocM()).toBe(quyM1 - tr(1));
    expect(await loiLoThang("2026-09-01", "2026-09-30")).toBe(pnl9 - tr(1));
    expect((await prisma.expense.findUniqueOrThrow({ where: { id: chi.id } })).amount).toBe(tr(9));

    const cutover = await prisma.cashMovement.findMany({ where: { kind: { in: [...KIND_CUTOVER] } }, orderBy: { createdAt: "asc" } });
    expect(cutover).toHaveLength(2);
    // Dòng của bước bật NGUYÊN VẸN.
    expect(cutover[0]).toEqual(dongBat);
    expect(cutover[1]).toMatchObject({ kind: "CUTOVER_ADJ_IN", amount: tr(1), date: vn(M), yeuCauId: null, loanId: null });
    expect(cutover[1]!.description).toBe(
      'Bù sửa chi phí 15/09/2026 "Tiền nhà tháng 9": 8.000.000 ₫ → 9.000.000 ₫ — Hoá đơn tiền nhà ghi thiếu'
    );
    // Trang Nợ phải trả tách dòng của bước bật khỏi dòng bù (theo `yeuCauId`).
    expect((await docDieuChinhDaGhi()).map((d) => [d.id, d.cuaBuocBat])).toEqual([
      [dongBat.id, true],
      [cutover[1]!.id, false],
    ]);

    const nhatKy = await prisma.auditLog.findMany({
      where: { OR: [{ doiTuongId: chi.id }, { doiTuongId: cutover[1]!.id }], ketQua: "OK" },
      orderBy: { hanhDong: "asc" },
    });
    expect(nhatKy.map((n) => n.hanhDong)).toEqual(["CHI_PHI_SUA_TIEN_TRUOC_MOC", "DONG_TIEN_TAO"]);
    expect(nhatKy[0]!.doiTuongMoTa).toContain("8.000.000 ₫ → 9.000.000 ₫ · bù điều chỉnh mở sổ vào 1.000.000 ₫");
    expect(nhatKy[0]!.ghiChu).toEqual({ lyDo: "SUA_TIEN_TRUOC_MOC", thang: "2026-09" });
    expect(nhatKy[1]!.ghiChu).toEqual({ lyDo: "SUA_TIEN_TRUOC_MOC" });
  });

  it("Δ < 0: 8tr → 6,5tr (dòng import) ⇒ thêm CUTOVER_ADJ_OUT 1,5tr; bất biến giữ, quỹ hôm nay không đổi, Lãi/Lỗ tháng 9 tăng 1,5tr", async () => {
    const chi = await taoChi({ date: vn("2026-09-20", "15:00:00"), amount: tr(8), source: "IMPORT", categoryId: "ads", adsSource: "META", description: "Meta 20/09" });
    await batOk([{ chieu: "IN", soTien: tr(3), moTa: "Chênh chưa giải thích" }]);
    const [k, q, pnl9] = [await batBien(), await quyHomNay(), await loiLoThang("2026-09-01", "2026-09-30")];

    expect(await sua(chi.id, tr(8), tr(6.5))).toEqual({ ok: true, data: { coBu: true, chieu: "OUT", soTienBu: tr(1.5) } });

    expect(await batBien()).toBe(k);
    expect(await quyHomNay()).toBe(q);
    expect(await loiLoThang("2026-09-01", "2026-09-30")).toBe(pnl9 + tr(1.5));
    const moi = await prisma.cashMovement.findMany({ where: { kind: "CUTOVER_ADJ_OUT" } });
    expect(moi).toHaveLength(1);
    expect(moi[0]).toMatchObject({ amount: tr(1.5), date: vn(M), yeuCauId: null });
  });

  it("dòng ĐÚNG ngày mở sổ D0 (giữa ngày) ⇒ có bù", async () => {
    const chi = await taoChi({ date: vn("2026-09-07", "14:00:00"), amount: tr(1), categoryId: "other", description: "Phí mở tài khoản" });
    await batOk();
    const k = await batBien();
    expect(await sua(chi.id, tr(1), tr(1.2))).toEqual({ ok: true, data: { coBu: true, chieu: "IN", soTienBu: tr(0.2) } });
    expect(await batBien()).toBe(k);
  });

  it("bước bật không có dòng điều chỉnh nào ⇒ lối sửa tạo dòng ĐẦU TIÊN; bước bật lần hai vẫn DA_BAT_ROI", async () => {
    const chi = await taoChi({ date: vn("2026-09-15"), amount: tr(8) });
    await batOk();
    expect(await prisma.cashMovement.count({ where: { kind: { in: [...KIND_CUTOVER] } } })).toBe(0);
    const k = await batBien();
    expect(await sua(chi.id, tr(8), tr(8.4))).toMatchObject({ ok: true, data: { coBu: true } });
    expect(await prisma.cashMovement.count({ where: { kind: { in: [...KIND_CUTOVER] } } })).toBe(1);
    expect(await batBien()).toBe(k);
    expect(await bat()).toMatchObject({ ok: false, code: "DA_BAT_ROI" });
  });

  it("sửa ngược lại số cũ ⇒ thêm dòng ngược chiều (append-only), bất biến vẫn giữ", async () => {
    const chi = await taoChi({ date: vn("2026-09-15"), amount: tr(8) });
    await batOk();
    const k = await batBien();
    expect(await sua(chi.id, tr(8), tr(9))).toMatchObject({ ok: true, data: { chieu: "IN" } });
    expect(await sua(chi.id, tr(9), tr(8))).toMatchObject({ ok: true, data: { chieu: "OUT", soTienBu: tr(1) } });
    expect(await prisma.cashMovement.count({ where: { kind: { in: [...KIND_CUTOVER] } } })).toBe(2);
    expect(await batBien()).toBe(k);
  });
});

describe("dòng định kỳ tự sinh trước M ⇒ sửa được kèm bù, bộ sinh không sinh lại", () => {
  it("mẫu 'Lương kho' 15/09 khai nhầm 8tr → 7tr ⇒ OUT 1tr, bất biến giữ; chạy bộ sinh tháng 9 ⇒ không thêm dòng", async () => {
    const mau = await prisma.recurringExpense.create({
      data: { categoryId: "fixed", amount: tr(8), dayOfMonth: 15, description: "Lương kho", activeFrom: vn("2026-09-01") },
    });
    const chi = await taoChi({
      date: vn("2026-09-15"),
      amount: tr(8),
      description: "Lương kho",
      source: "RECURRING",
      recurringId: mau.id,
      recurringMonth: "2026-09",
    });
    await batOk();
    const [k, q, pnl9] = [await batBien(), await quyHomNay(), await loiLoThang("2026-09-01", "2026-09-30")];

    expect(await sua(chi.id, tr(8), tr(7), "Mẫu định kỳ khai nhầm")).toEqual({
      ok: true,
      data: { coBu: true, chieu: "OUT", soTienBu: tr(1) },
    });
    expect(await batBien()).toBe(k);
    expect(await quyHomNay()).toBe(q);
    expect(await loiLoThang("2026-09-01", "2026-09-30")).toBe(pnl9 + tr(1));

    // Bộ sinh thấy ô (mẫu, 2026-09) đã có dòng ⇒ không chèn; `boQuaTruocM` = 0 chứng minh dòng bị chặn sinh vì ĐÃ
    // CÓ, không phải nhờ cổng "trước M".
    expect(await ensureRecurringExpensesChiTiet(vn("2026-09-01"))).toEqual({ daTao: 0, boQuaNhapHang: 0, boQuaTruocM: 0 });
    const dongMau = await prisma.expense.findMany({ where: { recurringId: mau.id } });
    expect(dongMau).toHaveLength(1);
    expect(dongMau[0]).toMatchObject({ id: chi.id, amount: tr(7), recurringMonth: "2026-09" });
    expect(await batBien()).toBe(k);
  });
});

describe("dòng chi TRƯỚC ngày mở sổ (ngoài quỹ) ⇒ chỉ đổi Lãi/Lỗ, KHÔNG bù", () => {
  it("05/08 (D0 = 07/09): 8tr → 9tr ⇒ coBu false, không thêm CUTOVER, Q(M−1) + quỹ hôm nay không đổi, Lãi/Lỗ tháng 8 giảm 1tr", async () => {
    const chi = await taoChi({ date: vn("2026-08-05"), amount: tr(8), description: "Tiền nhà tháng 8" });
    await batOk([{ chieu: "OUT", soTien: tr(2), moTa: "Chênh chưa giải thích" }]);
    const nhatKyDongBu = await demNhatKyDongBu();
    const [k, q, quyM1, soCutover, pnl8] = [
      await batBien(),
      await quyHomNay(),
      await quyTruocM(),
      await prisma.cashMovement.count({ where: { kind: { in: [...KIND_CUTOVER] } } }),
      await loiLoThang("2026-08-01", "2026-08-31"),
    ];

    expect(await sua(chi.id, tr(8), tr(9))).toEqual({ ok: true, data: { coBu: false } });

    expect(await prisma.cashMovement.count({ where: { kind: { in: [...KIND_CUTOVER] } } })).toBe(soCutover);
    expect(await quyTruocM()).toBe(quyM1);
    expect(await batBien()).toBe(k);
    expect(await quyHomNay()).toBe(q);
    expect(await loiLoThang("2026-08-01", "2026-08-31")).toBe(pnl8 - tr(1));
    const nk = await prisma.auditLog.findFirstOrThrow({ where: { doiTuongId: chi.id, hanhDong: "CHI_PHI_SUA_TIEN_TRUOC_MOC" } });
    expect(nk.doiTuongMoTa).toContain("không bù");
    // Nhật ký không nằm trong bộ dọn bảng nghiệp vụ ⇒ so số dòng trước/sau thay vì đếm tuyệt đối.
    expect(await demNhatKyDongBu()).toBe(nhatKyDongBu);
  });
});

describe("từ chối ⇒ DB không đổi một dòng", () => {
  it("chưa bật ⇒ CHUA_BAT_NO_PHAI_TRA", async () => {
    const chi = await taoChi({ date: vn("2026-09-15"), amount: tr(8) });
    const truoc = await chupSo();
    expect(await sua(chi.id, tr(8), tr(9))).toMatchObject({ ok: false, code: "CHUA_BAT_NO_PHAI_TRA" });
    expect(await chupSo()).toEqual(truoc);
  });

  it.each<[string, DongChi, string]>([
    ["dòng ngày ≥ M", { date: vn("2026-10-05"), amount: tr(8) }, "TU_NGAY_BAT"],
    ["dòng Nhập hàng", { date: vn("2026-09-15"), amount: tr(8), categoryId: "purchase" }, "NHAP_HANG"],
    [
      "dòng sinh từ phiếu nhập Pancake đã đổi sang danh mục khác",
      { date: vn("2026-09-15"), amount: tr(8), categoryId: "fixed", refId: "PANCAKE_PURCHASE:phieu-1" },
      "NHAP_HANG",
    ],
    ["chi ads cửa máy ADS_API", { date: vn("2026-09-15"), amount: tr(8), categoryId: "ads", adsSource: "META", source: "ADS_API", refId: "META:2026-09-15:c1" }, "CHI_PHI_MAY"],
    ["lãi vay sinh cùng kỳ trả nợ", { date: vn("2026-09-15"), amount: tr(1), categoryId: "interest", refId: "LOAN:l1:2026-09-15" }, "LAI_VAY"],
  ])("%s ⇒ %s", async (_ten, d, ma) => {
    await batOk();
    const chi = await taoChi(d);
    const truoc = await chupSo();
    const r = await sua(chi.id, d.amount, d.amount + tr(1));
    expect(r).toMatchObject({ ok: false, code: ma });
    expect(await chupSo()).toEqual(truoc);
  });

  it("số màn hình đã thấy lệch DB (tab cũ) ⇒ SO_TIEN_DA_DOI; số mới bằng số cũ ⇒ SO_TIEN_KHONG_DOI", async () => {
    await batOk();
    const chi = await taoChi({ date: vn("2026-09-15"), amount: tr(8) });
    const truoc = await chupSo();
    expect(await sua(chi.id, tr(7), tr(9))).toMatchObject({ ok: false, code: "SO_TIEN_DA_DOI" });
    expect(await sua(chi.id, tr(8), tr(8))).toMatchObject({ ok: false, code: "SO_TIEN_KHONG_DOI" });
    expect(await sua("khong-co-dong-nay", tr(8), tr(9))).toMatchObject({ ok: false, code: "KHONG_TIM_THAY" });
    expect(await sua(chi.id, tr(8), 0)).toMatchObject({ ok: false, field: "amountMoi" });
    expect(await suaSoTienTruocMoc(chi.id, { amountMoi: tr(9), amountCuDaThay: tr(8), lyDo: "   " })).toMatchObject({ ok: false, field: "lyDo" });
    expect(await chupSo()).toEqual(truoc);
  });

  it("nhân sự không phải chủ shop ⇒ KHONG_CO_QUYEN; đang phục hồi ⇒ câu báo phục hồi", async () => {
    await batOk();
    const chi = await taoChi({ date: vn("2026-09-15"), amount: tr(8) });
    const truoc = await chupSo();
    vi.mocked(docNguoiDungPhien).mockResolvedValueOnce(nguoiDungGia({ role: "STAFF", quyen: new Set(["chi-phi:sua"]) }));
    expect(await sua(chi.id, tr(8), tr(9))).toMatchObject({ ok: false, code: "KHONG_CO_QUYEN" });
    expect(thuGiuKhoaPhucHoi()).not.toBeNull();
    expect(await sua(chi.id, tr(8), tr(9))).toEqual({ ok: false, error: LOI_DANG_PHUC_HOI });
    donKhoaPhucHoi();
    expect(await chupSo()).toEqual(truoc);
  });

  it("dòng có thẻ trước M ⇒ CO_THE; Sổ quỹ và dư nợ thẻ không lệch", async () => {
    const the = await prisma.theTinDung.create({ data: { ten: "Thẻ A", ngayChotSaoKe: 25, ngayHanTra: 10 } });
    const chi = await taoChi({ date: vn("2026-09-20"), amount: tr(3), cardId: the.id, description: "Mua máy in" });
    await batOk([], [{ cardId: the.id, saoKeCuoi: null, duNoCuoiMTru1: tr(5) }]);
    const [q, k, duNo, truoc] = [await quyHomNay(), await batBien(), await docDuNoCacThe(new Date()), await chupSo()];

    expect(await sua(chi.id, tr(3), tr(4))).toMatchObject({ ok: false, code: "CO_THE" });

    expect(await chupSo()).toEqual(truoc);
    expect(await quyHomNay()).toBe(q);
    expect(await batBien()).toBe(k);
    expect(await docDuNoCacThe(new Date())).toEqual(duNo);
  });
});

describe("đồng thời", () => {
  it("bước bật đang giữ EXCLUSIVE ⇒ lối sửa CHỜ nó commit rồi đọc M mới ⇒ sửa + bù theo M đó", async () => {
    const chi = await taoChi({ date: vn("2026-09-15"), amount: tr(8) });
    const k = await batBien();
    let tha!: () => void;
    const cho = new Promise<void>((res) => (tha = res));
    let daGiu!: () => void;
    const giuXong = new Promise<void>((res) => (daGiu = res));
    const buocBat = prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${KHOA_BAT_NO_PHAI_TRA}::text))`;
        await tx.setting.create({ data: { key: KEY_NO_PHAI_TRA_TU_NGAY, value: M } });
        daGiu();
        await cho;
      },
      { timeout: 20_000 }
    );
    await giuXong;
    const t0 = performance.now();
    const p = sua(chi.id, tr(8), tr(9)).then((r) => ({ r, ms: performance.now() - t0 }));
    await new Promise((res) => setTimeout(res, 800));
    tha();
    await buocBat;
    const { r, ms } = await p;

    expect(ms).toBeGreaterThanOrEqual(700);
    expect(r).toEqual({ ok: true, data: { coBu: true, chieu: "IN", soTienBu: tr(1) } });
    expect(await batBien()).toBe(k);
  });

  it("hai lượt sửa cùng dòng cùng lúc (cùng đọc 8tr) ⇒ đúng MỘT lượt thắng, đúng MỘT dòng bù", async () => {
    const chi = await taoChi({ date: vn("2026-09-15"), amount: tr(8) });
    await batOk();
    const k = await batBien();
    rao.bat = true;
    const [a, b] = await Promise.all([sua(chi.id, tr(8), tr(9)), sua(chi.id, tr(8), tr(10))]);
    rao.bat = false;

    const thang = [a, b].filter((r) => r.ok);
    expect(thang).toHaveLength(1);
    expect([a, b].find((r) => !r.ok)).toMatchObject({ ok: false, code: "SO_TIEN_DA_DOI" });
    const cutover = await prisma.cashMovement.findMany({ where: { kind: { in: [...KIND_CUTOVER] } } });
    expect(cutover).toHaveLength(1);
    const soMoi = (await prisma.expense.findUniqueOrThrow({ where: { id: chi.id } })).amount;
    expect(cutover[0]!.amount).toBe(soMoi - tr(8));
    expect(await batBien()).toBe(k);
  });

  it("lượt sửa mô tả thường chen sau lượt sửa số tiền trên cùng dòng ⇒ lượt thường lùi (không đè số cũ), đúng MỘT dòng bù, bất biến giữ", async () => {
    const chi = await taoChi({ date: vn("2026-09-15"), amount: tr(1), description: "Tiền điện tháng 9" });
    await batOk();
    const k = await batBien();

    // Giữ khoá dòng chi để CẢ HAI lượt đều đọc dòng (1tr) rồi đứng xếp hàng ở câu ghi: lối sửa số tiền tới trước,
    // lượt sửa mô tả tới sau. Thả khoá ⇒ lối sửa ghi 1,5tr + bù rồi commit; lượt sửa mô tả mới tới câu ghi của nó.
    const giu = await giuKhoaDongChi(chi.id);
    const pTien = sua(chi.id, tr(1), tr(1.5));
    await choSoLuotDungChoGhiChi(1);
    const pMoTa = updateExpense(chi.id, {
      date: vn("2026-09-15"),
      categoryId: "fixed",
      amount: tr(1),
      channelId: null,
      description: "Tiền điện tháng 9 (đã đối chiếu)",
    });
    await choSoLuotDungChoGhiChi(2);
    giu.tha();
    await giu.xong;
    const [rTien, rMoTa] = [await pTien, await pMoTa];

    expect(rTien).toEqual({ ok: true, data: { coBu: true, chieu: "IN", soTienBu: tr(0.5) } });
    // Rào câu ghi lượt thường gồm số tiền + ngày đã đọc sau khoá ⇒ dòng đã đổi ⇒ 0 dòng ⇒ bảo tải lại.
    expect(rMoTa).toMatchObject({ ok: false, code: "KHONG_TIM_THAY_HO_SO" });
    const sau = await prisma.expense.findUniqueOrThrow({ where: { id: chi.id } });
    expect(sau.amount).toBe(tr(1.5));
    expect(sau.description).toBe("Tiền điện tháng 9");
    expect(await tongCutoverNet()).toBe(tr(0.5));
    expect(await batBien()).toBe(k);
  });
});

/** Transaction riêng giữ `FOR UPDATE` trên một dòng chi cho tới khi gọi `tha()`. */
async function giuKhoaDongChi(id: string): Promise<{ tha: () => void; xong: Promise<unknown> }> {
  let daGiu!: () => void;
  const giuXong = new Promise<void>((res) => (daGiu = res));
  let tha!: () => void;
  const cho = new Promise<void>((res) => (tha = res));
  const xong = prisma.$transaction(
    async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Expense" WHERE id = ${id} FOR UPDATE`;
      daGiu();
      await cho;
    },
    { timeout: 20_000 }
  );
  await giuXong;
  return { tha, xong };
}

/**
 * Chờ tới khi đúng `n` kết nối khác đang ĐỨNG CHỜ khoá ở câu `UPDATE` bảng `Expense` (`pg_stat_activity`) —
 * thay cho ngủ cố định: lượt bị chặn chắc chắn đã đọc dòng và tới câu ghi.
 */
async function choSoLuotDungChoGhiChi(n: number): Promise<void> {
  // `performance.now()` chứ không `Date.now()`: test giả `Date` (đứng yên).
  const hetHan = performance.now() + 10_000;
  for (;;) {
    const [dong] = await prisma.$queryRaw<{ n: number }[]>`
      SELECT count(*)::int AS n FROM pg_stat_activity
      WHERE datname = current_database() AND pid <> pg_backend_pid()
        AND wait_event_type = 'Lock' AND query LIKE 'UPDATE %"Expense"%'`;
    if (dong!.n >= n) return;
    if (performance.now() > hetHan) throw new Error(`Hết 10s mà chưa thấy ${n} lượt đứng chờ ghi Expense`);
    await new Promise((r) => setTimeout(r, 50));
  }
}
