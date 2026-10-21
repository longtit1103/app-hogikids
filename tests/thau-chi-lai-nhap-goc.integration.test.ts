import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Thấu chi "lãi nhập gốc" — DB thật (`hogikids_test`). Ngân hàng CỘNG lãi kỳ vào dư nợ thấu chi, KHÔNG trừ
 * tài khoản. Duyệt kỳ lãi ⇒ `Expense` lãi (vào P&L, trừ quỹ) + `CashMovement` `LAI_NHAP_GOC` cùng số, cùng
 * ngày kỳ (cộng quỹ, tăng dư nợ) ⇒ quỹ KHÔNG đổi, P&L + lãi, dư nợ + lãi; kỳ sau lãi kép; tất toán trả trọn
 * dư nợ (gồm lãi đã nhập) + lãi đoạn cuối bằng tiền thật.
 *
 * Khoản mẫu (spec chủ shop 15/10): rút 100.000.000 ngày 10/09/2026, 11,75%/năm, thu lãi mùng 1. Số LITERAL
 * tính tay (`Σ(dư nợ × ngày) × bp / 3.650.000`, làm tròn nửa lên một lần):
 *  - kỳ 01/10: 100.000.000 × 21 × 1175 / 3.650.000 = 676.027,40 ⇒ 676.027 ⇒ dư nợ 100.676.027
 *  - kỳ 01/11: 100.676.027 × 31 × 1175 / 3.650.000 = 1.004.691,58 ⇒ 1.004.692 ⇒ dư nợ 101.680.719
 *  - tất toán 15/11: 101.680.719 × 14 × 1175 / 3.650.000 = 458.259,68 ⇒ 458.260
 *    ⇒ quỹ giảm đúng 101.680.719 + 458.260 = 102.138.979
 *
 * "Hôm nay" giả 20/11/2026 (fake timer chỉ `Date` — setTimeout/performance thật cho ca đua).
 */
vi.mock("@/lib/quyen/nguoi-dung-phien", async (goc) => {
  const { nguoiDungGia } = await import("./helpers/nguoi-dung-gia");
  return {
    ...(await goc<typeof import("@/lib/quyen/nguoi-dung-phien")>()),
    docNguoiDungPhien: vi.fn(async () => nguoiDungGia()),
  };
});
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { createCashMovement, deleteCashMovement, updateCashMovement } from "@/lib/actions/cash-movements";
import { deleteExpense, updateExpense } from "@/lib/actions/expenses";
import { ghiKyTraNo, suaKhoanVay, taoKhoanVay } from "@/lib/actions/khoan-vay";
import { tatToanThauChi } from "@/lib/actions/tat-toan-thau-chi";
import { khoiPhucBanGhi } from "@/lib/actions/thung-rac";
import { docVanTayQuyTruocM } from "@/lib/no-phai-tra/doc-chenh-lech-tai-m";
import { docTheKemTrangThai } from "@/lib/no-phai-tra/the-tin-dung-queries";
import { KEY_NO_PHAI_TRA_TU_NGAY, KHOA_BAT_NO_PHAI_TRA } from "@/lib/no-phai-tra/cong-bat-no-phai-tra";
import { prisma } from "@/lib/prisma";
import { calcPnl } from "@/lib/reports/pnl";
import { listKhoanVay } from "@/lib/so-quy/khoan-vay-queries";
import { tinhSoQuyThang } from "@/lib/so-quy/so-quy-queries";

import { seedReference, truncateBusinessTables } from "./helpers/test-db";

const vn = (ngay: string) => new Date(`${ngay}T00:00:00+07:00`);

const THAU_CHI = {
  name: "Thấu chi sổ tiết kiệm",
  lender: "Techcombank",
  annualRateBp: 1175,
  kind: "OVERDRAFT",
  coLich: true,
  firstDueDate: "2026-10-01",
  cheDo: "moi",
  soTienGiaiNgan: 100_000_000,
  ngayGiaiNgan: "2026-09-10",
  note: "",
  laiNhapGoc: true,
};

const KY_1 = { dueDate: "2026-10-01", lai: 676_027, goc: 0 };
const KY_2 = { dueDate: "2026-11-01", lai: 1_004_692, goc: 0 };

function idCua(r: { ok: boolean; data?: unknown; error?: string }): string {
  if (!r.ok) throw new Error(r.error);
  return (r.data as { id: string }).id;
}

async function taoThauChi(ghiDe: Record<string, unknown> = {}): Promise<string> {
  return idCua(await taoKhoanVay({ ...THAU_CHI, ...ghiDe }));
}

const quyHomNay = async () => (await tinhSoQuyThang({ from: vn("2026-11-01"), to: vn("2026-11-30") })).quyHomNay;
const duNo = async (loanId: string) => (await listKhoanVay()).find((l) => l.id === loanId)?.duNo;
const laiThang = async (thang: string, den: string) => (await calcPnl({ from: vn(thang), to: vn(den) })).interest;
const dongNhapGoc = () =>
  prisma.cashMovement.findMany({
    where: { kind: "LAI_NHAP_GOC" },
    select: { amount: true, date: true, loanId: true },
    orderBy: { date: "asc" },
  });

const batM = (m: string) =>
  prisma.setting.upsert({
    where: { key: KEY_NO_PHAI_TRA_TU_NGAY },
    create: { key: KEY_NO_PHAI_TRA_TU_NGAY, value: m },
    update: { value: m },
  });

/** Giả lập bước bật: giữ khoá EXCLUSIVE + ghi Setting M (chưa commit) 0,8s rồi commit; `hanhDong` chạy giữa chừng. */
async function trongLucBuocBatGiuKhoa<T>(m: string, hanhDong: () => Promise<T>): Promise<{ r: T; ms: number }> {
  let tha!: () => void;
  const cho = new Promise<void>((res) => (tha = res));
  let daGiu!: () => void;
  const giuXong = new Promise<void>((res) => (daGiu = res));
  const buocBat = prisma.$transaction(
    async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${KHOA_BAT_NO_PHAI_TRA}::text))`;
      await tx.setting.create({ data: { key: KEY_NO_PHAI_TRA_TU_NGAY, value: m } });
      daGiu();
      await cho;
    },
    { timeout: 20_000 }
  );
  await giuXong;
  const t0 = performance.now();
  const p = hanhDong().then((r) => ({ r, ms: performance.now() - t0 }));
  await new Promise((res) => setTimeout(res, 800));
  tha();
  await buocBat;
  return p;
}

beforeAll(async () => {
  await seedReference();
}, 60_000);

beforeEach(async () => {
  await truncateBusinessTables();
  await prisma.setting.deleteMany({ where: { key: KEY_NO_PHAI_TRA_TU_NGAY } });
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(2026, 10, 20, 9, 0, 0));
});

afterEach(async () => {
  vi.useRealTimers();
  await prisma.setting.deleteMany({ where: { key: KEY_NO_PHAI_TRA_TU_NGAY } });
});

afterAll(async () => {
  await truncateBusinessTables();
  await prisma.$disconnect();
});

describe("hồ sơ: cờ lãi nhập gốc chỉ cho thấu chi", () => {
  it("tạo thấu chi bật cờ ⇒ lưu true; vay kỳ hạn bật cờ ⇒ báo lỗi tại ô `laiNhapGoc`", async () => {
    const id = await taoThauChi();
    expect((await prisma.loan.findUniqueOrThrow({ where: { id } })).laiNhapGoc).toBe(true);

    const r = await taoKhoanVay({ ...THAU_CHI, kind: "TERM", termMonths: 12 });
    expect(r).toMatchObject({ ok: false, field: "laiNhapGoc" });
  });

  it("CHECK DB `Loan_lai_nhap_goc_chi_thau_chi`: ghi thẳng cờ lên khoản kỳ hạn bị từ chối", async () => {
    const id = await taoThauChi({ kind: "TERM", termMonths: 12, laiNhapGoc: false });
    await expect(prisma.loan.update({ where: { id }, data: { laiNhapGoc: true } })).rejects.toThrow(
      /Loan_lai_nhap_goc_chi_thau_chi/
    );
  });

  it("sửa khoản bật/tắt cờ được cả sau khi đã duyệt kỳ — kỳ đã duyệt giữ nguyên dòng của nó", async () => {
    const id = await taoThauChi({ laiNhapGoc: false });
    expect(await ghiKyTraNo({ loanId: id, ...KY_1 })).toMatchObject({ ok: true });
    expect(await suaKhoanVay(id, { ...THAU_CHI })).toMatchObject({ ok: true });
    expect((await prisma.loan.findUniqueOrThrow({ where: { id } })).laiNhapGoc).toBe(true);
    // Kỳ 01/10 duyệt lúc cờ tắt: KHÔNG có dòng nhập gốc, dư nợ vẫn 100tr. Kỳ 01/11 (cờ bật) nhập gốc.
    expect(await dongNhapGoc()).toEqual([]);
    expect(await duNo(id)).toBe(100_000_000);
    const ky2 = (await listKhoanVay()).find((l) => l.id === id)?.kyCho;
    expect(ky2?.lai).toBe(997_945);
    expect(await ghiKyTraNo({ loanId: id, dueDate: "2026-11-01", lai: 997_945, goc: 0 })).toMatchObject({ ok: true });
    expect(await duNo(id)).toBe(100_997_945);
  });
});

describe("duyệt kỳ lãi — khoản lãi nhập gốc", () => {
  it("kỳ 01/10: P&L + 676.027, quỹ KHÔNG đổi, dư nợ 100.676.027; cặp Expense + LAI_NHAP_GOC cùng số, cùng ngày", async () => {
    const id = await taoThauChi();
    expect((await listKhoanVay()).find((l) => l.id === id)?.kyCho?.lai).toBe(KY_1.lai);
    const quyTruoc = await quyHomNay();
    expect(quyTruoc).toBe(100_000_000);

    expect(await ghiKyTraNo({ loanId: id, ...KY_1 })).toMatchObject({ ok: true, data: { duNoConLai: 100_676_027 } });

    expect(await quyHomNay()).toBe(quyTruoc);
    expect(await duNo(id)).toBe(100_676_027);
    expect(await laiThang("2026-10-01", "2026-10-31")).toBe(676_027);
    expect(await dongNhapGoc()).toEqual([{ amount: 676_027, date: vn("2026-10-01"), loanId: id }]);
    expect(
      await prisma.expense.findMany({ select: { categoryId: true, amount: true, date: true, refId: true } })
    ).toEqual([{ categoryId: "interest", amount: 676_027, date: vn("2026-10-01"), refId: `LOAN:${id}:2026-10-01` }]);
  });

  it("kỳ 01/11 đề xuất lãi trên dư nợ ĐÃ cộng lãi (1.004.692); sau duyệt dư nợ 101.680.719, quỹ vẫn 100tr", async () => {
    const id = await taoThauChi();
    await ghiKyTraNo({ loanId: id, ...KY_1 });
    expect((await listKhoanVay()).find((l) => l.id === id)?.kyCho?.lai).toBe(KY_2.lai);
    expect(await ghiKyTraNo({ loanId: id, ...KY_2 })).toMatchObject({ ok: true, data: { duNoConLai: 101_680_719 } });
    expect(await duNo(id)).toBe(101_680_719);
    expect(await quyHomNay()).toBe(100_000_000);
    expect(await laiThang("2026-11-01", "2026-11-30")).toBe(1_004_692);
  });

  it("tất toán 15/11: LOAN_REPAY = trọn dư nợ 101.680.719, lãi đoạn cuối 458.260 trừ quỹ (không nhập gốc)", async () => {
    const id = await taoThauChi();
    await ghiKyTraNo({ loanId: id, ...KY_1 });
    await ghiKyTraNo({ loanId: id, ...KY_2 });
    const row = (await listKhoanVay()).find((l) => l.id === id);
    // Lãi tạm tính tới hôm nay 20/11 (chỉ hiển thị): 101.680.719 × 19 × 1175 / 3.650.000 = 621.923,85 ⇒ 621.924
    expect(row?.laiTamTinh).toBe(621_924);

    const r = await tatToanThauChi({ loanId: id, ngayTatToan: "2026-11-15", lai: 458_260, conDauDaThay: vn("2026-11-01") });
    expect(r).toMatchObject({ ok: true, data: { lai: 458_260, goc: 101_680_719 } });
    expect(await quyHomNay()).toBe(100_000_000 - 101_680_719 - 458_260);
    expect(await duNo(id)).toBe(0);
    expect((await prisma.loan.findUniqueOrThrow({ where: { id } })).closedAt).not.toBeNull();
    // Lãi đoạn cuối là tiền trả thật — KHÔNG thêm dòng nhập gốc nào.
    expect((await dongNhapGoc()).map((d) => d.amount)).toEqual([676_027, 1_004_692]);
    expect(await laiThang("2026-11-01", "2026-11-30")).toBe(1_004_692 + 458_260);
  });

  it("trả một phần ('Trả nợ gốc' tay) trừ vào dư nợ gồm cả lãi đã nhập; không vào P&L", async () => {
    const id = await taoThauChi();
    await ghiKyTraNo({ loanId: id, ...KY_1 });
    expect(
      await createCashMovement({ date: "2026-10-10", kind: "LOAN_REPAY", amount: 100_676_027, loanId: id, description: "" })
    ).toMatchObject({ ok: true });
    expect(await duNo(id)).toBe(0);
    expect(await laiThang("2026-10-01", "2026-10-31")).toBe(676_027);
    // Trả vượt dư nợ (gồm lãi nhập gốc) bị chặn.
    expect(
      await createCashMovement({ date: "2026-10-11", kind: "LOAN_REPAY", amount: 1, loanId: id, description: "" })
    ).toMatchObject({ ok: false });
  });

  it("'Ngân hàng không thu kỳ này' không ghi đồng nào (không Expense, không nhập gốc)", async () => {
    const id = await taoThauChi();
    expect(await ghiKyTraNo({ loanId: id, dueDate: "2026-10-01", lai: 0, goc: 0, boQua: true })).toMatchObject({ ok: true });
    expect(await prisma.expense.count()).toBe(0);
    expect(await dongNhapGoc()).toEqual([]);
    expect(await duNo(id)).toBe(100_000_000);
  });
});

describe("khoản KHÔNG lãi nhập gốc giữ y hành vi cũ", () => {
  it("duyệt kỳ 01/10: chỉ Expense, quỹ giảm đúng lãi, dư nợ đứng yên; kỳ 01/11 lãi trên 100tr", async () => {
    const id = await taoThauChi({ laiNhapGoc: false });
    expect(await ghiKyTraNo({ loanId: id, ...KY_1 })).toMatchObject({ ok: true, data: { duNoConLai: 100_000_000 } });
    expect(await dongNhapGoc()).toEqual([]);
    expect(await quyHomNay()).toBe(100_000_000 - 676_027);
    expect((await listKhoanVay()).find((l) => l.id === id)?.kyCho?.lai).toBe(997_945);
  });

  it("form cũ không gửi ô `laiNhapGoc`: tạo ⇒ false; SỬA ⇒ giữ nguyên cờ đang bật (không âm thầm tắt)", async () => {
    const { laiNhapGoc: _bo, ...cu } = THAU_CHI;
    void _bo;
    const id = idCua(await taoKhoanVay(cu));
    expect((await prisma.loan.findUniqueOrThrow({ where: { id } })).laiNhapGoc).toBe(false);

    const idBat = await taoThauChi();
    expect(await suaKhoanVay(idBat, { ...cu, name: "Đổi tên" })).toMatchObject({ ok: true });
    expect(await prisma.loan.findUniqueOrThrow({ where: { id: idBat } })).toMatchObject({ name: "Đổi tên", laiNhapGoc: true });
    // Gửi rõ `false` thì tắt được.
    expect(await suaKhoanVay(idBat, { ...cu, laiNhapGoc: false })).toMatchObject({ ok: true });
    expect((await prisma.loan.findUniqueOrThrow({ where: { id: idBat } })).laiNhapGoc).toBe(false);
  });
});

describe("không ghi tay / sửa / xoá đơn lẻ dòng lãi nhập gốc", () => {
  it("tạo tay kind LAI_NHAP_GOC bị zod từ chối; sửa/xoá dòng có sẵn bị từ chối `LAI_NHAP_GOC_DI_THEO_KY`", async () => {
    const id = await taoThauChi();
    await ghiKyTraNo({ loanId: id, ...KY_1 });
    expect(
      await createCashMovement({ date: "2026-10-05", kind: "LAI_NHAP_GOC", amount: 1_000, loanId: id, description: "" })
    ).toMatchObject({ ok: false, field: "kind" });

    const dong = await prisma.cashMovement.findFirstOrThrow({ where: { kind: "LAI_NHAP_GOC" } });
    expect(
      await updateCashMovement(dong.id, { date: "2026-10-01", kind: "LOAN_IN", amount: 1, loanId: id, description: "" })
    ).toMatchObject({ ok: false, code: "LAI_NHAP_GOC_DI_THEO_KY" });
    expect(await deleteCashMovement(dong.id)).toMatchObject({ ok: false, code: "LAI_NHAP_GOC_DI_THEO_KY" });
    expect(await dongNhapGoc()).toEqual([{ amount: 676_027, date: vn("2026-10-01"), loanId: id }]);
  });

  it("index duy nhất: dòng lãi nhập gốc thứ hai cùng khoản, cùng ngày kỳ bị DB từ chối", async () => {
    const id = await taoThauChi();
    await ghiKyTraNo({ loanId: id, ...KY_1 });
    await expect(
      prisma.cashMovement.create({ data: { date: vn("2026-10-01"), kind: "LAI_NHAP_GOC", amount: 1, loanId: id } })
    ).rejects.toThrow(/Unique|CashMovement_lai_nhap_goc_mot_ky/i);
  });

  it("CHECK DB: LAI_NHAP_GOC không gắn khoản vay bị từ chối `CashMovement_loan_bat_buoc`", async () => {
    await expect(
      prisma.cashMovement.create({ data: { date: vn("2026-10-01"), kind: "LAI_NHAP_GOC", amount: 1 } })
    ).rejects.toThrow(/CashMovement_loan_bat_buoc/);
  });
});

describe("cặp kỳ: sửa số / xoá / khôi phục dòng lãi kéo theo dòng nhập gốc", () => {
  async function dongLai() {
    return prisma.expense.findFirstOrThrow({ where: { categoryId: "interest" } });
  }

  it("sửa số lãi 676.027 → 650.000: dòng nhập gốc theo, dư nợ 100.650.000, quỹ vẫn 100tr", async () => {
    const id = await taoThauChi();
    await ghiKyTraNo({ loanId: id, ...KY_1 });
    const e = await dongLai();
    const r = await updateExpense(e.id, {
      date: "2026-10-01",
      categoryId: "interest",
      amount: 650_000,
      channelId: null,
      description: e.description,
    });
    expect(r).toMatchObject({ ok: true });
    expect(await dongNhapGoc()).toEqual([{ amount: 650_000, date: vn("2026-10-01"), loanId: id }]);
    expect(await duNo(id)).toBe(100_650_000);
    expect(await quyHomNay()).toBe(100_000_000);
    expect(await laiThang("2026-10-01", "2026-10-31")).toBe(650_000);
  });

  it("xoá dòng lãi ⇒ xoá luôn dòng nhập gốc (một mục thùng rác); khôi phục dựng lại CẢ cặp", async () => {
    const id = await taoThauChi();
    await ghiKyTraNo({ loanId: id, ...KY_1 });
    const e = await dongLai();

    expect(await deleteExpense(e.id, "only")).toMatchObject({ ok: true });
    expect(await prisma.expense.count()).toBe(0);
    expect(await dongNhapGoc()).toEqual([]);
    expect(await duNo(id)).toBe(100_000_000);
    expect(await quyHomNay()).toBe(100_000_000);
    const rac = await prisma.banGhiDaXoa.findMany();
    expect(rac).toHaveLength(1);
    expect(rac[0].nhan).toContain("kèm dòng lãi nhập gốc thấu chi");

    expect(await khoiPhucBanGhi(rac[0].id)).toMatchObject({ ok: true });
    expect(await prisma.expense.count()).toBe(1);
    expect(await dongNhapGoc()).toEqual([{ amount: 676_027, date: vn("2026-10-01"), loanId: id }]);
    expect(await duNo(id)).toBe(100_676_027);
    expect(await quyHomNay()).toBe(100_000_000);
  });

  it("khoản đã tất toán: sửa số / xoá dòng lãi kỳ nhập gốc bị chặn (dư nợ đã chốt về 0)", async () => {
    const id = await taoThauChi();
    await ghiKyTraNo({ loanId: id, ...KY_1 });
    expect(
      await tatToanThauChi({ loanId: id, ngayTatToan: "2026-10-15", lai: 100, conDauDaThay: vn("2026-10-01") })
    ).toMatchObject({ ok: true, data: { goc: 100_676_027 } });
    const e = await prisma.expense.findFirstOrThrow({ where: { refId: `LOAN:${id}:2026-10-01` } });
    expect(await deleteExpense(e.id, "only")).toMatchObject({ ok: false, code: "KHOAN_VAY_DA_TAT_TOAN" });
    expect(
      await updateExpense(e.id, { date: "2026-10-01", categoryId: "interest", amount: 1, channelId: null, description: "" })
    ).toMatchObject({ ok: false, code: "KHOAN_VAY_DA_TAT_TOAN" });
    expect(await duNo(id)).toBe(0);
  });

  it("sửa mô tả dòng lãi (giữ số tiền) không chạm dòng nhập gốc", async () => {
    const id = await taoThauChi();
    await ghiKyTraNo({ loanId: id, ...KY_1 });
    const e = await dongLai();
    const truoc = await prisma.cashMovement.findFirstOrThrow({ where: { kind: "LAI_NHAP_GOC" } });
    expect(
      await updateExpense(e.id, { date: "2026-10-01", categoryId: "interest", amount: 676_027, channelId: null, description: "x" })
    ).toMatchObject({ ok: true });
    expect(await prisma.cashMovement.findFirstOrThrow({ where: { kind: "LAI_NHAP_GOC" } })).toEqual(truoc);
  });
});

describe("nợ phải trả: cổng < M, vân tay, ca đua với bước bật", () => {
  it("vân tay trước M: quỹ app KHÔNG đổi khi duyệt kỳ nhập gốc; dư nợ thấu chi cuối M−1 gồm lãi đã nhập", async () => {
    const id = await taoThauChi();
    const truoc = await docVanTayQuyTruocM(vn("2026-10-15"));
    expect(truoc.duNoThauChi).toBe(100_000_000);
    await ghiKyTraNo({ loanId: id, ...KY_1 });
    const sau = await docVanTayQuyTruocM(vn("2026-10-15"));
    expect(sau.quyApp).toBe(truoc.quyApp);
    expect(sau.duNoThauChi).toBe(100_676_027);
  });

  it("đã bật M = 15/10: kỳ 01/10 < M không ghi được đồng nào (cả cặp); 'không thu kỳ này' qua; kỳ 01/11 ≥ M ghi cả cặp", async () => {
    const id = await taoThauChi();
    await batM("2026-10-15");
    expect(await ghiKyTraNo({ loanId: id, ...KY_1 })).toMatchObject({ ok: false, code: "DA_BAT_NO_PHAI_TRA" });
    expect(await prisma.expense.count()).toBe(0);
    expect(await dongNhapGoc()).toEqual([]);

    expect(await ghiKyTraNo({ loanId: id, dueDate: "2026-10-01", lai: 0, goc: 0, boQua: true })).toMatchObject({ ok: true });
    // Kỳ 01/11 sau "không thu": lãi 01/10 → 01/11 trên 100tr (không có gì nhập gốc).
    expect(await ghiKyTraNo({ loanId: id, dueDate: "2026-11-01", lai: 997_945, goc: 0 })).toMatchObject({ ok: true });
    expect(await dongNhapGoc()).toEqual([{ amount: 997_945, date: vn("2026-11-01"), loanId: id }]);
    expect(await duNo(id)).toBe(100_997_945);
  });

  it("đã bật M = 15/10: sửa số / xoá dòng lãi kỳ 01/10 (< M) bị chặn, cặp nguyên vẹn", async () => {
    const id = await taoThauChi();
    await ghiKyTraNo({ loanId: id, ...KY_1 });
    await batM("2026-10-15");
    const e = await prisma.expense.findFirstOrThrow({ where: { categoryId: "interest" } });
    expect(await deleteExpense(e.id, "only")).toMatchObject({ ok: false, code: "DA_BAT_NO_PHAI_TRA" });
    expect(
      await updateExpense(e.id, { date: "2026-10-01", categoryId: "interest", amount: 1, channelId: null, description: "" })
    ).toMatchObject({ ok: false, code: "DA_BAT_NO_PHAI_TRA" });
    expect(await dongNhapGoc()).toEqual([{ amount: 676_027, date: vn("2026-10-01"), loanId: id }]);
    expect(await duNo(id)).toBe(100_676_027);
  });

  it("đã bật M = 15/10: gắn thẻ vào dòng lãi kỳ 01/11 (≥ M) bị từ chối ở ô thẻ — quỹ, dư nợ thấu chi, nợ thẻ không đổi", async () => {
    const id = await taoThauChi();
    await ghiKyTraNo({ loanId: id, ...KY_1 });
    await batM("2026-10-15");
    const the = await prisma.theTinDung.create({ data: { ten: "Thẻ A", ngayChotSaoKe: 25, ngayHanTra: 10 } });
    await prisma.kySaoKeThe.create({ data: { cardId: the.id, ngayChot: vn("2026-10-14"), soDu: 0, laNeoMoSo: true } });
    expect(await ghiKyTraNo({ loanId: id, ...KY_2 })).toMatchObject({ ok: true });
    const e = await prisma.expense.findFirstOrThrow({ where: { refId: `LOAN:${id}:2026-11-01` } });
    const noThe = async () => (await docTheKemTrangThai(prisma)).find((t) => t.id === the.id)?.duNo;
    const quyTruoc = await quyHomNay();
    const noTheTruoc = await noThe();

    expect(
      await updateExpense(e.id, {
        date: "2026-11-01",
        categoryId: "interest",
        amount: KY_2.lai,
        channelId: null,
        description: e.description,
        cardId: the.id,
      })
    ).toMatchObject({ ok: false, field: "cardId", code: "KY_VAY_KHOA_THE" });
    expect((await prisma.expense.findUniqueOrThrow({ where: { id: e.id } })).cardId).toBeNull();
    expect(await quyHomNay()).toBe(quyTruoc);
    expect(await noThe()).toBe(noTheTruoc);
    expect(await duNo(id)).toBe(101_680_719);
  });

  it("ca đua: duyệt kỳ 01/10 trong lúc bước bật (M = 15/10) giữ khoá ⇒ CHỜ rồi bị từ chối, không dòng nào", async () => {
    const id = await taoThauChi();
    const { r, ms } = await trongLucBuocBatGiuKhoa("2026-10-15", () => ghiKyTraNo({ loanId: id, ...KY_1 }));
    expect(ms).toBeGreaterThanOrEqual(700);
    expect(r).toMatchObject({ ok: false, code: "DA_BAT_NO_PHAI_TRA" });
    expect((await prisma.loan.findUniqueOrThrow({ where: { id } })).lastDueHandled).toBeNull();
    expect(await prisma.expense.count()).toBe(0);
    expect(await dongNhapGoc()).toEqual([]);
  });
});
