import { startOfDay } from "date-fns";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { createCashMovement } from "@/lib/actions/cash-movements";
import { ghiKyTraNo, suaKhoanVay, taoKhoanVay } from "@/lib/actions/khoan-vay";
import { tatToanThauChi } from "@/lib/actions/tat-toan-thau-chi";
import { prisma } from "@/lib/prisma";
import { listKhoanVay } from "@/lib/so-quy/khoan-vay-queries";
import { tinhSoQuyThang } from "@/lib/so-quy/so-quy-queries";
import { seedReference, truncateBusinessTables } from "./helpers/test-db";

/**
 * Integration test (`hogikids_test`) cho khoản vay loại THẤU CHI (spec 260908 §5, §7): `kind` trong
 * `taoKhoanVay`/`suaKhoanVay` + action `tatToanThauChi`. Mock `requireUser` + `revalidatePath` cùng
 * lý do với `khoan-vay-actions.integration.test.ts`.
 *
 * Mọi con số dưới đây là LITERAL tính tay theo bảng spec §4 (`Σ(dư nợ × ngày) × bp / 3.650.000`,
 * làm tròn nửa lên MỘT lần) — KHÔNG suy lại bằng chính hàm đang kiểm.
 *
 * Trọng tâm khác với vay kỳ hạn: tất toán ở đây GHI TIỀN (lãi + trọn gốc) chứ không chỉ đóng hồ sơ,
 * nên phải chốt được ba thứ — ghi đúng một lần, rollback trọn khi hỏng, và dư nợ sau lượt ghi = 0.
 */
vi.mock("@/lib/session", () => ({
  requireUser: vi.fn(async () => "test-user-id"),
}));
vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

/** "Hôm nay" giả: sau kỳ lãi 10/10 và sau ngày tất toán 25/10 (schema chặn ngày tương lai). */
const HOM_NAY = new Date(2026, 10, 1, 9, 0, 0);

/** Thấu chi rút mới: 100tr ngày 05/09/2026, 12%/năm, ngân hàng thu lãi mùng 10 hàng tháng. */
const THAU_CHI = {
  name: "E2E Thấu chi",
  lender: "MB Bank",
  annualRateBp: 1200,
  kind: "OVERDRAFT",
  coLich: true,
  firstDueDate: "2026-10-10",
  cheDo: "moi",
  soTienGiaiNgan: 100_000_000,
  ngayGiaiNgan: "2026-09-05",
  note: "",
};

/** Thấu chi đã rút TRƯỚC ngày mở sổ: chỉ dư nợ, KHÔNG dòng LOAN_IN (tiền đã trong số dư nhập quỹ). */
const THAU_CHI_MANG_SANG = {
  name: "Thấu chi mang sang",
  lender: "MB Bank",
  annualRateBp: 1200,
  kind: "OVERDRAFT",
  coLich: true,
  firstDueDate: "2026-09-10",
  cheDo: "mang-sang",
  duNoMoSo: 50_000_000,
  startDate: "2026-09-01",
  note: "",
};

/** Vay kỳ hạn để chốt ranh giới: `tatToanThauChi` KHÔNG được đụng tới nó. */
const KY_HAN = {
  name: "Vay kỳ hạn",
  lender: "VPBank",
  annualRateBp: 1050,
  coLich: true,
  termMonths: 12,
  firstDueDate: "2026-10-10",
  cheDo: "moi",
  soTienGiaiNgan: 200_000_000,
  ngayGiaiNgan: "2026-09-05",
  note: "",
};

/** BULLET để chốt ranh giới loại vay khoá vĩnh viễn — số THEO ca thật chủ shop (spec plan 260910). */
const BULLET = {
  name: "Vay gốc cuối kỳ",
  lender: "NH Chính sách",
  annualRateBp: 1050,
  kind: "BULLET",
  coLich: true,
  termMonths: 36,
  firstDueDate: "2026-06-10",
  cheDo: "moi",
  soTienGiaiNgan: 200_000_000,
  ngayGiaiNgan: "2026-05-12",
  laiCoDinhMoiKy: 1_121_096,
  tienGuiBatBuocMoiKy: 300_000,
  note: "",
};

const ngayVn = (ngay: string) => startOfDay(new Date(`${ngay}T00:00:00+07:00`));

async function taoThauChi(ghiDe: Record<string, unknown> = {}): Promise<string> {
  const res = await taoKhoanVay({ ...THAU_CHI, ...ghiDe });
  expect(res.ok).toBe(true);
  if (!res.ok) throw new Error(res.error);
  return res.data.id;
}

/** Trả bớt 40tr ngày 20/09 — mốc chia đoạn giữa kỳ, chỗ thấu chi khác hẳn vay kỳ hạn. */
async function traBot40Trieu(loanId: string): Promise<void> {
  const res = await createCashMovement({
    date: "2026-09-20",
    kind: "LOAN_REPAY",
    amount: 40_000_000,
    loanId,
    description: "Trả bớt gốc",
  });
  expect(res.ok).toBe(true);
}

/** Kỳ lãi 10/10 sau khi đã trả bớt 40tr: 15 ngày × 100tr + 20 ngày × 60tr ⇒ 887.671, gốc 0. */
const KY_LAI_SAU_TRA_BOT = { dueDate: "2026-10-10", lai: 887_671, goc: 0 };

beforeAll(async () => {
  await seedReference();
}, 60_000);

beforeEach(async () => {
  await truncateBusinessTables();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(HOM_NAY);
});

afterEach(() => {
  vi.useRealTimers();
});

afterAll(async () => {
  await truncateBusinessTables();
  await prisma.$disconnect();
});

describe("taoKhoanVay — thấu chi", () => {
  it('rút mới → kind OVERDRAFT, termMonths NULL, 1 LOAN_IN; kỳ lãi đề xuất 1.150.685 gốc 0', async () => {
    const id = await taoThauChi();

    const loan = await prisma.loan.findUniqueOrThrow({ where: { id } });
    expect(loan).toMatchObject({
      kind: "OVERDRAFT",
      name: "E2E Thấu chi",
      annualRateBp: 1200,
      termMonths: null, // thấu chi KHÔNG có lịch trả gốc
      duNoMoSo: 0,
      lastDueHandled: null,
      closedAt: null,
    });
    expect(loan.startDate).toEqual(ngayVn("2026-09-05"));
    expect(loan.firstDueDate).toEqual(ngayVn("2026-10-10"));

    const dong = await prisma.cashMovement.findFirstOrThrow();
    expect(dong).toMatchObject({ kind: "LOAN_IN", amount: 100_000_000, loanId: id });
    // BẤT BIẾN: LOAN_IN.date = startOfDay(Loan.startDate).
    expect(dong.date).toEqual(startOfDay(loan.startDate));
    expect(await prisma.cashMovement.count()).toBe(1);

    const row = (await listKhoanVay())[0];
    expect(row.duNo).toBe(100_000_000);
    expect(row.giaiNganNgay).toEqual(ngayVn("2026-09-05"));
    expect(row.traGoc).toEqual([]);
    // 35 ngày × 100tr ⇒ 4,2e12 / 3,65e6 = 1.150.684,93; ngân hàng chỉ thu LÃI.
    expect(row.kyCho).toMatchObject({ ky: 1, soNgay: 35, lai: 1_150_685, goc: 0 });
    // Lãi tới hôm nay (01/11): 57 ngày × 100tr ⇒ 6,84e12 / 3,65e6 = 1.873.972,60.
    expect(row.laiTamTinh).toBe(1_873_973);
  });

  it("gửi kèm termMonths → ÉP NULL chứ không từ chối (form đổi loại giữa chừng)", async () => {
    const id = await taoThauChi({ termMonths: 12 });
    expect((await prisma.loan.findUniqueOrThrow({ where: { id } })).termMonths).toBeNull();
  });

  it("mang sang → 0 dòng tiền, quỹ không cộng đồng nào; kỳ lãi 9 ngày = 147.945", async () => {
    const res = await taoKhoanVay(THAU_CHI_MANG_SANG);
    expect(res.ok).toBe(true);

    expect(await prisma.cashMovement.count()).toBe(0);
    const row = (await listKhoanVay())[0];
    expect(row.kind).toBe("OVERDRAFT");
    expect(row.duNo).toBe(50_000_000);
    expect(row.giaiNganNgay).toBeNull();
    // 9 ngày (01/09 → 10/09) × 50tr ⇒ 4,5e8 × 1200 / 3,65e6 = 147.945,20.
    expect(row.kyCho).toMatchObject({ ky: 1, soNgay: 9, lai: 147_945, goc: 0 });
    // Lãi tới hôm nay (01/11): 61 ngày × 50tr ⇒ 3,66e12 / 3,65e6 = 1.002.739,73.
    expect(row.laiTamTinh).toBe(1_002_740);

    // Tiền thấu chi rút trước ngày mở sổ ĐÃ nằm trong số dư nhập quỹ — cộng thêm là thổi phồng 50tr.
    const quy = await tinhSoQuyThang({ from: new Date(2026, 8, 1), to: new Date(2026, 8, 30) });
    expect(quy.quyHomNay).toBe(0);
  });

  it("ngày thu lãi kỳ đầu không sau ngày rút → từ chối bằng câu của thấu chi", async () => {
    const res = await taoKhoanVay({ ...THAU_CHI, firstDueDate: "2026-09-05" });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.field).toBe("firstDueDate");
      expect(res.error).toBe("Ngày thu lãi kỳ đầu phải sau ngày rút");
    }
    expect(await prisma.loan.count()).toBe(0);
  });

  it("vay kỳ hạn KHÔNG khai kind → mặc định TERM, hành vi cũ không đổi", async () => {
    const res = await taoKhoanVay(KY_HAN);
    expect(res.ok).toBe(true);
    const loan = await prisma.loan.findFirstOrThrow();
    expect(loan.kind).toBe("TERM");
    expect(loan.termMonths).toBe(12);
    expect((await listKhoanVay())[0].laiTamTinh).toBeNull();
  });

  /**
   * `laiCoDinhMoiKy` CHỈ dành cho BULLET — một khoản không khai `kind` (mặc định TERM) mà lỡ gửi
   * kèm số đó (form đổi loại giữa chừng, hay copy payload từ khoản BULLET khác) phải bị chặn TẠI Ô,
   * không được âm thầm nuốt số rồi lờ đi (`deXuatKy` chỉ đọc cột này ở nhánh BULLET).
   */
  it("vay kỳ hạn (mặc định TERM) mà gửi kèm laiCoDinhMoiKy → từ chối tại ô, KHÔNG ghi gì", async () => {
    const res = await taoKhoanVay({ ...KY_HAN, laiCoDinhMoiKy: 1_121_096 });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.field).toBe("laiCoDinhMoiKy");
      expect(res.error).toBe("Chỉ khoản vay trả gốc cuối kỳ mới khai lãi cố định");
    }
    expect(await prisma.loan.count()).toBe(0);
  });

  /**
   * Hàng rào cuối dưới DB cho đường ghi thẳng (script, psql): action đã ép `termMonths` NULL, nhưng
   * lời khai "thấu chi không có kỳ hạn gốc" phải đúng cả khi không ai đi qua zod.
   */
  it("CHECK Loan_lich_theo_loai chặn OVERDRAFT có termMonths khi ghi THẲNG bằng Prisma", async () => {
    await expect(
      prisma.loan.create({
        data: {
          name: "Thấu chi ghi thẳng",
          kind: "OVERDRAFT",
          termMonths: 12,
          firstDueDate: ngayVn("2026-10-10"),
          startDate: ngayVn("2026-09-05"),
          annualRateBp: 1200,
        },
      })
    ).rejects.toThrow(/Loan_lich_theo_loai/);
    expect(await prisma.loan.count()).toBe(0);
  });
});

describe("ghiKyTraNo — kỳ lãi thấu chi", () => {
  it("duyệt kỳ lãi → 1 Expense interest, KHÔNG dòng LOAN_REPAY nào, dư nợ giữ nguyên", async () => {
    const id = await taoThauChi();

    const res = await ghiKyTraNo({ loanId: id, dueDate: "2026-10-10", lai: 1_150_685, goc: 0 });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.data.duNoConLai).toBe(100_000_000);

    const chi = await prisma.expense.findFirstOrThrow();
    expect(chi).toMatchObject({
      categoryId: "interest",
      amount: 1_150_685,
      source: "MANUAL",
      refId: `LOAN:${id}:2026-10-10`,
    });
    expect(chi.description).toBe("Lãi vay E2E Thấu chi — kỳ 10/10/2026");
    expect(await prisma.cashMovement.count({ where: { kind: "LOAN_REPAY" } })).toBe(0);
    expect((await prisma.loan.findUniqueOrThrow({ where: { id } })).lastDueHandled).toEqual(
      ngayVn("2026-10-10")
    );
  });

  it("trả bớt 40tr ngày 20/09 → đề xuất kỳ 1 còn 887.671, KHÁC lãi trên dư nợ đầu kỳ", async () => {
    const id = await taoThauChi();
    await traBot40Trieu(id);

    const row = (await listKhoanVay())[0];
    expect(row.duNo).toBe(60_000_000);
    // 15 ngày × 100tr + 20 ngày × 60tr = 2,7e9 ⇒ × 1200 / 3,65e6 = 887.671,23.
    expect(row.kyCho).toMatchObject({ ky: 1, soNgay: 35, lai: 887_671, goc: 0 });
    expect(row.kyCho?.lai).not.toBe(1_150_685);
  });
});

describe("tatToanThauChi", () => {
  /** Dựng đúng ca spec §4 dòng 3: rút 100tr, trả bớt 40tr 20/09, đã duyệt kỳ lãi 10/10. */
  async function dungCaTatToan(): Promise<string> {
    const id = await taoThauChi();
    await traBot40Trieu(id);
    expect((await ghiKyTraNo({ loanId: id, ...KY_LAI_SAU_TRA_BOT })).ok).toBe(true);
    return id;
  }

  /** Lượt tất toán "chuẩn" của ca spec §4 dòng 3 — 25/10, lãi 295.890, con dấu client = kỳ 10/10. */
  const tatToan2510 = (loanId: string) =>
    tatToanThauChi({ loanId, ngayTatToan: "2026-10-25", lai: 295_890, conDauDaThay: "2026-10-10" });

  it("25/10 sau khi duyệt kỳ lãi → Expense 295.890 + LOAN_REPAY 60tr, đóng khoản, dư nợ 0", async () => {
    const id = await dungCaTatToan();

    const res = await tatToanThauChi({
      loanId: id,
      ngayTatToan: "2026-10-25",
      lai: 295_890,
      conDauDaThay: "2026-10-10", // con dấu kỳ lãi vừa duyệt, đúng thứ client đang thấy
    });
    expect(res.ok).toBe(true);
    // 15 ngày (10/10 con dấu → 25/10) × 60tr = 9e8 ⇒ × 1200 / 3,65e6 = 295.890,41.
    if (res.ok) expect(res.data).toEqual({ lai: 295_890, goc: 60_000_000 });

    const chiTatToan = await prisma.expense.findUniqueOrThrow({
      where: { refId: `LOAN:${id}:2026-10-25` },
    });
    expect(chiTatToan).toMatchObject({ categoryId: "interest", amount: 295_890, source: "MANUAL" });
    expect(chiTatToan.date).toEqual(ngayVn("2026-10-25"));
    expect(chiTatToan.description).toBe("Lãi vay E2E Thấu chi — tất toán 25/10/2026");
    expect(await prisma.expense.count()).toBe(2); // kỳ lãi 10/10 + tất toán 25/10

    const traGoc = await prisma.cashMovement.findMany({
      where: { loanId: id, kind: "LOAN_REPAY" },
      orderBy: { date: "asc" },
    });
    expect(traGoc).toHaveLength(2);
    expect(traGoc[1]).toMatchObject({ amount: 60_000_000 });
    expect(traGoc[1].date).toEqual(ngayVn("2026-10-25"));
    expect(traGoc[1].description).toBe("Trả gốc E2E Thấu chi — tất toán 25/10/2026");

    const loan = await prisma.loan.findUniqueOrThrow({ where: { id } });
    expect(loan.closedAt).not.toBeNull();
    expect(loan.lastDueHandled).toEqual(ngayVn("2026-10-25"));

    const row = (await listKhoanVay())[0];
    expect(row.duNo).toBe(0);
    expect(row.kyCho).toBeNull();
    expect(row.laiTamTinh).toBeNull(); // khoản đã đóng thì không còn lãi đang chạy
  });

  it("gọi lại lần hai → 'Khoản vay đã tất toán', số dòng KHÔNG đổi", async () => {
    const id = await dungCaTatToan();
    expect((await tatToan2510(id)).ok).toBe(true);

    const lai = await tatToanThauChi({
      loanId: id,
      ngayTatToan: "2026-10-26",
      lai: 10_000,
      conDauDaThay: "2026-10-25",
    });
    expect(lai.ok).toBe(false);
    if (!lai.ok) expect(lai.error).toBe("Khoản vay đã tất toán");

    expect(await prisma.expense.count()).toBe(2);
    expect(await prisma.cashMovement.count({ where: { kind: "LOAN_REPAY" } })).toBe(2);
  });

  it("hai tab bấm CÙNG LÚC → đúng 1 lượt ok, đúng 1 bộ dòng, dư nợ 0", async () => {
    const id = await taoThauChi();

    const ket = await Promise.all([
      tatToanThauChi({ loanId: id, ngayTatToan: "2026-10-25", lai: 1_643_836, conDauDaThay: null }),
      tatToanThauChi({ loanId: id, ngayTatToan: "2026-10-25", lai: 1_643_836, conDauDaThay: null }),
    ]);

    expect(ket.filter((r) => r.ok)).toHaveLength(1);
    expect(await prisma.expense.count()).toBe(1);
    expect(await prisma.cashMovement.count({ where: { kind: "LOAN_REPAY" } })).toBe(1);
    expect((await listKhoanVay())[0].duNo).toBe(0);
  });

  /**
   * Tab mở TRƯỚC lượt duyệt kỳ lãi ở nơi khác: nó đề xuất lãi từ NGÀY RÚT (gồm cả những ngày kỳ vừa
   * duyệt đã thu) ⇒ ghi tiếp là chi phí lãi tính hai lần. Fencing chỉ canh NGÀY tất toán (10/10 <
   * 25/10 nên vẫn lọt) và `refId` cũng khác ngày ⇒ cổng duy nhất bắt được là con dấu client gửi kèm.
   */
  it("ảnh chụp con dấu CŨ (tab mở trước lượt duyệt kỳ lãi) → từ chối, không ghi lãi trùng", async () => {
    const id = await dungCaTatToan(); // con dấu THẬT = 10/10 (kỳ lãi vừa duyệt)

    // 1.446.575 = lãi tính từ ngày rút 05/09 tới 25/10 — trùng đúng đoạn kỳ 10/10 đã thu.
    const res = await tatToanThauChi({
      loanId: id,
      ngayTatToan: "2026-10-25",
      lai: 1_446_575,
      conDauDaThay: null,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("Kỳ lãi vừa được duyệt ở nơi khác");

    expect(await prisma.expense.count()).toBe(1); // chỉ dòng lãi kỳ 10/10
    expect(await prisma.cashMovement.count({ where: { kind: "LOAN_REPAY" } })).toBe(1); // trả bớt 20/09
    const loan = await prisma.loan.findUniqueOrThrow({ where: { id } });
    expect(loan.closedAt).toBeNull();
    expect(loan.lastDueHandled).toEqual(ngayVn("2026-10-10"));
  });

  it("ngày tất toán TRƯỚC lần trả gốc gần nhất → từ chối, KHÔNG ghi gì", async () => {
    const id = await taoThauChi();
    await traBot40Trieu(id); // 20/09

    const res = await tatToanThauChi({
      loanId: id,
      ngayTatToan: "2026-09-15",
      lai: 100_000,
      conDauDaThay: null,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe("Ngày tất toán phải từ dòng gốc gần nhất (20/09/2026) trở đi");

    expect(await prisma.expense.count()).toBe(0);
    expect(await prisma.cashMovement.count({ where: { kind: "LOAN_REPAY" } })).toBe(1);
    const loan = await prisma.loan.findUniqueOrThrow({ where: { id } });
    expect(loan.closedAt).toBeNull();
    expect(loan.lastDueHandled).toBeNull();
  });

  it("ngày tất toán TRƯỚC ngày rút (khoản mang sang, không có LOAN_IN) → từ chối", async () => {
    const res = await taoKhoanVay(THAU_CHI_MANG_SANG);
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    const tt = await tatToanThauChi({
      loanId: res.data.id,
      ngayTatToan: "2026-08-25",
      lai: 0,
      conDauDaThay: null,
    });
    expect(tt.ok).toBe(false);
    if (!tt.ok) expect(tt.error).toBe("Ngày tất toán phải từ ngày rút (01/09/2026) trở đi");
    expect((await prisma.loan.findUniqueOrThrow({ where: { id: res.data.id } })).closedAt).toBeNull();
  });

  it("lãi vượt trần 2 tỷ → từ chối đúng ô, khoản vẫn MỞ, không dòng nào", async () => {
    const id = await taoThauChi();

    const res = await tatToanThauChi({
      loanId: id,
      ngayTatToan: "2026-10-25",
      lai: 3_000_000_000,
      conDauDaThay: null,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.field).toBe("lai");
      expect(res.error).toBe("Số tiền quá lớn (tối đa 2 tỷ)");
    }

    expect((await prisma.loan.findUniqueOrThrow({ where: { id } })).closedAt).toBeNull();
    expect(await prisma.expense.count()).toBe(0);
    expect(await prisma.cashMovement.count({ where: { kind: "LOAN_REPAY" } })).toBe(0);
  });

  it("gọi cho khoản vay KỲ HẠN → 'Chỉ dùng cho thấu chi', không ghi gì", async () => {
    const tao = await taoKhoanVay(KY_HAN);
    expect(tao.ok).toBe(true);
    if (!tao.ok) return;

    const res = await tatToanThauChi({
      loanId: tao.data.id,
      ngayTatToan: "2026-10-25",
      lai: 100,
      conDauDaThay: null,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("Chỉ dùng cho thấu chi");

    expect((await prisma.loan.findUniqueOrThrow({ where: { id: tao.data.id } })).closedAt).toBeNull();
    expect(await prisma.expense.count()).toBe(0);
    expect(await prisma.cashMovement.count({ where: { kind: "LOAN_REPAY" } })).toBe(0);
  });

  it("id lạ → lỗi tiếng Việt, không 500", async () => {
    const res = await tatToanThauChi({
      loanId: "clzzzzzzzzzzzzzzzzzzzzzzz",
      ngayTatToan: "2026-10-25",
      lai: 0,
      conDauDaThay: null,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe("Không tìm thấy khoản vay");
  });

  /**
   * Con dấu KHÔNG lùi khi mở lại: tất toán lại phải chọn ngày SAU con dấu, nếu không phần lãi của
   * những ngày đã thu bị tính lần thứ hai.
   */
  it("Mở lại → tất toán lại ngày sau ok; tất toán lại ĐÚNG ngày cũ bị fencing chặn", async () => {
    const id = await dungCaTatToan();
    expect((await tatToan2510(id)).ok).toBe(true);

    const moLai = await suaKhoanVay(id, { ...THAU_CHI, moLai: true });
    expect(moLai.ok).toBe(true);
    expect((await prisma.loan.findUniqueOrThrow({ where: { id } })).closedAt).toBeNull();

    const trung = await tatToanThauChi({
      loanId: id,
      ngayTatToan: "2026-10-25",
      lai: 0,
      conDauDaThay: "2026-10-25",
    });
    expect(trung.ok).toBe(false);
    if (!trung.ok) {
      expect(trung.error).toBe("Kỳ lãi ngày 25/10/2026 đã thu — chọn ngày tất toán sau ngày đó");
      expect(trung.field).toBe("ngayTatToan");
    }

    // Dư nợ đã về 0 ở lượt trước ⇒ lượt này chỉ đóng khoản, không sinh thêm dòng nào.
    const lai = await tatToanThauChi({
      loanId: id,
      ngayTatToan: "2026-10-26",
      lai: 0,
      conDauDaThay: "2026-10-25",
    });
    expect(lai.ok).toBe(true);
    if (lai.ok) expect(lai.data).toEqual({ lai: 0, goc: 0 });

    const loan = await prisma.loan.findUniqueOrThrow({ where: { id } });
    expect(loan.closedAt).not.toBeNull();
    expect(loan.lastDueHandled).toEqual(ngayVn("2026-10-26"));
    expect(await prisma.expense.count()).toBe(2);
    expect(await prisma.cashMovement.count({ where: { kind: "LOAN_REPAY" } })).toBe(2);
  });
});

describe("suaKhoanVay — loại khoản vay khoá vĩnh viễn", () => {
  it("thấu chi đổi sang kỳ hạn → từ chối, hồ sơ giữ nguyên", async () => {
    const id = await taoThauChi();

    const res = await suaKhoanVay(id, { ...THAU_CHI, kind: "TERM", termMonths: 12 });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe("Không đổi loại khoản vay sau khi tạo");

    const loan = await prisma.loan.findUniqueOrThrow({ where: { id } });
    expect(loan.kind).toBe("OVERDRAFT");
    expect(loan.termMonths).toBeNull();
  });

  it("vay kỳ hạn đổi sang thấu chi → từ chối, kỳ hạn giữ nguyên", async () => {
    const tao = await taoKhoanVay(KY_HAN);
    expect(tao.ok).toBe(true);
    if (!tao.ok) return;

    const res = await suaKhoanVay(tao.data.id, { ...KY_HAN, kind: "OVERDRAFT" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe("Không đổi loại khoản vay sau khi tạo");
    expect((await prisma.loan.findUniqueOrThrow({ where: { id: tao.data.id } })).termMonths).toBe(12);
  });

  it("giữ nguyên loại → sửa được tên và lãi suất như thường", async () => {
    const id = await taoThauChi();

    const res = await suaKhoanVay(id, { ...THAU_CHI, name: "Thấu chi đổi tên", annualRateBp: 1350 });
    expect(res.ok).toBe(true);
    expect(await prisma.loan.findUniqueOrThrow({ where: { id } })).toMatchObject({
      kind: "OVERDRAFT",
      name: "Thấu chi đổi tên",
      annualRateBp: 1350,
      termMonths: null,
    });
  });

  it("BULLET đổi sang kỳ hạn → từ chối, hồ sơ (kể cả laiCoDinhMoiKy) giữ nguyên", async () => {
    const tao = await taoKhoanVay(BULLET);
    expect(tao.ok).toBe(true);
    if (!tao.ok) return;

    // laiCoDinhMoiKy: null + tienGuiBatBuocMoiKy: 0 vì đang đổi SANG TERM — giữ số cũ thì superRefine
    // chặn ngay ở lỗi của Ô ("Chỉ khoản vay trả gốc cuối kỳ mới khai lãi cố định" / "… mới có tiền gửi
    // tiết kiệm bắt buộc") TRƯỚC khi tới được luật khoá loại vay, làm sai lệch phép kiểm đang nhắm
    // tới (khoá LOẠI, không phải khoá Ô).
    const res = await suaKhoanVay(tao.data.id, {
      ...BULLET,
      kind: "TERM",
      laiCoDinhMoiKy: null,
      tienGuiBatBuocMoiKy: 0,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe("Không đổi loại khoản vay sau khi tạo");

    const loan = await prisma.loan.findUniqueOrThrow({ where: { id: tao.data.id } });
    expect(loan.kind).toBe("BULLET");
    expect(loan.laiCoDinhMoiKy).toBe(1_121_096);
    expect(loan.tienGuiBatBuocMoiKy).toBe(300_000);
  });

  it("vay kỳ hạn đổi sang BULLET → từ chối, laiCoDinhMoiKy vẫn NULL", async () => {
    const tao = await taoKhoanVay(KY_HAN);
    expect(tao.ok).toBe(true);
    if (!tao.ok) return;

    const res = await suaKhoanVay(tao.data.id, {
      ...KY_HAN,
      kind: "BULLET",
      laiCoDinhMoiKy: 1_121_096,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe("Không đổi loại khoản vay sau khi tạo");

    const loan = await prisma.loan.findUniqueOrThrow({ where: { id: tao.data.id } });
    expect(loan.kind).toBe("TERM");
    expect(loan.laiCoDinhMoiKy).toBeNull();
  });
});
