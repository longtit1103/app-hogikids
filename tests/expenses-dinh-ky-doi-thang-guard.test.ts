import { format, startOfMonth, subMonths } from "date-fns";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { updateExpense } from "@/lib/actions/expenses";
import { ensureRecurringExpenses } from "@/lib/expenses/ensure-recurring-expenses";
import { prisma } from "@/lib/prisma";
import { seedReference, truncateBusinessTables } from "./helpers/test-db";

/**
 * Dời một dòng chi phí ĐỊNH KỲ sang tháng khác phải bị CHẶN (`hogikids_test`).
 *
 * Vì sao: cổng chống trùng của `ensureRecurringExpenses` chỉ hỏi "tháng này đã có dòng nào mang
 * `recurringId` chưa". Dời dòng của tháng 7 sang tháng 8 ⇒ tháng 7 trống ⇒ lần render kế sinh bù
 * một dòng mới, trong khi dòng vừa dời vẫn nằm ở tháng 8. Khoản định kỳ vào P&L HAI LẦN, không có
 * cảnh báo nào, và không unique DB nào đỡ (schema cố ý không có unique (recurringId, tháng)).
 */
vi.mock("@/lib/session", () => ({
  requireUser: vi.fn(async () => "test-user-id"),
}));
// revalidatePath cần request scope (không có trong vitest) — no-op cho unit test.
vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

// Tháng QUÁ KHỨ: vừa qua được refine "không cho ngày tương lai" của ngayGhiTaySchema, vừa để
// `ensureRecurringExpenses` sinh được (nó bỏ qua target > hôm nay). Cùng cách chọn mốc của
// tests/recurring-expenses.test.ts.
const thangCu = subMonths(startOfMonth(new Date()), 2);
const thangGiua = subMonths(startOfMonth(new Date()), 1);
const NGAY_TRONG_THANG = 10;
const TIEN = 500_000;

const khoaNgay = (thang: Date, ngay = NGAY_TRONG_THANG) =>
  `${format(thang, "yyyy-MM")}-${String(ngay).padStart(2, "0")}`;

/** Mẫu định kỳ đang bật + đúng 1 dòng Expense của `thangCu` do mẫu đó sinh. */
async function seedDongDinhKy() {
  const recurring = await prisma.recurringExpense.create({
    data: {
      categoryId: "other",
      description: "Tiền thuê kho",
      amount: TIEN,
      dayOfMonth: NGAY_TRONG_THANG,
      channelId: null,
      active: true,
    },
  });
  const expense = await prisma.expense.create({
    data: {
      date: new Date(`${khoaNgay(thangCu)}T00:00:00+07:00`),
      categoryId: "other",
      description: "Tiền thuê kho",
      amount: TIEN,
      channelId: null,
      source: "RECURRING",
      recurringId: recurring.id,
    },
  });
  return { recurring, expense };
}

const inputSua = (ngay: string) => ({
  date: ngay,
  categoryId: "other",
  amount: TIEN,
  channelId: null,
  description: "Tiền thuê kho",
});

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

describe("updateExpense — chặn dời dòng định kỳ sang tháng khác", () => {
  it("dời sang tháng khác → từ chối ở ô 'date', dòng giữ NGUYÊN ngày cũ", async () => {
    const { expense } = await seedDongDinhKy();

    const res = await updateExpense(expense.id, inputSua(khoaNgay(thangGiua)));

    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("phải bị chặn");
    expect(res.field).toBe("date");
    expect(res.error).toContain("tính 2 lần");

    const sau = await prisma.expense.findUniqueOrThrow({ where: { id: expense.id } });
    expect(format(sau.date, "yyyy-MM")).toBe(format(thangCu, "yyyy-MM"));
  });

  it("CHỐT TIỀN: lượt dời bị chặn ⇒ tháng cũ KHÔNG bị sinh bù, sổ đúng 1 dòng, Σ = 1× tiền", async () => {
    const { expense } = await seedDongDinhKy();

    await updateExpense(expense.id, inputSua(khoaNgay(thangGiua)));
    // Đúng thứ mỗi lần render trang chi phí làm: ensure lại tháng đang xem.
    const daSinh = await ensureRecurringExpenses(thangCu);

    expect(daSinh).toBe(0);
    const dong = await prisma.expense.findMany({ where: { recurringId: { not: null } } });
    expect(dong).toHaveLength(1);
    const tong = await prisma.expense.aggregate({
      where: { recurringId: { not: null } },
      _sum: { amount: true },
    });
    expect(tong._sum.amount).toBe(TIEN);
  });

  it("đổi ngày TRONG CÙNG tháng → lưu được (không siết oan)", async () => {
    const { expense } = await seedDongDinhKy();

    const res = await updateExpense(expense.id, inputSua(khoaNgay(thangCu, 15)));

    expect(res.ok).toBe(true);
    const sau = await prisma.expense.findUniqueOrThrow({ where: { id: expense.id } });
    expect(format(sau.date, "yyyy-MM-dd")).toBe(khoaNgay(thangCu, 15));
  });

  it("đổi số tiền, giữ nguyên ngày → lưu được", async () => {
    const { expense } = await seedDongDinhKy();

    const res = await updateExpense(expense.id, {
      ...inputSua(khoaNgay(thangCu)),
      amount: 777_000,
    });

    expect(res.ok).toBe(true);
    const sau = await prisma.expense.findUniqueOrThrow({ where: { id: expense.id } });
    expect(sau.amount).toBe(777_000);
  });

  it("mẫu đã DỪNG (active=false) → dời tháng vẫn lưu được (không chặn oan)", async () => {
    // `ensureRecurringExpenses` lọc `active: true`, nên mẫu đã dừng thì không còn ai sinh bù dòng
    // tháng cũ — lượt dời vô hại. Ca này là lưới chống chặn-oan sau khi bấm "Xóa và dừng lặp lại".
    const { recurring, expense } = await seedDongDinhKy();
    await prisma.recurringExpense.update({ where: { id: recurring.id }, data: { active: false } });

    const res = await updateExpense(expense.id, inputSua(khoaNgay(thangGiua)));

    expect(res.ok).toBe(true);
    const sau = await prisma.expense.findUniqueOrThrow({ where: { id: expense.id } });
    expect(format(sau.date, "yyyy-MM")).toBe(format(thangGiua, "yyyy-MM"));
    // Và đúng là không có dòng nào được sinh bù cho tháng cũ.
    expect(await ensureRecurringExpenses(thangCu)).toBe(0);
  });

  it("dòng THƯỜNG (recurringId null) dời sang tháng khác → vẫn lưu được", async () => {
    const expense = await prisma.expense.create({
      data: {
        date: new Date(`${khoaNgay(thangCu)}T00:00:00+07:00`),
        categoryId: "other",
        description: "Chi lẻ",
        amount: TIEN,
        channelId: null,
        source: "MANUAL",
      },
    });

    const res = await updateExpense(expense.id, inputSua(khoaNgay(thangGiua)));

    expect(res.ok).toBe(true);
    const sau = await prisma.expense.findUniqueOrThrow({ where: { id: expense.id } });
    expect(format(sau.date, "yyyy-MM")).toBe(format(thangGiua, "yyyy-MM"));
  });
});
