import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { prisma } from "@/lib/prisma";
import { listKhoanVay } from "@/lib/so-quy/khoan-vay-queries";

import { seedReference, truncateBusinessTables } from "./helpers/test-db";

/**
 * MỘT LỜI KHAI DUY NHẤT: lượt chụp thùng rác và câu xoá cứng phải nằm trong CÙNG một transaction.
 *
 * Vì sao cần lưới riêng: mọi test khác chỉ đo "xoá xong có ảnh chụp không" — chúng vẫn XANH khi ai
 * đó đẩy `chupVaoThungRac` ra NGOÀI `prisma.$transaction` (chụp sau khi xoá đã commit). Chế độ hỏng
 * của kiểu viết đó chỉ lộ ra đúng lúc câu chụp hỏng: xoá đã commit, ảnh chụp không có ⇒ bản ghi mất
 * VĨNH VIỄN, đúng sự cố đã đẻ ra tính năng này. Ở trong transaction thì câu chụp hỏng là rollback
 * trọn: chủ shop thấy toast đỏ, dữ liệu còn nguyên.
 *
 * Cách đo: ép chính câu chụp NÉM, rồi khẳng định bản ghi gốc VẪN CÒN và thùng rác trống. Phủ CẢ 5
 * đường xoá vì chúng chia sẻ đúng một luật, và mỗi đường là một chỗ để quên.
 */
vi.mock("@/lib/session", () => ({ requireUser: vi.fn(async () => "test-user-id") }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

/** Mô phỏng lượt ghi `BanGhiDaXoa` hỏng giữa chừng (mất kết nối, hết chỗ, ràng buộc mới…). */
vi.mock("@/lib/thung-rac/ghi-thung-rac", () => ({
  chupVaoThungRac: vi.fn(async () => {
    throw new Error("ép câu chụp thùng rác hỏng");
  }),
}));

const { deleteExpense } = await import("@/lib/actions/expenses");
const { deleteCashMovement } = await import("@/lib/actions/cash-movements");
const { xoaKhoanVay } = await import("@/lib/actions/khoan-vay");
const { xoaSoTietKiem } = await import("@/lib/actions/so-tiet-kiem");

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

async function taoKhoanVay() {
  const loan = await prisma.loan.create({
    data: {
      name: "VPBank 100tr",
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
  return loan;
}

async function taoSoTietKiem() {
  const so = await prisma.soTietKiem.create({
    data: {
      name: "VIB 6 tháng",
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

describe("chụp hỏng ⇒ lượt xoá phải rollback TRỌN (chụp và xoá cùng một transaction)", () => {
  it("khoản chi: dòng gốc còn nguyên, thùng rác trống", async () => {
    const chiPhi = await prisma.expense.create({
      data: {
        date: new Date(2026, 6, 10),
        categoryId: "shipping",
        description: "Cước vận chuyển tháng 7",
        amount: 28_999_920,
        source: "MANUAL",
      },
    });

    const kq = await deleteExpense(chiPhi.id, "only");

    expect(kq.ok).toBe(false);
    expect(await prisma.expense.findUniqueOrThrow({ where: { id: chiPhi.id } })).toEqual(chiPhi);
    expect(await prisma.banGhiDaXoa.count()).toBe(0);
  });

  it("khoản tiền khác (dòng TRƠN, không cha): dòng gốc còn nguyên", async () => {
    const dong = await prisma.cashMovement.create({
      data: {
        date: new Date(2026, 6, 2),
        kind: "CAPITAL_IN",
        amount: 500_000_000,
        description: "Góp vốn",
      },
    });

    const kq = await deleteCashMovement(dong.id);

    expect(kq.ok).toBe(false);
    expect(await prisma.cashMovement.findUniqueOrThrow({ where: { id: dong.id } })).toEqual(dong);
    expect(await prisma.banGhiDaXoa.count()).toBe(0);
  });

  it("khoản tiền khác GẮN CHA: dòng gốc còn nguyên, dư nợ không nhúc nhích", async () => {
    const loan = await taoKhoanVay();
    const traGoc = await prisma.cashMovement.create({
      data: {
        date: new Date(2026, 6, 12),
        kind: "LOAN_REPAY",
        amount: 40_000_000,
        description: "Trả gốc đợt 1",
        loanId: loan.id,
      },
    });

    const kq = await deleteCashMovement(traGoc.id);

    expect(kq.ok).toBe(false);
    expect(await prisma.cashMovement.findUniqueOrThrow({ where: { id: traGoc.id } })).toEqual(
      traGoc
    );
    expect((await listKhoanVay()).find((l) => l.id === loan.id)?.duNo).toBe(60_000_000);
    expect(await prisma.banGhiDaXoa.count()).toBe(0);
  });

  it("sổ tiết kiệm (CỤM hồ sơ + dòng gửi): cả cụm còn nguyên", async () => {
    const { so, gui } = await taoSoTietKiem();

    const kq = await xoaSoTietKiem({ id: so.id });

    expect(kq.ok).toBe(false);
    expect(await prisma.soTietKiem.findUniqueOrThrow({ where: { id: so.id } })).toEqual(so);
    expect(await prisma.cashMovement.findUniqueOrThrow({ where: { id: gui.id } })).toEqual(gui);
    expect(await prisma.banGhiDaXoa.count()).toBe(0);
  });

  it("khoản vay (CỤM hồ sơ + dòng tiền): cả cụm còn nguyên", async () => {
    const loan = await taoKhoanVay();

    const kq = await xoaKhoanVay(loan.id);

    expect(kq.ok).toBe(false);
    expect(await prisma.loan.findUniqueOrThrow({ where: { id: loan.id } })).toEqual(loan);
    expect(await prisma.cashMovement.count({ where: { loanId: loan.id } })).toBe(1);
    expect(await prisma.banGhiDaXoa.count()).toBe(0);
  });
});
