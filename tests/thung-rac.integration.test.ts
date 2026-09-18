import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { deleteCashMovement } from "@/lib/actions/cash-movements";
import { deleteExpense } from "@/lib/actions/expenses";
import { xoaKhoanVay } from "@/lib/actions/khoan-vay";
import { xoaSoTietKiem } from "@/lib/actions/so-tiet-kiem";
import { khoiPhucBanGhi, xoaVinhVienBanGhi } from "@/lib/actions/thung-rac";
import { ensureRecurringExpenses } from "@/lib/expenses/ensure-recurring-expenses";
import { getExpenseSummary } from "@/lib/expenses/expense-queries";
import { prisma } from "@/lib/prisma";
import { calcPnl } from "@/lib/reports/pnl";
import { listKhoanVay } from "@/lib/so-quy/khoan-vay-queries";
import { tinhSoQuyThang } from "@/lib/so-quy/so-quy-queries";
import type { AnhBanGhi } from "@/lib/thung-rac/chup-anh-ban-ghi";
import { CAU_SO_DU_AM } from "@/lib/thung-rac/ly-do-khong-khoi-phuc";
import { listThungRac } from "@/lib/thung-rac/thung-rac-queries";
import { seedReference, truncateBusinessTables } from "./helpers/test-db";

/**
 * Integration THÙNG RÁC trên `hogikids_test`.
 *
 * Hai lời khai phải chốt bằng SỐ THẬT trong DB, không phải bằng đọc mã:
 *  1. Xoá → khôi phục đưa tiền về ĐÚNG TỪNG ĐỒNG: P&L, Sổ quỹ và Sổ chi phí của kỳ phải bằng y hệt
 *     lúc trước khi xoá (đo trước/sau, so cả object).
 *  2. Dòng NẰM TRONG thùng rác KHÔNG lọt vào bất kỳ phép tính tiền nào — đây là điểm mạnh của kiến
 *     trúc bảng snapshot riêng (xoá vẫn là xoá CỨNG), nên phải có lưới đóng đinh nó: ai đổi sang
 *     soft-delete bằng cột `deletedAt` mà quên sửa một trong hơn 20 query đọc tiền sẽ thấy đỏ ở đây.
 */
vi.mock("@/lib/session", () => ({
  requireUser: vi.fn(async () => "test-user-id"),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

/** Kỳ đo: tháng 7/2026 — đã qua, nên mọi mốc ngày đều là quá khứ với đồng hồ thật. */
const KY = { from: new Date(2026, 6, 1), to: new Date(2026, 6, 31) };

const TIEN_CHI = 28_999_920;

beforeAll(async () => {
  await seedReference();
}, 60_000);

beforeEach(async () => {
  await truncateBusinessTables();
});

afterAll(async () => {
  await truncateBusinessTables();
  await prisma.$disconnect();
});

/** Ba con số tiền của kỳ, đo cùng lúc — so nguyên cụm thì không ai "quên" so một cái. */
async function doTien() {
  const [pnl, quy, chiPhi] = await Promise.all([
    calcPnl(KY),
    tinhSoQuyThang(KY),
    getExpenseSummary(KY),
  ]);
  return { pnl, quy, chiPhi };
}

async function taoChiPhi(ghiDe: Record<string, unknown> = {}) {
  return prisma.expense.create({
    data: {
      date: new Date(2026, 6, 10),
      // Danh mục "Vận chuyển" chứ không "Nhập hàng": Nhập hàng CỐ Ý không bao giờ trừ vào P&L (bất
      // biến #1, nó là dòng tiền) nên fixture đó sẽ làm phép so P&L trước/sau thành so hai số 0.
      categoryId: "shipping",
      description: "Cước vận chuyển tháng 7",
      amount: TIEN_CHI,
      source: "MANUAL",
      ...ghiDe,
    },
  });
}

describe("xoá rồi khôi phục một khoản chi", () => {
  it("tiền của kỳ trở lại Y HỆT, bản ghi về đúng id cũ", async () => {
    const chiPhi = await taoChiPhi();
    const truoc = await doTien();

    const xoa = await deleteExpense(chiPhi.id, "only");
    expect(xoa.ok).toBe(true);
    expect(await prisma.expense.count()).toBe(0);

    // Phép đo không rỗng: xoá PHẢI làm số đổi, nếu không so "trước = sau" ở dưới là so hai số 0.
    const giua = await doTien();
    expect(giua.chiPhi.total).toBe(truoc.chiPhi.total - TIEN_CHI);
    expect(giua.pnl.netProfit).not.toBe(truoc.pnl.netProfit);

    const dong = await prisma.banGhiDaXoa.findFirstOrThrow();
    expect(dong).toMatchObject({ bang: "Expense", banGhiId: chiPhi.id, soTien: TIEN_CHI });
    expect(dong.nhan).toBe("Vận chuyển — 28.999.920 ₫ — 10/07/2026 · Cước vận chuyển tháng 7");

    const phuc = await khoiPhucBanGhi(dong.id);
    expect(phuc.ok).toBe(true);

    const veLai = await prisma.expense.findUniqueOrThrow({ where: { id: chiPhi.id } });
    expect(veLai).toEqual(chiPhi);

    const sau = await doTien();
    expect(sau).toEqual(truoc);
    expect((await prisma.banGhiDaXoa.findUniqueOrThrow({ where: { id: dong.id } })).khoiPhucLuc)
      .not.toBeNull();
  });

  it("nhánh 'dừng lặp hàng tháng': mẫu định kỳ tắt, khôi phục KHÔNG tự bật lại", async () => {
    const mau = await prisma.recurringExpense.create({
      data: { categoryId: "fixed", amount: 5_000_000, dayOfMonth: 10, description: "Mặt bằng" },
    });
    const chiPhi = await taoChiPhi({
      categoryId: "fixed",
      amount: 5_000_000,
      description: "Mặt bằng",
      source: "RECURRING",
      recurringId: mau.id,
    });

    const xoa = await deleteExpense(chiPhi.id, "stop_recurring");
    expect(xoa.ok).toBe(true);
    expect((await prisma.recurringExpense.findUniqueOrThrow({ where: { id: mau.id } })).active).toBe(
      false
    );

    const dong = await prisma.banGhiDaXoa.findFirstOrThrow();
    expect((dong.anh as { ghiChu: { recurringDaTat?: string } }).ghiChu.recurringDaTat).toBe(mau.id);

    expect((await khoiPhucBanGhi(dong.id)).ok).toBe(true);
    expect(await prisma.expense.count()).toBe(1);
    // Chủ shop đã cố ý dừng khoản lặp — bật lại là tháng sau tự sinh thêm một khoản chi họ không muốn.
    expect((await prisma.recurringExpense.findUniqueOrThrow({ where: { id: mau.id } })).active).toBe(
      false
    );
  });
});

describe("xoá rồi khôi phục CỤM khoản vay", () => {
  /**
   * 3 dòng `LOAN_IN` được seed THẲNG bằng Prisma: cổng ở `createCashMovement` chỉ cho 1 lần giải
   * ngân mỗi khoản, còn `LOAN_REPAY`/`DEPOSIT_*` thì chính cổng xoá từ chối. Đây là fixture để đo
   * cụm nhiều con, không phải trạng thái app tự sinh ra được.
   */
  async function taoCumKhoanVay() {
    const loan = await prisma.loan.create({
      data: {
        name: "Vietcombank",
        startDate: new Date(2026, 6, 2),
        annualRateBp: 1050,
        termMonths: 12,
        firstDueDate: new Date(2026, 7, 2),
      },
    });
    for (const [i, tien] of [100_000_000, 50_000_000, 30_000_000].entries()) {
      await prisma.cashMovement.create({
        data: {
          date: new Date(2026, 6, 2 + i),
          kind: "LOAN_IN",
          amount: tien,
          description: `Giải ngân đợt ${i + 1}`,
          loanId: loan.id,
        },
      });
    }
    return loan;
  }

  it("dư nợ + mọi dòng tiền con trở lại đúng, kể cả liên kết sổ tiết kiệm (FK SetNull)", async () => {
    const loan = await taoCumKhoanVay();
    const so = await prisma.soTietKiem.create({
      data: {
        name: "ACB 6 tháng",
        principal: 20_000_000,
        startDate: new Date(2026, 6, 5),
        termMonths: 6,
        maturityDate: new Date(2027, 0, 5),
        annualRateBp: 520,
        loanId: loan.id,
      },
    });
    const conTruoc = await prisma.cashMovement.findMany({ orderBy: { date: "asc" } });
    const duNoTruoc = (await listKhoanVay()).find((l) => l.id === loan.id)?.duNo;
    expect(duNoTruoc).toBe(180_000_000);
    const truoc = await doTien();

    const xoa = await xoaKhoanVay(loan.id);
    expect(xoa.ok).toBe(true);
    expect(await prisma.loan.count()).toBe(0);
    expect(await prisma.cashMovement.count()).toBe(0);
    // FK `SetNull`: liên kết sổ ↔ vay biến mất, không bảng nào giữ lại — đúng thứ ảnh chụp phải cứu.
    expect((await prisma.soTietKiem.findUniqueOrThrow({ where: { id: so.id } })).loanId).toBeNull();

    const dong = await prisma.banGhiDaXoa.findFirstOrThrow();
    expect(dong).toMatchObject({ bang: "Loan", banGhiId: loan.id, soTien: 180_000_000 });

    const phuc = await khoiPhucBanGhi(dong.id);
    expect(phuc.ok).toBe(true);

    expect(await prisma.loan.findUniqueOrThrow({ where: { id: loan.id } })).toEqual(loan);
    expect(await prisma.cashMovement.findMany({ orderBy: { date: "asc" } })).toEqual(conTruoc);
    expect((await listKhoanVay()).find((l) => l.id === loan.id)?.duNo).toBe(180_000_000);
    expect((await prisma.soTietKiem.findUniqueOrThrow({ where: { id: so.id } })).loanId).toBe(
      loan.id
    );
    expect(await doTien()).toEqual(truoc);
  });
});

/**
 * LƯỚI CHỐNG HỒI QUY — lý do tồn tại của bảng snapshot riêng. Đo bằng cách so với NỀN (kỳ hoàn toàn
 * trống): sau khi xoá, mọi phép tính tiền phải quay về đúng nền, dù thùng rác đang giữ ảnh chụp.
 */
describe("dòng trong thùng rác KHÔNG lọt vào P&L / Sổ quỹ / Sổ chi phí", () => {
  it("khoản chi đã xoá: ba phép tính tiền đều bằng nền", async () => {
    const nen = await doTien();

    const chiPhi = await taoChiPhi();
    expect((await deleteExpense(chiPhi.id, "only")).ok).toBe(true);

    // Không rỗng: ảnh chụp PHẢI đang nằm đó thì phép so dưới mới có nghĩa.
    expect(await prisma.banGhiDaXoa.count()).toBe(1);
    expect((await prisma.banGhiDaXoa.findFirstOrThrow()).soTien).toBe(TIEN_CHI);

    const sau = await doTien();
    expect(sau.chiPhi).toEqual(nen.chiPhi);
    expect(sau.pnl).toEqual(nen.pnl);
    expect(sau.quy).toEqual(nen.quy);
  });

  it("khoản tiền khác đã xoá: Sổ quỹ bằng nền (thùng rác không phải một nguồn dòng tiền)", async () => {
    const nen = await tinhSoQuyThang(KY);

    const dong = await prisma.cashMovement.create({
      data: {
        date: new Date(2026, 6, 4),
        kind: "CAPITAL_IN",
        amount: 300_000_000,
        description: "Góp vốn",
      },
    });
    expect((await deleteCashMovement(dong.id)).ok).toBe(true);

    expect(await prisma.banGhiDaXoa.count()).toBe(1);
    expect(await tinhSoQuyThang(KY)).toEqual(nen);
  });

  it("sổ chi phí (bảng ở /tai-chinh) không liệt kê dòng đã xoá", async () => {
    const chiPhi = await taoChiPhi();
    expect((await deleteExpense(chiPhi.id, "only")).ok).toBe(true);

    const sau = await getExpenseSummary(KY);
    expect(sau.total).toBe(0);
    expect(sau.breakdown.find((c) => c.categoryId === "shipping")).toBeUndefined();
    expect(sau.topCategory).toBeNull();
  });
});

describe("lý do từ chối khôi phục — đo trên DB thật", () => {
  it("đã khôi phục rồi → lượt thứ hai bị từ chối, không đẻ bản ghi trùng", async () => {
    const chiPhi = await taoChiPhi();
    await deleteExpense(chiPhi.id, "only");
    const dong = await prisma.banGhiDaXoa.findFirstOrThrow();

    expect((await khoiPhucBanGhi(dong.id)).ok).toBe(true);
    const lan2 = await khoiPhucBanGhi(dong.id);

    expect(lan2.ok).toBe(false);
    if (!lan2.ok) expect(lan2.error).toBe("Mục này đã được khôi phục");
    expect(await prisma.expense.count()).toBe(1);
  });

  it("id cũ đã có chủ mới → từ chối thay vì ghi đè", async () => {
    const chiPhi = await taoChiPhi();
    await deleteExpense(chiPhi.id, "only");
    const dong = await prisma.banGhiDaXoa.findFirstOrThrow();
    // Ai đó tạo lại một dòng mang đúng id cũ (khôi phục từ backup, script nhập tay…).
    await taoChiPhi({ id: chiPhi.id, amount: 1_000, description: "dòng khác" });

    const res = await khoiPhucBanGhi(dong.id);

    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe("Bản ghi này đã tồn tại lại trong sổ");
    // Dòng đang SỐNG không được đụng tới.
    expect((await prisma.expense.findUniqueOrThrow({ where: { id: chiPhi.id } })).amount).toBe(1_000);
  });

  it("khoá chống trùng đã thuộc dòng khác → từ chối, nêu đích danh khoá", async () => {
    const REF = "LOAN:loan-cu:2026-07-10";
    const chiPhi = await taoChiPhi({ categoryId: "interest", amount: 2_000_000, refId: REF });
    await deleteExpense(chiPhi.id, "only");
    const dong = await prisma.banGhiDaXoa.findFirstOrThrow();
    // Kỳ lãi đó được ghi lại bằng một dòng MỚI — `Expense.refId @unique` nay thuộc về nó.
    await taoChiPhi({ categoryId: "interest", amount: 2_000_000, refId: REF });

    const res = await khoiPhucBanGhi(dong.id);

    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe(`Khoá chống trùng "${REF}" đang thuộc một dòng khác`);
    expect(await prisma.expense.count()).toBe(1);
  });

  it("danh mục gốc đã bị xoá → chỉ đúng cái phải khôi phục trước", async () => {
    const danhMuc = await prisma.expenseCategory.create({
      data: { id: "thung-rac-tam", name: "Danh mục tạm (thùng rác test)" },
    });
    try {
      const chiPhi = await taoChiPhi({ categoryId: danhMuc.id });
      await deleteExpense(chiPhi.id, "only");
      const dong = await prisma.banGhiDaXoa.findFirstOrThrow();
      await prisma.expenseCategory.delete({ where: { id: danhMuc.id } });

      const res = await khoiPhucBanGhi(dong.id);

      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error).toBe("Danh mục gốc đã bị xoá — khôi phục cái đó trước");
      expect(await prisma.expense.count()).toBe(0);
    } finally {
      // `truncateBusinessTables` cố ý KHÔNG đụng danh mục (dữ liệu tham chiếu) — tự dọn.
      await prisma.expenseCategory.deleteMany({ where: { id: danhMuc.id } });
    }
  });
});

describe("xoaVinhVienBanGhi", () => {
  it("xoá dòng snapshot, bản ghi gốc vẫn không quay lại", async () => {
    const chiPhi = await taoChiPhi();
    await deleteExpense(chiPhi.id, "only");
    const dong = await prisma.banGhiDaXoa.findFirstOrThrow();

    expect((await xoaVinhVienBanGhi(dong.id)).ok).toBe(true);

    expect(await prisma.banGhiDaXoa.count()).toBe(0);
    expect(await prisma.expense.count()).toBe(0);
  });

  it("id lạ → câu báo nói đúng chuyện không tìm thấy", async () => {
    const res = await xoaVinhVienBanGhi("khong-co-that");

    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe("Không tìm thấy mục trong thùng rác");
  });
});

/**
 * CỔNG TIỀN CỦA ĐƯỜNG KHÔI PHỤC — lưới cho phát hiện "khôi phục là đường ghi DUY NHẤT không có cổng".
 *
 * Trước bản vá, `khoiPhucBanGhiDaXoa` chỉ dò 3 thứ (id cũ · refId · cha còn sống) rồi `create` trần:
 * không `khoaCacKhoanVay`, không `kiemKhoanConHieuLuc`, không `chanDuNoAm` — trong khi 5 đường ghi
 * `CashMovement` còn lại đều có đủ. Mỗi `it` dưới đây là một cách tiền sai chui vào sổ qua cái cửa đó.
 *
 * Mọi ca từ chối đều kiểm THÊM hai thứ ngoài câu báo: KHÔNG đẻ dòng mới, và con dấu `khoiPhucLuc`
 * vẫn null (lượt từ chối phải rollback TRỌN — `return` từ trong callback `$transaction` là COMMIT).
 */
describe("khôi phục KHÔNG được vượt cổng tiền", () => {
  /** Khoản vay kỳ hạn đã giải ngân 100tr, dư nợ 100tr. */
  async function taoKhoanVay(ghiDe: Record<string, unknown> = {}) {
    const loan = await prisma.loan.create({
      data: {
        name: "BIDV 100tr",
        startDate: new Date(2026, 6, 1),
        annualRateBp: 900,
        termMonths: 12,
        firstDueDate: new Date(2026, 7, 1),
        ...ghiDe,
      },
    });
    await prisma.cashMovement.create({
      data: {
        date: new Date(2026, 6, 1),
        kind: "LOAN_IN",
        amount: 100_000_000,
        description: "Giải ngân",
        loanId: loan.id,
      },
    });
    return loan;
  }

  async function duNoCua(loanId: string): Promise<number | undefined> {
    return (await listKhoanVay()).find((l) => l.id === loanId)?.duNo;
  }

  /** Lý do mà cột "Trạng thái" của màn thùng rác đang in cho mục này. */
  async function lyDoTrenBang(id: string): Promise<string | null | undefined> {
    return (await listThungRac(1)).rows.find((r) => r.id === id)?.lyDo;
  }

  it("dòng trả gốc đã được ghi lại bằng dòng khác → khôi phục KHÔNG làm dư nợ âm", async () => {
    const loan = await taoKhoanVay();
    const traGoc = await prisma.cashMovement.create({
      data: {
        date: new Date(2026, 6, 10),
        kind: "LOAN_REPAY",
        amount: 40_000_000,
        description: "Trả gốc đợt 1",
        loanId: loan.id,
      },
    });
    expect(await duNoCua(loan.id)).toBe(60_000_000);

    // Xoá nhầm dòng 40tr (dư nợ về 100tr) rồi ghi lại MỘT dòng trả TRỌN 100tr (dư nợ về 0).
    expect((await deleteCashMovement(traGoc.id)).ok).toBe(true);
    await prisma.cashMovement.create({
      data: {
        date: new Date(2026, 6, 20),
        kind: "LOAN_REPAY",
        amount: 100_000_000,
        description: "Tất toán gốc",
        loanId: loan.id,
      },
    });
    expect(await duNoCua(loan.id)).toBe(0);

    const dong = await prisma.banGhiDaXoa.findFirstOrThrow();
    const soDongTruoc = await prisma.cashMovement.count();
    // Cột "Trạng thái" phải nói THẬT trước cả khi bấm — in "Khôi phục được" rồi mới báo lỗi là nói dối.
    expect(await lyDoTrenBang(dong.id)).toBe(CAU_SO_DU_AM.duNo);

    const res = await khoiPhucBanGhi(dong.id);

    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe(CAU_SO_DU_AM.duNo);
    // Trước bản vá: dư nợ −40.000.000đ và quỹ ra thêm 40tr không có thật, không toast nào báo.
    expect(await duNoCua(loan.id)).toBe(0);
    expect(await prisma.cashMovement.count()).toBe(soDongTruoc);
    expect(
      (await prisma.banGhiDaXoa.findUniqueOrThrow({ where: { id: dong.id } })).khoiPhucLuc
    ).toBeNull();
  });

  it("khoản vay đã tất toán → không nhét lại được dòng tiền gửi vào đó", async () => {
    const loan = await taoKhoanVay({
      name: "ACB trả gốc cuối kỳ",
      kind: "BULLET",
      laiCoDinhMoiKy: 1_000_000,
      tienGuiBatBuocMoiKy: 5_000_000,
    });
    const gui = await prisma.cashMovement.create({
      data: {
        date: new Date(2026, 6, 10),
        kind: "DEPOSIT_OUT",
        amount: 5_000_000,
        description: "Tiền gửi bắt buộc kỳ 1",
        loanId: loan.id,
      },
    });
    expect((await deleteCashMovement(gui.id)).ok).toBe(true);

    // Ngân hàng đã hoàn đúng số đang giữ rồi chốt sổ. Đóng thẳng bằng Prisma: đường tất toán thật đòi
    // dư nợ về 0, còn ở đây cần đúng TRẠNG THÁI "đã đóng" chứ không cần diễn lại cả lượt tất toán.
    await prisma.loan.update({ where: { id: loan.id }, data: { closedAt: new Date(2026, 6, 25) } });

    const dong = await prisma.banGhiDaXoa.findFirstOrThrow();
    const soDongTruoc = await prisma.cashMovement.count();
    const CAU = "Khoản vay đã tất toán — mở lại khoản vay trước khi khôi phục mục này";
    expect(await lyDoTrenBang(dong.id)).toBe(CAU);

    const res = await khoiPhucBanGhi(dong.id);

    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe(CAU);
    expect(await prisma.cashMovement.count()).toBe(soDongTruoc);
    expect(
      (await prisma.banGhiDaXoa.findUniqueOrThrow({ where: { id: dong.id } })).khoiPhucLuc
    ).toBeNull();
  });

  it("sổ tiết kiệm đã tất toán → không nhét lại được dòng gửi vào sổ đã đóng", async () => {
    const so = await prisma.soTietKiem.create({
      data: {
        name: "Techcombank 6 tháng",
        principal: 50_000_000,
        startDate: new Date(2026, 6, 3),
        termMonths: 6,
        maturityDate: new Date(2027, 0, 3),
        annualRateBp: 520,
      },
    });
    const gui = await prisma.cashMovement.create({
      data: {
        date: new Date(2026, 6, 3),
        kind: "SAVINGS_OUT",
        amount: 50_000_000,
        description: "Gửi tiết kiệm",
        savingsId: so.id,
      },
    });
    expect((await deleteCashMovement(gui.id)).ok).toBe(true);
    await prisma.soTietKiem.update({
      where: { id: so.id },
      data: { closedAt: new Date(2026, 6, 28) },
    });

    const dong = await prisma.banGhiDaXoa.findFirstOrThrow();
    const soDongTruoc = await prisma.cashMovement.count();
    const CAU = "Sổ tiết kiệm đã tất toán — mở lại sổ trước khi khôi phục mục này";
    expect(await lyDoTrenBang(dong.id)).toBe(CAU);

    const res = await khoiPhucBanGhi(dong.id);

    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe(CAU);
    expect(await prisma.cashMovement.count()).toBe(soDongTruoc);
  });

  it("khoản định kỳ đã có dòng thay thế trong tháng → khôi phục là CỘNG ĐÔI, phải chặn", async () => {
    const mau = await prisma.recurringExpense.create({
      data: { categoryId: "fixed", amount: 10_000_000, dayOfMonth: 5, description: "Thuê nhà" },
    });
    const thangNay = await taoChiPhi({
      date: new Date(2026, 6, 5),
      categoryId: "fixed",
      amount: 10_000_000,
      description: "Thuê nhà",
      source: "RECURRING",
      recurringId: mau.id,
    });

    // mode "only": mẫu định kỳ VẪN active — đó là cái bẫy.
    expect((await deleteExpense(thangNay.id, "only")).ok).toBe(true);
    expect(
      (await prisma.recurringExpense.findUniqueOrThrow({ where: { id: mau.id } })).active
    ).toBe(true);

    // Bất kỳ ai mở một trang phủ tháng đó là app TỰ SINH LẠI dòng thay thế (id mới) — gọi đúng hàm
    // thật chứ không dựng tay, để lưới này đỏ nếu cổng idempotent của nó đổi.
    expect(await ensureRecurringExpenses(new Date(2026, 6, 1))).toBe(1);
    expect(await prisma.expense.count({ where: { recurringId: mau.id } })).toBe(1);

    const dong = await prisma.banGhiDaXoa.findFirstOrThrow();
    const CAU = "Tháng này đã có khoản định kỳ thay thế — xoá dòng đó trước khi khôi phục mục này";
    expect(await lyDoTrenBang(dong.id)).toBe(CAU);

    const res = await khoiPhucBanGhi(dong.id);

    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe(CAU);
    // Trước bản vá: 2 dòng thuê nhà 10tr cùng tháng ⇒ LN ròng hụt 10tr, quỹ hụt 10tr.
    expect(await prisma.expense.count({ where: { recurringId: mau.id } })).toBe(1);
  });

  it("sổ tiết kiệm đã trỏ sang khoản vay khác → khôi phục KHÔNG cướp lại, và nói ra", async () => {
    const l1 = await prisma.loan.create({
      data: { name: "Vay cũ L1", startDate: new Date(2026, 6, 1), annualRateBp: 900 },
    });
    const l2 = await prisma.loan.create({
      data: { name: "Vay mới L2", startDate: new Date(2026, 6, 2), annualRateBp: 800 },
    });
    const so = await prisma.soTietKiem.create({
      data: {
        name: "VIB 12 tháng",
        principal: 30_000_000,
        startDate: new Date(2026, 6, 4),
        termMonths: 12,
        maturityDate: new Date(2027, 6, 4),
        annualRateBp: 610,
        loanId: l1.id,
      },
    });

    expect((await xoaKhoanVay(l1.id)).ok).toBe(true);
    // FK SetNull đã cắt liên kết; chủ shop chọn lại nguồn tiền của sổ là L2 (form cho phép).
    await prisma.soTietKiem.update({ where: { id: so.id }, data: { loanId: l2.id } });

    const dong = await prisma.banGhiDaXoa.findFirstOrThrow();
    const res = await khoiPhucBanGhi(dong.id);

    expect(res.ok).toBe(true);
    // Lựa chọn mới KHÔNG bị nuốt, và lượt khôi phục nói thẳng thứ nó cố ý không làm.
    expect((await prisma.soTietKiem.findUniqueOrThrow({ where: { id: so.id } })).loanId).toBe(l2.id);
    if (res.ok) {
      expect(res.data).toBe(
        "Không nối lại được 1 sổ tiết kiệm (VIB 12 tháng) — sổ đó nay đang trỏ sang khoản vay khác"
      );
    }
  });

  it("CỤM sổ tiết kiệm hợp lệ vẫn khôi phục được (chống vá quá tay thành chặn oan)", async () => {
    const so = await prisma.soTietKiem.create({
      data: {
        name: "MB 3 tháng",
        principal: 25_000_000,
        startDate: new Date(2026, 6, 6),
        termMonths: 3,
        maturityDate: new Date(2026, 9, 6),
        annualRateBp: 480,
      },
    });
    const gui = await prisma.cashMovement.create({
      data: {
        date: new Date(2026, 6, 6),
        kind: "SAVINGS_OUT",
        amount: 25_000_000,
        description: "Gửi tiết kiệm",
        savingsId: so.id,
      },
    });
    const quyTruoc = await tinhSoQuyThang(KY);

    expect((await xoaSoTietKiem({ id: so.id })).ok).toBe(true);
    expect(await prisma.cashMovement.count()).toBe(0);

    const dong = await prisma.banGhiDaXoa.findFirstOrThrow();
    // Cha của dòng gửi nằm NGAY TRONG cụm đang dựng: nền số dư phải lấy từ ảnh chụp, không đọc DB —
    // đọc DB là thấy "sổ chưa tồn tại" rồi chặn oan chính cụm hợp lệ này.
    expect(await lyDoTrenBang(dong.id)).toBeNull();

    const res = await khoiPhucBanGhi(dong.id);

    expect(res.ok).toBe(true);
    expect(await prisma.soTietKiem.findUniqueOrThrow({ where: { id: so.id } })).toEqual(so);
    expect(await prisma.cashMovement.findUniqueOrThrow({ where: { id: gui.id } })).toEqual(gui);
    expect(await tinhSoQuyThang(KY)).toEqual(quyTruoc);
  });

  it("sổ tiết kiệm trỏ khoản vay ĐÃ tất toán vẫn khôi phục được — liên kết đó không mang tiền", async () => {
    const loan = await taoKhoanVay({ name: "Vay đã tất toán" });
    const so = await prisma.soTietKiem.create({
      data: {
        name: "Sacombank 9 tháng",
        principal: 15_000_000,
        startDate: new Date(2026, 6, 8),
        termMonths: 9,
        maturityDate: new Date(2027, 3, 8),
        annualRateBp: 555,
        loanId: loan.id,
      },
    });
    expect((await xoaSoTietKiem({ id: so.id })).ok).toBe(true);
    await prisma.loan.update({ where: { id: loan.id }, data: { closedAt: new Date(2026, 6, 26) } });

    const dong = await prisma.banGhiDaXoa.findFirstOrThrow();
    // `SoTietKiem.loanId` chỉ để SO lãi suất, không mang đồng nào — chính form sổ cũng cho trỏ sang
    // khoản vay đã tất toán. Chặn ở đây là vá quá tay.
    expect(await lyDoTrenBang(dong.id)).toBeNull();
    expect((await khoiPhucBanGhi(dong.id)).ok).toBe(true);
    expect((await prisma.soTietKiem.findUniqueOrThrow({ where: { id: so.id } })).loanId).toBe(
      loan.id
    );
  });

  it("con dấu khôi phục là NGUYÊN TỬ: hai lượt bấm song song chỉ một lượt ghi", async () => {
    const chiPhi = await taoChiPhi();
    await deleteExpense(chiPhi.id, "only");
    const dong = await prisma.banGhiDaXoa.findFirstOrThrow();

    const [a, b] = await Promise.all([khoiPhucBanGhi(dong.id), khoiPhucBanGhi(dong.id)]);

    // Đúng MỘT lượt thắng; lượt thua phải nhận câu của con dấu, không phải lỗi trùng khoá chính
    // đội lốt "Lỗi khi khôi phục bản ghi".
    const thua = [a, b].filter((r) => !r.ok);
    expect([a, b].filter((r) => r.ok)).toHaveLength(1);
    expect(thua).toHaveLength(1);
    if (!thua[0].ok) expect(thua[0].error).toBe("Mục này đã được khôi phục");
    expect(await prisma.expense.count()).toBe(1);
  });
});

/**
 * LƯỚI "KHÔNG ĐƯỜNG XOÁ NÀO ĐƯỢC CÂM".
 *
 * Xoá vẫn là xoá CỨNG, nên dòng `BanGhiDaXoa` là bản gốc DUY NHẤT còn lại. Bỏ sót lượt chụp ở MỘT
 * nhánh là mất vĩnh viễn mà không triệu chứng nào ở tầng tiền: quỹ/P&L vẫn khớp (bản ghi biến mất
 * thật), chỉ có nút Khôi phục là không bao giờ có gì để bấm — đúng sự cố đã đẻ ra tính năng này.
 *
 * Hai nhánh dưới đây trước đây không lưới nào chạm tới: xoá SỔ TIẾT KIỆM (cụm hồ sơ + dòng gửi +
 * dòng lãi) và xoá DÒNG TIỀN GẮN CHA (nhánh `else` của `deleteCashMovement` — nhánh dòng trơn vẫn
 * chụp nên lỗi im lặng hoàn toàn).
 */
describe("ảnh chụp lúc xoá — không nhánh nào được bỏ chụp", () => {
  async function taoSoCoDongGui() {
    const so = await prisma.soTietKiem.create({
      data: {
        name: "Techcombank 6 tháng",
        principal: 25_000_000,
        startDate: new Date(2026, 6, 6),
        termMonths: 6,
        maturityDate: new Date(2027, 0, 6),
        annualRateBp: 510,
      },
    });
    const gui = await prisma.cashMovement.create({
      data: {
        date: new Date(2026, 6, 6),
        kind: "SAVINGS_OUT",
        amount: 25_000_000,
        description: "Gửi tiết kiệm",
        savingsId: so.id,
      },
    });
    return { so, gui };
  }

  it("xoá sổ tiết kiệm: ảnh chụp giữ ĐỦ hồ sơ + dòng gửi + ô dòng lãi", async () => {
    const { so, gui } = await taoSoCoDongGui();

    expect((await xoaSoTietKiem({ id: so.id })).ok).toBe(true);
    // Phép đo không rỗng: DB không còn một mẩu nào để dựng lại nếu thiếu ảnh chụp.
    expect(await prisma.soTietKiem.count()).toBe(0);
    expect(await prisma.cashMovement.count()).toBe(0);

    const dong = await prisma.banGhiDaXoa.findMany();
    expect(dong).toHaveLength(1);
    expect(dong[0]).toMatchObject({
      bang: "SoTietKiem",
      banGhiId: so.id,
      soTien: 25_000_000,
      khoiPhucLuc: null,
    });

    const anh = dong[0].anh as unknown as AnhBanGhi;
    expect(anh.chinh.id).toBe(so.id);
    // Dòng gửi bị `deleteMany` xoá kèm — không có nó trong ảnh thì 25 triệu ra khỏi quỹ vĩnh viễn.
    expect(anh.cashMovements.map((c) => c.id)).toEqual([gui.id]);
    // Cổng xoá hiện chỉ cho xoá sổ CHƯA có dòng lãi, nhưng ô `thuNhap` phải luôn có mặt: nới cổng
    // sau này mà quên chụp lãi là lãi mất không dấu vết.
    expect(anh.thuNhap).toEqual([]);
  });

  it("xoá dòng tiền GẮN CHA (khoản vay / sổ tiết kiệm): nhánh else cũng phải chụp", async () => {
    const loan = await prisma.loan.create({
      data: {
        name: "ACB 100tr",
        startDate: new Date(2026, 6, 1),
        annualRateBp: 900,
        termMonths: 12,
        firstDueDate: new Date(2026, 7, 1),
      },
    });
    await prisma.cashMovement.create({
      data: {
        date: new Date(2026, 6, 1),
        kind: "LOAN_IN",
        amount: 100_000_000,
        description: "Giải ngân",
        loanId: loan.id,
      },
    });
    const traGoc = await prisma.cashMovement.create({
      data: {
        date: new Date(2026, 6, 12),
        kind: "LOAN_REPAY",
        amount: 40_000_000,
        description: "Trả gốc đợt 1",
        loanId: loan.id,
      },
    });
    const { gui } = await taoSoCoDongGui();

    expect((await deleteCashMovement(traGoc.id)).ok).toBe(true);
    expect((await deleteCashMovement(gui.id)).ok).toBe(true);

    // Tra theo `banGhiId` chứ không theo thứ tự `xoaLuc`: hai lượt xoá cách nhau vài mili giây nên
    // sắp theo thời gian là phép so có thể hoà.
    const theoBanGhi = new Map(
      (await prisma.banGhiDaXoa.findMany()).map((d) => [d.banGhiId, d])
    );
    expect(theoBanGhi.size).toBe(2);
    expect(theoBanGhi.get(traGoc.id)).toMatchObject({
      bang: "CashMovement",
      soTien: 40_000_000,
    });
    expect(theoBanGhi.get(gui.id)).toMatchObject({ bang: "CashMovement", soTien: 25_000_000 });

    // Ảnh chụp phải dựng lại được THẬT, không chỉ tồn tại: khôi phục dòng trả gốc đưa dư nợ về đúng
    // số cũ (60tr), chứng minh cột `anh` giữ đủ `loanId` chứ không chỉ mỗi số tiền.
    const phuc = await khoiPhucBanGhi(theoBanGhi.get(traGoc.id)!.id);
    expect(phuc.ok).toBe(true);
    expect((await listKhoanVay()).find((l) => l.id === loan.id)?.duNo).toBe(60_000_000);
  });
});
