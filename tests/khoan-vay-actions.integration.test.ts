import { addMonths, format, startOfDay } from "date-fns";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { createCashMovement, deleteCashMovement } from "@/lib/actions/cash-movements";
import { deleteExpense } from "@/lib/actions/expenses";
import {
  ghiKyTraNo,
  suaKhoanVay,
  taoKhoanVay,
  tatToanKhoanVay,
  xoaKhoanVay,
} from "@/lib/actions/khoan-vay";
import { prisma } from "@/lib/prisma";
import { listKhoanVay } from "@/lib/so-quy/khoan-vay-queries";
import { tinhSoQuyThang } from "@/lib/so-quy/so-quy-queries";
import { seedReference, truncateBusinessTables } from "./helpers/test-db";

/**
 * Integration test (`hogikids_test`) cho 5 server action khoản vay. Mock `requireUser` (gọi
 * `cookies()` — không có request scope trong vitest) + `revalidatePath` (cùng lý do), giống
 * `cash-movements-actions.integration.test.ts`.
 *
 * Đây là logic TIỀN: mọi con số dưới đây là số LITERAL tính tay theo spec §5.2, không suy lại bằng
 * chính công thức đang kiểm. Trọng tâm:
 *  - kỳ trả nợ ghi ĐÚNG MỘT LẦN (con dấu `lastDueHandled` + `refId @unique`), kể cả hai tab bấm
 *    cùng lúc;
 *  - vị từ dư nợ chặn mọi đường làm dư nợ ÂM;
 *  - lỗi nào cũng phải ROLLBACK trọn: không có ca "ghi lãi rồi chết ở gốc".
 *
 * `vi.useFakeTimers({ toFake: ["Date"] })` — CHỈ Date: fake luôn timer thì Prisma/pool treo.
 */
vi.mock("@/lib/session", () => ({
  requireUser: vi.fn(async () => "test-user-id"),
}));
vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

/** "Hôm nay" giả cho cả suite: sau kỳ 1 (10/10) nên kỳ đó đã tới hạn, trước kỳ 2 (10/11). */
const HOM_NAY = new Date(2026, 10, 1, 9, 0, 0);

/** Khoản vay chế độ "khoản mới" của spec §6: giải ngân 200tr ngày 05/09, kỳ đầu 10/10, 12 kỳ, 10,5%/năm. */
const KHOAN_MOI = {
  name: "E2E VPBank",
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

/** Khoản vay có TRƯỚC ngày mở sổ: chỉ dư nợ, KHÔNG sinh dòng tiền vào. */
const KHOAN_MANG_SANG = {
  name: "Vay cũ mang sang",
  lender: "Người thân",
  annualRateBp: 900,
  coLich: true,
  termMonths: 10,
  firstDueDate: "2026-10-10",
  cheDo: "mang-sang",
  duNoMoSo: 200_000_000,
  startDate: "2026-10-01",
  note: "",
};

const ngayVn = (ngay: string) => startOfDay(new Date(`${ngay}T00:00:00+07:00`));

async function taoKhoan(ghiDe: Record<string, unknown> = {}): Promise<string> {
  const res = await taoKhoanVay({ ...KHOAN_MOI, ...ghiDe });
  expect(res.ok).toBe(true);
  if (!res.ok) throw new Error(res.error);
  return res.data.id;
}

/** Kỳ 1 của `KHOAN_MOI`: 05/09 → 10/10 = 35 ngày · 200tr × 10,5%/năm × 35/365 = 2.013.699 · gốc = 200tr/12. */
const KY1 = { dueDate: "2026-10-10", lai: 2_013_699, goc: 16_666_667 };
const DU_NO_SAU_KY1 = 183_333_333;

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

describe("taoKhoanVay", () => {
  it('chế độ "moi" → 1 Loan + ĐÚNG 1 dòng LOAN_IN gắn khoản, dư nợ = số giải ngân', async () => {
    const id = await taoKhoan();

    const loan = await prisma.loan.findUniqueOrThrow({ where: { id } });
    expect(loan).toMatchObject({
      name: "E2E VPBank",
      lender: "VPBank",
      annualRateBp: 1050,
      termMonths: 12,
      duNoMoSo: 0,
      lastDueHandled: null,
      closedAt: null,
    });
    // Khoản mới: ngày bắt đầu = ngày giải ngân (due_0 để đếm ngày kỳ 1).
    expect(loan.startDate).toEqual(ngayVn("2026-09-05"));
    expect(loan.firstDueDate).toEqual(ngayVn("2026-10-10"));

    const dong = await prisma.cashMovement.findFirstOrThrow();
    expect(dong).toMatchObject({ kind: "LOAN_IN", amount: 200_000_000, loanId: id });
    // BẤT BIẾN: LOAN_IN.date = startOfDay(Loan.startDate) — dư nợ đếm theo NGÀY DÒNG TIỀN.
    expect(dong.date).toEqual(startOfDay(loan.startDate));
    expect(await prisma.cashMovement.count()).toBe(1);

    const rows = await listKhoanVay();
    expect(rows).toHaveLength(1);
    expect(rows[0].duNo).toBe(200_000_000);
    // Đề xuất kỳ 1 phải khớp số spec — nút bấm của chủ shop prefill từ đây.
    expect(rows[0].kyCho).toMatchObject({ ky: 1, soNgay: 35, lai: 2_013_699, goc: 16_666_667 });
  });

  it('chế độ "mang-sang" → 0 dòng tiền, dư nợ = duNoMoSo, QUỸ không cộng đồng nào', async () => {
    const res = await taoKhoanVay(KHOAN_MANG_SANG);
    expect(res.ok).toBe(true);

    expect(await prisma.cashMovement.count()).toBe(0);
    const rows = await listKhoanVay();
    expect(rows[0].duNoMoSo).toBe(200_000_000);
    expect(rows[0].duNo).toBe(200_000_000);
    expect(rows[0].startDate).toEqual(ngayVn("2026-10-01"));

    // Tiền vay cũ ĐÃ nằm trong số dư mở sổ — ghi thêm vào quỹ là thổi phồng 200tr.
    const quy = await tinhSoQuyThang({ from: new Date(2026, 9, 1), to: new Date(2026, 9, 31) });
    expect(quy.d0).toBeNull();
    expect(quy.quyHomNay).toBe(0);
  });

  it("tắt lịch → termMonths và firstDueDate cùng NULL, không có kỳ chờ duyệt", async () => {
    const id = await taoKhoan({ coLich: false, termMonths: undefined, firstDueDate: undefined });

    const loan = await prisma.loan.findUniqueOrThrow({ where: { id } });
    expect(loan.termMonths).toBeNull();
    expect(loan.firstDueDate).toBeNull();
    expect((await listKhoanVay())[0].kyCho).toBeNull();
  });

  it.each([
    [{ name: "" }, "name"],
    [{ name: "x".repeat(61) }, "name"],
    [{ annualRateBp: 10_001 }, "annualRateBp"],
    [{ annualRateBp: -1 }, "annualRateBp"],
    [{ termMonths: 0 }, "termMonths"],
    [{ termMonths: undefined }, "termMonths"],
    [{ firstDueDate: undefined }, "firstDueDate"],
    [{ soTienGiaiNgan: 0 }, "soTienGiaiNgan"],
    [{ soTienGiaiNgan: 2_500_000_000 }, "soTienGiaiNgan"],
    [{ note: "x".repeat(2001) }, "note"],
  ])("input xấu %o → từ chối đúng ô, KHÔNG ghi gì", async (ghiDe, field) => {
    const res = await taoKhoanVay({ ...KHOAN_MOI, ...ghiDe });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.field).toBe(field);
    expect(await prisma.loan.count()).toBe(0);
    expect(await prisma.cashMovement.count()).toBe(0);
  });

  it("ngày trả kỳ đầu KHÔNG sau ngày giải ngân → từ chối", async () => {
    const res = await taoKhoanVay({ ...KHOAN_MOI, firstDueDate: "2026-09-05" });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.field).toBe("firstDueDate");
      expect(res.error).toBe("Ngày trả kỳ đầu phải sau ngày giải ngân");
    }
    expect(await prisma.loan.count()).toBe(0);
  });

  it("ngày giải ngân ở tương lai → từ chối (cùng luật với mọi dòng ghi tay)", async () => {
    const res = await taoKhoanVay({ ...KHOAN_MOI, ngayGiaiNgan: "2026-12-01" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe("Không cho ngày tương lai");
  });
});

describe("ghiKyTraNo", () => {
  it("duyệt kỳ 1 → 1 Expense lãi (danh mục interest) + 1 LOAN_REPAY, dư nợ giảm đúng", async () => {
    const id = await taoKhoan();

    const res = await ghiKyTraNo({ loanId: id, ...KY1 });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.duNoConLai).toBe(DU_NO_SAU_KY1);

    const chi = await prisma.expense.findFirstOrThrow();
    expect(chi).toMatchObject({
      categoryId: "interest",
      amount: 2_013_699,
      source: "MANUAL",
      refId: `LOAN:${id}:2026-10-10`,
    });
    expect(chi.date).toEqual(ngayVn("2026-10-10"));
    expect(chi.description).toBe("Lãi vay E2E VPBank — kỳ 10/10/2026");

    const traGoc = await prisma.cashMovement.findFirstOrThrow({ where: { kind: "LOAN_REPAY" } });
    expect(traGoc).toMatchObject({ amount: 16_666_667, loanId: id });
    expect(traGoc.date).toEqual(ngayVn("2026-10-10"));

    const loan = await prisma.loan.findUniqueOrThrow({ where: { id } });
    expect(loan.lastDueHandled).toEqual(ngayVn("2026-10-10"));
    expect((await listKhoanVay())[0].duNo).toBe(DU_NO_SAU_KY1);
  });

  it("gọi lại CÙNG kỳ → 'Kỳ này đã được ghi', số dòng KHÔNG đổi", async () => {
    const id = await taoKhoan();
    expect((await ghiKyTraNo({ loanId: id, ...KY1 })).ok).toBe(true);

    const lai = await ghiKyTraNo({ loanId: id, ...KY1 });
    expect(lai.ok).toBe(false);
    if (!lai.ok) expect(lai.error).toBe("Kỳ này đã được ghi");

    expect(await prisma.expense.count()).toBe(1);
    expect(await prisma.cashMovement.count({ where: { kind: "LOAN_REPAY" } })).toBe(1);
  });

  it("hai tab bấm CÙNG LÚC → đúng 1 lượt ok, đúng 1 bộ dòng", async () => {
    const id = await taoKhoan();

    const ket = await Promise.all([
      ghiKyTraNo({ loanId: id, ...KY1 }),
      ghiKyTraNo({ loanId: id, ...KY1 }),
    ]);

    expect(ket.filter((r) => r.ok)).toHaveLength(1);
    expect(await prisma.expense.count()).toBe(1);
    expect(await prisma.cashMovement.count({ where: { kind: "LOAN_REPAY" } })).toBe(1);
  });

  it("hai tab bấm CÙNG LÚC, kỳ KHÔNG có lãi → vẫn đúng 1 lượt ok (chỉ fencing đỡ)", async () => {
    // Mọi ca đua khác đều `lai > 0` nên `refId @unique` có thể là thứ chặn thật. `lai: 0` không sinh
    // Expense ⇒ nếu điều kiện con dấu trong câu UPDATE hỏng, ca này ghi đôi dòng trả gốc.
    const id = await taoKhoan();

    const ket = await Promise.all([
      ghiKyTraNo({ loanId: id, dueDate: KY1.dueDate, lai: 0, goc: 16_666_667 }),
      ghiKyTraNo({ loanId: id, dueDate: KY1.dueDate, lai: 0, goc: 16_666_667 }),
    ]);

    expect(ket.filter((r) => r.ok)).toHaveLength(1);
    expect(await prisma.expense.count()).toBe(0);
    expect(await prisma.cashMovement.count({ where: { kind: "LOAN_REPAY" } })).toBe(1);
    expect((await listKhoanVay())[0].duNo).toBe(DU_NO_SAU_KY1);
  });

  it("duyệt kỳ chạy CÙNG LÚC với một dòng trả gốc ghi tay → đúng 1 lượt ok, dư nợ không âm", async () => {
    // Serializable MỘT PHÍA không cứu: SSI chỉ bắt khi cả hai phía Serializable. Cái đỡ ở đây là
    // khoá dòng `Loan` mà cả hai đường ghi đều phải giành.
    const id = await taoKhoan();

    const ket = await Promise.all([
      ghiKyTraNo({ loanId: id, dueDate: KY1.dueDate, lai: 0, goc: 150_000_000 }),
      createCashMovement({
        date: "2026-10-20",
        kind: "LOAN_REPAY",
        amount: 150_000_000,
        description: "Trả gốc ghi tay",
        loanId: id,
      }),
    ]);

    expect(ket.filter((r) => r.ok)).toHaveLength(1);
    const duNo = (await listKhoanVay())[0].duNo;
    expect(duNo).toBe(50_000_000);
    expect(duNo).toBeGreaterThanOrEqual(0);
  });

  it("kỳ không lãi cũng không gốc mà KHÔNG khai bỏ qua → từ chối, con dấu không đổi", async () => {
    const id = await taoKhoan();

    const res = await ghiKyTraNo({ loanId: id, dueDate: KY1.dueDate, lai: 0, goc: 0 });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toBe("Kỳ không có lãi, gốc lẫn tiền gửi — dùng nút 'Ngân hàng không thu kỳ này'");
    }

    expect((await prisma.loan.findUniqueOrThrow({ where: { id } })).lastDueHandled).toBeNull();
    expect(await prisma.expense.count()).toBe(0);
    expect(await prisma.cashMovement.count({ where: { kind: "LOAN_REPAY" } })).toBe(0);
  });

  it("bỏ qua kỳ nối vết vào ghi chú ĐỌC TRONG transaction — vết cũ không bị đè", async () => {
    vi.setSystemTime(new Date(2026, 11, 1, 9, 0, 0));
    const id = await taoKhoan({ note: "Ghi chú gốc" });

    expect((await ghiKyTraNo({ loanId: id, ...KY1, boQua: true })).ok).toBe(true);
    const ky2 = (await listKhoanVay())[0].kyCho;
    expect(ky2?.denNgay).toEqual(ngayVn("2026-11-10"));
    expect((await ghiKyTraNo({ loanId: id, dueDate: "2026-11-10", lai: 0, goc: 0, boQua: true })).ok).toBe(
      true
    );

    expect((await prisma.loan.findUniqueOrThrow({ where: { id } })).note).toBe(
      "Ghi chú gốc\nBỏ qua kỳ 10/10/2026\nBỏ qua kỳ 10/11/2026"
    );
  });

  /**
   * Sửa `firstDueDate` SAU khi đã duyệt kỳ 1. Hai điều phải cùng đúng:
   *  1. con dấu "<" đơn điệu ⇒ kỳ 1 MỚI (15/10 > 10/10) lại chờ duyệt, không kẹt;
   *  2. đề xuất của kỳ đó KẸP theo con dấu — dư nợ ĐẦU KỲ là 183.333.333 (đã trừ gốc kỳ 1 vừa trả)
   *     chứ KHÔNG phải 200tr, và kỳ dài 5 ngày (10/10 → 15/10) chứ không phải 40 ngày kể từ 05/09.
   *     Thiếu phép kẹp là app đòi trả lại nguyên gốc + lãi cả kỳ của một kỳ đã trả xong.
   */
  it("sửa ngày trả kỳ đầu SAU khi duyệt kỳ 1 → con dấu KHÔNG kẹt, đề xuất kẹp theo con dấu", async () => {
    // Ngày 01/12 để cả 15/10 lẫn 15/11 đều đã tới hạn.
    vi.setSystemTime(new Date(2026, 11, 1, 9, 0, 0));
    const id = await taoKhoan();
    expect((await ghiKyTraNo({ loanId: id, ...KY1 })).ok).toBe(true);

    const sua = await suaKhoanVay(id, { ...KHOAN_MOI, firstDueDate: "2026-10-15" });
    expect(sua.ok).toBe(true);

    const sauSua = (await listKhoanVay())[0];
    expect(sauSua.kyCho).toMatchObject({
      ky: 1,
      soNgay: 5, // 10/10 (con dấu) → 15/10, KHÔNG phải 40 ngày từ 05/09
      duNoDauKy: DU_NO_SAU_KY1, // 183.333.333 — đã trừ gốc kỳ 1, KHÔNG phải 200tr
      lai: 263_699, // round(183.333.333 × 1050/10000 × 5/365)
      goc: 16_666_667,
    });
    expect(sauSua.kyCho?.tuNgay).toEqual(ngayVn("2026-10-10"));
    expect(sauSua.kyCho?.denNgay).toEqual(ngayVn("2026-10-15"));

    const ky15Thang10 = await ghiKyTraNo({
      loanId: id,
      dueDate: "2026-10-15",
      lai: 263_699,
      goc: 16_666_667,
    });
    expect(ky15Thang10.ok).toBe(true);
    if (ky15Thang10.ok) expect(ky15Thang10.data.duNoConLai).toBe(166_666_666);

    // Và kỳ kế (15/11) — mốc mà spec §6 đòi — vẫn ghi được, mốc đầu kỳ = 15/10.
    const ky2 = (await listKhoanVay())[0].kyCho;
    expect(ky2).toMatchObject({
      ky: 2,
      soNgay: 31, // 15/10 → 15/11
      duNoDauKy: 166_666_666,
      lai: 1_486_301, // round(166.666.666 × 1050/10000 × 31/365)
    });
    expect(ky2?.denNgay).toEqual(ngayVn("2026-11-15"));
    const ky15Thang11 = await ghiKyTraNo({
      loanId: id,
      dueDate: "2026-11-15",
      lai: 1_486_301,
      goc: 16_666_667,
    });
    expect(ky15Thang11.ok).toBe(true);
    if (ky15Thang11.ok) expect(ky15Thang11.data.duNoConLai).toBe(149_999_999);

    expect(await prisma.expense.count()).toBe(3);
    expect(await prisma.cashMovement.count({ where: { kind: "LOAN_REPAY" } })).toBe(3);
  });

  it("lãi vượt trần 2 tỷ → lỗi tiếng Việt, KHÔNG ghi gì, con dấu KHÔNG đổi", async () => {
    const id = await taoKhoan();

    const res = await ghiKyTraNo({ loanId: id, ...KY1, lai: 3_000_000_000 });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.field).toBe("lai");
      expect(res.error).toBe("Số tiền quá lớn (tối đa 2 tỷ)");
    }

    expect(await prisma.expense.count()).toBe(0);
    expect(await prisma.cashMovement.count({ where: { kind: "LOAN_REPAY" } })).toBe(0);
    expect((await prisma.loan.findUniqueOrThrow({ where: { id } })).lastDueHandled).toBeNull();
  });

  it("dueDate không phải kỳ đang chờ → 'Kỳ không hợp lệ — tải lại trang'", async () => {
    const id = await taoKhoan();

    const res = await ghiKyTraNo({ loanId: id, ...KY1, dueDate: "2026-11-10" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe("Kỳ không hợp lệ — tải lại trang");
    expect(await prisma.expense.count()).toBe(0);
  });

  it("gốc lớn hơn dư nợ → 'Vượt dư nợ', rollback TRỌN (lãi cũng không ghi)", async () => {
    const id = await taoKhoan();

    const res = await ghiKyTraNo({ loanId: id, ...KY1, goc: 250_000_000 });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("Vượt dư nợ");

    expect(await prisma.expense.count()).toBe(0);
    expect(await prisma.cashMovement.count({ where: { kind: "LOAN_REPAY" } })).toBe(0);
    expect((await prisma.loan.findUniqueOrThrow({ where: { id } })).lastDueHandled).toBeNull();
  });

  it("bỏ qua kỳ → chỉ đóng dấu + để vết ở ghi chú, KHÔNG sinh lãi/gốc", async () => {
    const id = await taoKhoan();

    const res = await ghiKyTraNo({ loanId: id, ...KY1, boQua: true });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.data.duNoConLai).toBe(200_000_000);

    const loan = await prisma.loan.findUniqueOrThrow({ where: { id } });
    expect(loan.lastDueHandled).toEqual(ngayVn("2026-10-10"));
    expect(loan.note).toBe("Bỏ qua kỳ 10/10/2026");
    expect(await prisma.expense.count()).toBe(0);
    expect(await prisma.cashMovement.count({ where: { kind: "LOAN_REPAY" } })).toBe(0);
  });

  it("khoản vay không tồn tại → lỗi tiếng Việt, không 500", async () => {
    const res = await ghiKyTraNo({ loanId: "clzzzzzzzzzzzzzzzzzzzzzzz", ...KY1 });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe("Không tìm thấy khoản vay");
  });
});

describe("tatToanKhoanVay", () => {
  it("còn dư nợ → từ chối kèm số; trả hết gốc → ok và đóng dấu closedAt", async () => {
    const id = await taoKhoan();
    expect((await ghiKyTraNo({ loanId: id, ...KY1 })).ok).toBe(true);

    const som = await tatToanKhoanVay(id);
    expect(som.ok).toBe(false);
    if (!som.ok) expect(som.error).toContain("Còn dư nợ");
    expect((await prisma.loan.findUniqueOrThrow({ where: { id } })).closedAt).toBeNull();

    // Trả nốt phần gốc còn lại (ghi thẳng như chủ shop nhập tay ở bảng Dòng tiền).
    await prisma.cashMovement.create({
      data: {
        date: ngayVn("2026-10-20"),
        kind: "LOAN_REPAY",
        amount: DU_NO_SAU_KY1,
        loanId: id,
        description: "Trả nốt",
      },
    });

    const res = await tatToanKhoanVay(id);
    expect(res.ok).toBe(true);
    expect((await prisma.loan.findUniqueOrThrow({ where: { id } })).closedAt).not.toBeNull();
    // Khoản TERM không có tiền gửi (Σ DEPOSIT = 0) ⇒ tất toán KHÔNG sinh dòng DEPOSIT_IN nào — hợp
    // đồng action CŨ không đổi một chữ khi mở rộng cho BULLET (xem describe "BULLET" bên dưới).
    expect(await prisma.cashMovement.count({ where: { kind: "DEPOSIT_IN" } })).toBe(0);
  });
});

/**
 * BULLET (trả gốc cuối kỳ) + tiền gửi tiết kiệm bắt buộc — ca THẬT chủ shop: 200tr giải ngân
 * 12/05/2026, 36 kỳ, kỳ đầu 10/06/2026, lãi CỐ ĐỊNH 1.121.096đ/kỳ, tiền gửi 300.000đ/kỳ, tất toán
 * cấn trừ 36×300.000 = 10.800.000đ. Số LITERAL tính tay — KHÔNG suy lại bằng chính action đang kiểm.
 *
 * `annualRateBp` CỐ Ý giữ 1050 (≠ 0): chứng minh action ghi đúng `laiCoDinhMoiKy` chứ không tính lại
 * theo %/năm.
 */
describe("BULLET — trả gốc cuối kỳ + tiền gửi tiết kiệm bắt buộc", () => {
  const KHOAN_BULLET = {
    name: "E2E NH Chính sách",
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
  const LAI = 1_121_096;
  const GUI = 300_000;
  const GOC_CUOI = 200_000_000;
  const SO_KY = 36;

  /** Ngày đến hạn kỳ k = firstDueDate + (k−1) tháng — CÙNG công thức `ngayTraKy`, chép TAY ở test. */
  function dueDateCuaKy(k: number): string {
    return format(addMonths(new Date(2026, 5, 10), k - 1), "yyyy-MM-dd");
  }

  it(
    "đi trọn 36 kỳ: kỳ giữa 2 dòng (lãi + tiền gửi), kỳ CUỐI 3 dòng CÙNG 1 transaction; " +
      "ghi lại lần hai KHÔNG nhân đôi; tất toán hoàn đúng Σ 10.800.000, dư nợ về 0",
    async () => {
      // Đủ xa mọi kỳ (kỳ 36 = 10/06/2029) để `kyChoDuyet` luôn trả về đúng kỳ SỚM NHẤT chưa xử lý —
      // duyệt tuần tự 36 lần mô phỏng đúng 3 năm chủ shop bấm mỗi tháng.
      vi.setSystemTime(new Date(2029, 6, 1, 9, 0, 0));
      const id = await taoKhoan(KHOAN_BULLET);

      // Kỳ 1: chỉ lãi + tiền gửi — gốc = 0 nên KHÔNG sinh dòng LOAN_REPAY.
      const k1 = await ghiKyTraNo({
        loanId: id,
        dueDate: dueDateCuaKy(1),
        lai: LAI,
        goc: 0,
        tienGui: GUI,
      });
      expect(k1.ok).toBe(true);
      expect(await prisma.expense.count()).toBe(1);
      expect(await prisma.cashMovement.count({ where: { kind: "LOAN_REPAY" } })).toBe(0);
      expect(await prisma.cashMovement.count({ where: { kind: "DEPOSIT_OUT" } })).toBe(1);

      // Kỳ 2 → 35: giữ nguyên số, gốc vẫn 0.
      for (let k = 2; k < SO_KY; k++) {
        const r = await ghiKyTraNo({
          loanId: id,
          dueDate: dueDateCuaKy(k),
          lai: LAI,
          goc: 0,
          tienGui: GUI,
        });
        expect(r.ok).toBe(true);
      }
      expect(await prisma.expense.count()).toBe(SO_KY - 1);
      expect(await prisma.cashMovement.count({ where: { kind: "DEPOSIT_OUT" } })).toBe(SO_KY - 1);
      expect(await prisma.cashMovement.count({ where: { kind: "LOAN_REPAY" } })).toBe(0);
      // Chưa trả gốc kỳ nào ⇒ dư nợ vẫn nguyên 200tr tới sát kỳ cuối.
      expect((await listKhoanVay()).find((r) => r.id === id)?.duNo).toBe(GOC_CUOI);

      // Kỳ CUỐI (36) — 3 dòng CÙNG một transaction: Expense lãi + LOAN_REPAY gốc trọn + DEPOSIT_OUT.
      const kCuoi = await ghiKyTraNo({
        loanId: id,
        dueDate: dueDateCuaKy(SO_KY),
        lai: LAI,
        goc: GOC_CUOI,
        tienGui: GUI,
      });
      expect(kCuoi.ok).toBe(true);
      if (kCuoi.ok) expect(kCuoi.data.duNoConLai).toBe(0);
      expect(await prisma.expense.count()).toBe(SO_KY);
      expect(await prisma.cashMovement.count({ where: { kind: "LOAN_REPAY" } })).toBe(1);
      expect(await prisma.cashMovement.count({ where: { kind: "DEPOSIT_OUT" } })).toBe(SO_KY);
      const gocCuoi = await prisma.cashMovement.findFirstOrThrow({ where: { kind: "LOAN_REPAY" } });
      expect(gocCuoi.amount).toBe(GOC_CUOI);

      // Ghi lại CÙNG kỳ cuối lần hai → từ chối, KHÔNG nhân đôi bất kỳ dòng nào (con dấu lastDueHandled).
      const lanHai = await ghiKyTraNo({
        loanId: id,
        dueDate: dueDateCuaKy(SO_KY),
        lai: LAI,
        goc: GOC_CUOI,
        tienGui: GUI,
      });
      expect(lanHai.ok).toBe(false);
      if (!lanHai.ok) expect(lanHai.error).toBe("Kỳ này đã được ghi");
      expect(await prisma.expense.count()).toBe(SO_KY);
      expect(await prisma.cashMovement.count({ where: { kind: "LOAN_REPAY" } })).toBe(1);
      expect(await prisma.cashMovement.count({ where: { kind: "DEPOSIT_OUT" } })).toBe(SO_KY);

      // Tất toán: hoàn ĐÚNG MỘT dòng DEPOSIT_IN = Σ 36 kỳ tiền gửi = 10.800.000 (literal, không phải
      // 36 × GUI tính lại trong test — số ngân hàng THẬT trả về theo giấy tất toán của chủ shop).
      const tt = await tatToanKhoanVay(id);
      expect(tt.ok).toBe(true);
      const hoanGui = await prisma.cashMovement.findFirstOrThrow({
        where: { loanId: id, kind: "DEPOSIT_IN" },
      });
      expect(hoanGui.amount).toBe(10_800_000);
      expect(await prisma.cashMovement.count({ where: { loanId: id, kind: "DEPOSIT_IN" } })).toBe(1);
      expect((await listKhoanVay()).find((r) => r.id === id)?.duNo).toBe(0);
      expect((await prisma.loan.findUniqueOrThrow({ where: { id } })).closedAt).not.toBeNull();
    },
    90_000 // 36 lượt ghi qua Tailscale, mỗi lượt vài round-trip — vượt xa testTimeout mặc định 15s.
  );

  it("gốc vượt dư nợ ở kỳ GIỮA (chưa tới kỳ cuối) → 'Vượt dư nợ', rollback TRỌN kể cả tiền gửi", async () => {
    vi.setSystemTime(new Date(2029, 6, 1, 9, 0, 0));
    const id = await taoKhoan(KHOAN_BULLET);

    const res = await ghiKyTraNo({
      loanId: id,
      dueDate: dueDateCuaKy(1),
      lai: LAI,
      goc: 900_000_000, // vượt xa dư nợ 200tr — chủ shop gõ nhầm số 0
      tienGui: GUI,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("Vượt dư nợ");

    expect(await prisma.expense.count()).toBe(0);
    expect(await prisma.cashMovement.count({ where: { kind: "LOAN_REPAY" } })).toBe(0);
    // Rollback TRỌN: kể cả dòng tiền gửi (ghi SAU gốc trong cùng transaction) cũng không sót lại.
    expect(await prisma.cashMovement.count({ where: { kind: "DEPOSIT_OUT" } })).toBe(0);
    expect((await prisma.loan.findUniqueOrThrow({ where: { id } })).lastDueHandled).toBeNull();
  });

  /**
   * NGÕ CỤT "khai nhầm rồi đã duyệt 1 kỳ" — ca riêng của BULLET, không có ở vay kỳ hạn: kỳ 1 có
   * `goc = 0` nên KHÔNG sinh dòng trả gốc nào, chỉ `Expense` lãi + `DEPOSIT_OUT` + con dấu
   * `lastDueHandled`. Con dấu đó không có đường lùi ở bất kỳ đâu trong app ⇒ hồ sơ khoản vay KHÔNG
   * xoá được nữa, kể cả sau khi đã dọn sạch mọi dòng tiền. Test này chốt CẢ HAI nửa của sự thật đó:
   * luật chặn không nới một chữ, và đường vòng mà câu lỗi hứa (dọn dòng tiền → dư nợ về 0 → Tất
   * toán) CHẠY ĐƯỢC THẬT.
   */
  it("khai nhầm rồi đã duyệt kỳ lãi: hồ sơ KHÔNG xoá được vĩnh viễn, nhưng đường Tất toán mà câu lỗi chỉ thì chạy được", async () => {
    vi.setSystemTime(new Date(2026, 6, 1, 9, 0, 0));
    const id = await taoKhoan(KHOAN_BULLET);
    expect(
      (await ghiKyTraNo({ loanId: id, dueDate: dueDateCuaKy(1), lai: LAI, goc: 0, tienGui: GUI })).ok
    ).toBe(true);
    expect(await prisma.cashMovement.count({ where: { loanId: id, kind: "LOAN_REPAY" } })).toBe(0);

    // Câu lỗi phải nói ĐÚNG trạng thái: chưa trả đồng gốc nào, nên KHÔNG được mượn câu của khoản đã
    // trả gốc; và phải chỉ ra đường gỡ thay vì vòng lại "chỉ tất toán".
    const chan = await xoaKhoanVay(id);
    expect(chan.ok).toBe(false);
    if (!chan.ok) {
      expect(chan.error).not.toContain("đã có dòng trả gốc");
      expect(chan.error).toContain("con dấu kỳ KHÔNG lùi được");
      expect(chan.error).toContain("Sổ chi phí");
      expect(chan.error).toContain("Tất toán");
    }

    // Đi đúng ba bước câu lỗi chỉ.
    const lai = await prisma.expense.findFirstOrThrow({ where: { categoryId: "interest" } });
    expect((await deleteExpense(lai.id, "only")).ok).toBe(true);
    const gui = await prisma.cashMovement.findFirstOrThrow({
      where: { loanId: id, kind: "DEPOSIT_OUT" },
    });
    expect((await deleteCashMovement(gui.id)).ok).toBe(true);
    const giaiNgan = await prisma.cashMovement.findFirstOrThrow({
      where: { loanId: id, kind: "LOAN_IN" },
    });
    expect((await deleteCashMovement(giaiNgan.id)).ok).toBe(true);

    // Dọn sạch dòng tiền KHÔNG mở lại đường xoá — con dấu vẫn đứng đó, luật chặn giữ nguyên.
    const vanChan = await xoaKhoanVay(id);
    expect(vanChan.ok).toBe(false);
    expect(await prisma.loan.count({ where: { id } })).toBe(1);

    // Nhưng dư nợ đã về 0 nên Tất toán đi được — đúng lối thoát câu lỗi hứa.
    expect((await listKhoanVay()).find((r) => r.id === id)?.duNo).toBe(0);
    expect((await tatToanKhoanVay(id)).ok).toBe(true);
    expect((await prisma.loan.findUniqueOrThrow({ where: { id } })).closedAt).not.toBeNull();
    // Không đẻ dòng hoàn tiền gửi oan: sổ tiết kiệm đã xoá nên Σ đang giữ = 0.
    expect(await prisma.cashMovement.count({ where: { loanId: id, kind: "DEPOSIT_IN" } })).toBe(0);
  });
});

describe("suaKhoanVay / xoaKhoanVay", () => {
  it("đổi ngày giải ngân khi CHƯA ghi kỳ → dời luôn ngày dòng LOAN_IN (bất biến ngày)", async () => {
    const id = await taoKhoan();

    const res = await suaKhoanVay(id, {
      ...KHOAN_MOI,
      name: "VPBank đổi tên",
      ngayGiaiNgan: "2026-09-08",
      soTienGiaiNgan: 150_000_000,
    });
    expect(res.ok).toBe(true);

    const loan = await prisma.loan.findUniqueOrThrow({ where: { id } });
    expect(loan.name).toBe("VPBank đổi tên");
    expect(loan.startDate).toEqual(ngayVn("2026-09-08"));
    const dong = await prisma.cashMovement.findFirstOrThrow({ where: { kind: "LOAN_IN" } });
    expect(dong.amount).toBe(150_000_000);
    expect(dong.date).toEqual(startOfDay(loan.startDate));
  });

  it("ĐÃ ghi kỳ → khoá ngày/số tiền giải ngân, vẫn cho sửa tên và lãi suất", async () => {
    const id = await taoKhoan();
    expect((await ghiKyTraNo({ loanId: id, ...KY1 })).ok).toBe(true);

    const xau = await suaKhoanVay(id, { ...KHOAN_MOI, soTienGiaiNgan: 300_000_000 });
    expect(xau.ok).toBe(false);
    if (!xau.ok) expect(xau.error).toContain("Đã ghi kỳ trả");
    expect((await prisma.cashMovement.findFirstOrThrow({ where: { kind: "LOAN_IN" } })).amount).toBe(
      200_000_000
    );

    const tot = await suaKhoanVay(id, { ...KHOAN_MOI, name: "Tên mới", annualRateBp: 1200 });
    expect(tot.ok).toBe(true);
    expect(await prisma.loan.findUniqueOrThrow({ where: { id } })).toMatchObject({
      name: "Tên mới",
      annualRateBp: 1200,
    });
  });

  it("chưa ghi kỳ → xoá được cả hồ sơ lẫn dòng LOAN_IN; đã trả gốc → từ chối", async () => {
    const id = await taoKhoan();

    const daTra = await taoKhoan({ name: "Khoản đã trả" });
    expect((await ghiKyTraNo({ loanId: daTra, ...KY1 })).ok).toBe(true);
    const chan = await xoaKhoanVay(daTra);
    expect(chan.ok).toBe(false);
    // Kỳ 1 của khoản kỳ hạn CÓ trả gốc ⇒ câu lỗi phải nói đúng chuyện đó, không phải câu "đã ghi kỳ
    // trả" chung chung (câu chung mô tả SAI khoản trả gốc cuối kỳ — xem describe "khai nhầm" dưới).
    if (!chan.ok) expect(chan.error).toContain("đã có dòng trả gốc");
    expect(await prisma.loan.count({ where: { id: daTra } })).toBe(1);

    const res = await xoaKhoanVay(id);
    expect(res.ok).toBe(true);
    expect(await prisma.loan.count({ where: { id } })).toBe(0);
    expect(await prisma.cashMovement.count({ where: { loanId: id } })).toBe(0);
  });

  it("tất toán rồi MỞ LẠI → closedAt về null, khoản nhận lại được dòng gốc", async () => {
    const id = await taoKhoan();
    const traTron = await createCashMovement({
      date: ngayVn("2026-10-20"),
      kind: "LOAN_REPAY",
      amount: 200_000_000,
      loanId: id,
      description: "Trả trọn",
    });
    expect(traTron.ok).toBe(true);
    expect((await tatToanKhoanVay(id)).ok).toBe(true);

    // Khoản đã tất toán khoá cả đường xoá dòng cũ — đó chính là lý do phải có đường mở lại.
    const dong = await prisma.cashMovement.findFirstOrThrow({
      where: { loanId: id, kind: "LOAN_REPAY" },
    });
    const biChan = await deleteCashMovement(dong.id);
    expect(biChan.ok).toBe(false);

    const res = await suaKhoanVay(id, { ...KHOAN_MOI, moLai: true });
    expect(res.ok).toBe(true);
    expect((await prisma.loan.findUniqueOrThrow({ where: { id } })).closedAt).toBeNull();

    // Mở lại xong: xoá được dòng trả nhầm rồi ghi lại đúng số, dư nợ suy lại từ chính các dòng đó.
    expect((await deleteCashMovement(dong.id)).ok).toBe(true);
    const ghiLai = await createCashMovement({
      date: ngayVn("2026-10-21"),
      kind: "LOAN_REPAY",
      amount: 150_000_000,
      loanId: id,
      description: "Trả lại đúng số",
    });
    expect(ghiLai.ok).toBe(true);
    expect((await listKhoanVay()).find((r) => r.id === id)?.duNo).toBe(50_000_000);
  });

  /**
   * Đổi "moi" → "mang-sang" ở `suaKhoanVay` từng XOÁ hẳn dòng LOAN_IN — một dòng tiền THẬT đã vào
   * tài khoản — nên quỹ tụt đúng bằng số giải ngân mà không hỏi câu nào. Form đã khoá radio chế độ
   * khi sửa; action phải chặn độc lập.
   */
  it("đổi chế độ khoản vay khi sửa → từ chối, dòng LOAN_IN còn nguyên", async () => {
    const id = await taoKhoan();

    const res = await suaKhoanVay(id, {
      ...KHOAN_MOI,
      cheDo: "mang-sang",
      duNoMoSo: 200_000_000,
      startDate: "2026-09-05",
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe("Không đổi chế độ khoản vay sau khi tạo");

    expect(await prisma.cashMovement.count({ where: { loanId: id, kind: "LOAN_IN" } })).toBe(1);
    expect((await listKhoanVay())[0].duNo).toBe(200_000_000);
  });

  it("id lạ → lỗi tiếng Việt cho cả sửa, xoá, tất toán", async () => {
    const idLa = "clzzzzzzzzzzzzzzzzzzzzzzz";
    for (const res of [
      await suaKhoanVay(idLa, KHOAN_MOI),
      await xoaKhoanVay(idLa),
      await tatToanKhoanVay(idLa),
    ]) {
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error).toBe("Không tìm thấy khoản vay");
    }
  });
});

describe("hợp đồng ngày tháng", () => {
  it("mô tả dòng tiền và chi phí ghi đúng ngày kỳ theo giờ VN", async () => {
    const id = await taoKhoan();
    expect((await ghiKyTraNo({ loanId: id, ...KY1 })).ok).toBe(true);

    const chi = await prisma.expense.findFirstOrThrow();
    const traGoc = await prisma.cashMovement.findFirstOrThrow({ where: { kind: "LOAN_REPAY" } });
    expect(format(chi.date, "yyyy-MM-dd")).toBe("2026-10-10");
    expect(format(traGoc.date, "yyyy-MM-dd")).toBe("2026-10-10");
    expect(traGoc.description).toBe("Trả gốc E2E VPBank — kỳ 10/10/2026");
  });
});

/**
 * TIỀN GỬI TIẾT KIỆM BẮT BUỘC CHỈ THUỘC `BULLET` — khoá cả hai cổng SERVER (schema khai khoản vay +
 * lượt ghi kỳ), vì client không được tin.
 *
 * Vì sao chặn tận cửa vào thay vì dạy mọi đường tất toán biết hoàn: khoản THẤU CHI tất toán qua
 * action riêng `tat-toan-thau-chi.ts`, đường đó mù `DEPOSIT_*` — nó set `closedAt` mà không ghi dòng
 * hoàn, sau đó `kiemKhoanVay` chặn mọi lượt ghi vào khoản đã đóng ⇒ tiền của chủ shop mất dấu VĨNH
 * VIỄN khỏi quỹ.
 */
describe("tiền gửi tiết kiệm — chỉ khoản BULLET", () => {
  const LOI = "Chỉ khoản vay trả gốc cuối kỳ mới có tiền gửi tiết kiệm bắt buộc";

  it.each([["TERM"], ["OVERDRAFT"]])(
    "khai tiền gửi cho khoản %s → từ chối tại ô 'tienGuiBatBuocMoiKy', KHÔNG tạo khoản nào",
    async (kind) => {
      const res = await taoKhoanVay({
        ...KHOAN_MOI,
        kind,
        // Thấu chi không có kỳ hạn gốc — transform tự ép NULL, gửi kèm cũng không sao.
        tienGuiBatBuocMoiKy: 300_000,
      });
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.field).toBe("tienGuiBatBuocMoiKy");
        expect(res.error).toBe(LOI);
      }
      expect(await prisma.loan.count()).toBe(0);
    }
  );

  it("khoản TERM đã tạo, client vẫn gửi tienGui > 0 khi ghi kỳ → từ chối, ROLLBACK trọn", async () => {
    const id = await taoKhoan(); // TERM, tienGuiBatBuocMoiKy = 0

    const res = await ghiKyTraNo({ loanId: id, ...KY1, tienGui: 300_000 });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe(LOI);

    // Cổng nằm TRƯỚC mọi câu ghi trong transaction: không lãi, không gốc, không tiền gửi, con dấu
    // kỳ vẫn nguyên ⇒ chủ shop bấm lại được sau khi sửa số.
    expect(await prisma.expense.count()).toBe(0);
    expect(await prisma.cashMovement.count({ where: { kind: "DEPOSIT_OUT" } })).toBe(0);
    expect(await prisma.cashMovement.count({ where: { kind: "LOAN_REPAY" } })).toBe(0);
    expect((await prisma.loan.findUniqueOrThrow({ where: { id } })).lastDueHandled).toBeNull();
  });

  it("sửa khoản TERM thành có tiền gửi → từ chối, cột trong DB vẫn 0", async () => {
    const id = await taoKhoan();
    const res = await suaKhoanVay(id, { ...KHOAN_MOI, tienGuiBatBuocMoiKy: 300_000 });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.field).toBe("tienGuiBatBuocMoiKy");
    expect((await prisma.loan.findUniqueOrThrow({ where: { id } })).tienGuiBatBuocMoiKy).toBe(0);
  });
});

/**
 * NGÀY của dòng hoàn tiền gửi lúc tất toán. Trước đợt này `tatToanKhoanVay` không ghi đồng nào nên
 * ngày vô hại; NAY nó ghi tiền THẬT: kỳ cuối đến hạn tháng 5 mà bấm tháng 6 thì cả số tiền gửi rơi
 * sang tháng 6 và sổ quỹ tháng 5 hụt đúng số đó.
 */
describe("tatToanKhoanVay — ngày hoàn tiền gửi", () => {
  const KHOAN_BULLET = {
    name: "NH Chính sách",
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

  /** Ghi kỳ 1 (lãi + tiền gửi) rồi trả trọn gốc bằng tay ⇒ khoản sẵn sàng tất toán, đang giữ 300.000. */
  async function khoanSanSangTatToan(): Promise<string> {
    const id = await taoKhoan(KHOAN_BULLET);
    expect(
      (await ghiKyTraNo({ loanId: id, dueDate: "2026-06-10", lai: 1_121_096, goc: 0, tienGui: 300_000 }))
        .ok
    ).toBe(true);
    expect(
      (
        await createCashMovement({
          date: ngayVn("2026-10-20"),
          kind: "LOAN_REPAY",
          amount: 200_000_000,
          loanId: id,
          description: "Trả trọn gốc",
        })
      ).ok
    ).toBe(true);
    return id;
  }

  it("khai ngày tất toán → dòng DEPOSIT_IN ghi ĐÚNG ngày đó, không phải hôm nay", async () => {
    const id = await khoanSanSangTatToan();

    const res = await tatToanKhoanVay(id, { ngayTatToan: ngayVn("2026-10-20") });
    expect(res.ok).toBe(true);

    const hoan = await prisma.cashMovement.findFirstOrThrow({
      where: { loanId: id, kind: "DEPOSIT_IN" },
    });
    expect(hoan.amount).toBe(300_000);
    expect(format(hoan.date, "yyyy-MM-dd")).toBe("2026-10-20");
    // HOM_NAY của suite là 01/11/2026 — chứng minh ngày KHÔNG rơi về hôm nay.
    expect(format(hoan.date, "yyyy-MM-dd")).not.toBe("2026-11-01");
  });

  it("KHÔNG khai ngày (hợp đồng cũ, gọi một tham số) → hoàn theo hôm nay", async () => {
    const id = await khoanSanSangTatToan();

    const res = await tatToanKhoanVay(id);
    expect(res.ok).toBe(true);
    const hoan = await prisma.cashMovement.findFirstOrThrow({
      where: { loanId: id, kind: "DEPOSIT_IN" },
    });
    expect(format(hoan.date, "yyyy-MM-dd")).toBe("2026-11-01");
  });

  /**
   * CẬN DƯỚI của ngày tất toán. Chặn ngày tương lai thôi là chưa đủ: kỳ 36 đến hạn 10/05 mà gõ nhầm
   * 30/04 thì cả Σ tiền gửi — phần lớn chưa hề rời tài khoản trước tháng 5 — đề ngày 30/04, Sổ quỹ
   * tháng 4 phồng đúng số đó và tháng 5 hụt đúng số đó.
   */
  it("ngày SỚM HƠN dòng tiền gần nhất → từ chối kèm mốc hợp lệ; đúng mốc đó thì chạy", async () => {
    const id = await khoanSanSangTatToan();

    // Dòng gốc gần nhất của khoản là lần trả trọn 20/10 ⇒ 19/10 phải bị chặn.
    const som = await tatToanKhoanVay(id, { ngayTatToan: ngayVn("2026-10-19") });
    expect(som.ok).toBe(false);
    if (!som.ok) {
      expect(som.field).toBe("ngayTatToan");
      expect(som.error).toContain("20/10/2026");
    }
    expect(await prisma.cashMovement.count({ where: { loanId: id, kind: "DEPOSIT_IN" } })).toBe(0);
    expect((await prisma.loan.findUniqueOrThrow({ where: { id } })).closedAt).toBeNull();

    // Ngày hợp lệ (đúng mốc, không phải sau nó) vẫn chạy trọn — cận dưới không được lấn thêm 1 ngày.
    const dung = await tatToanKhoanVay(id, { ngayTatToan: ngayVn("2026-10-20") });
    expect(dung.ok).toBe(true);
    const hoan = await prisma.cashMovement.findFirstOrThrow({
      where: { loanId: id, kind: "DEPOSIT_IN" },
    });
    expect(hoan.amount).toBe(300_000);
    expect(format(hoan.date, "yyyy-MM-dd")).toBe("2026-10-20");
  });

  it("ngày trước ngày bắt đầu khoản vay → từ chối kèm chính ngày đó, không ghi dòng nào", async () => {
    // Khoản TERM giải ngân 05/09/2026, chưa có dòng trả gốc/tiền gửi nào ⇒ cận dưới chính là 05/09.
    const id = await taoKhoan();

    const res = await tatToanKhoanVay(id, { ngayTatToan: ngayVn("2026-08-01") });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.field).toBe("ngayTatToan");
      expect(res.error).toContain("05/09/2026");
    }
    expect((await prisma.loan.findUniqueOrThrow({ where: { id } })).closedAt).toBeNull();
  });

  it("ngày tương lai → từ chối ở ô 'ngayTatToan', khoản KHÔNG bị đóng và không ghi dòng nào", async () => {
    const id = await khoanSanSangTatToan();

    const res = await tatToanKhoanVay(id, { ngayTatToan: ngayVn("2026-12-01") });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.field).toBe("ngayTatToan");
      expect(res.error).toBe("Không cho ngày tương lai");
    }
    expect(await prisma.cashMovement.count({ where: { loanId: id, kind: "DEPOSIT_IN" } })).toBe(0);
    expect((await prisma.loan.findUniqueOrThrow({ where: { id } })).closedAt).toBeNull();
  });
});
