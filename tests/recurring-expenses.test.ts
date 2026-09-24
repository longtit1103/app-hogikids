import { addMonths, format, getDaysInMonth, setDate, startOfMonth, subMonths } from "date-fns";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  ensureRecurringExpenses,
  ensureRecurringExpensesForMonths,
  monthStartsInRange,
} from "@/lib/expenses/ensure-recurring-expenses";
import { prisma } from "@/lib/prisma";
import { seedReference, truncateBusinessTables } from "./helpers/test-db";

/**
 * Integration test sinh chi phí định kỳ lazy-idempotent (`hogikids_test`).
 * "Hôm nay" neo `new Date()` thật → test phải xác định (deterministic) bất kể
 * ngày chạy: các case bắt buộc `target ≤ today` (kẹp ngày, idempotent) dùng
 * THÁNG QUÁ KHỨ; case "chưa tới ngày" dùng tháng hiện tại với ngày > hôm nay.
 */

// Tháng quá khứ chắc chắn (2 tháng trước) → mọi target ≤ hôm nay.
const pastMonth = subMonths(startOfMonth(new Date()), 2);

beforeAll(async () => {
  await seedReference();
}, 60_000);

beforeEach(async () => {
  await truncateBusinessTables();
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("ensureRecurringExpenses", () => {
  it("gọi 2 lần cùng tháng → đúng 1 Expense (idempotent)", async () => {
    await prisma.recurringExpense.create({
      data: { categoryId: "fixed", amount: 3_000_000, dayOfMonth: 15, description: "Tiền mặt bằng" },
    });

    const first = await ensureRecurringExpenses(pastMonth);
    const second = await ensureRecurringExpenses(pastMonth);

    expect(first).toBe(1);
    expect(second).toBe(0);
    expect(await prisma.expense.count()).toBe(1);
  });

  it("dayOfMonth=31 gặp tháng 2 → kẹp về ngày cuối tháng (28/29)", async () => {
    const now = new Date();
    // Tháng 2 của một năm chắc chắn trong quá khứ (getMonth: Feb=1).
    const febYear = now.getMonth() >= 2 ? now.getFullYear() : now.getFullYear() - 1;
    const feb = new Date(febYear, 1, 1);
    const lastDayOfFeb = getDaysInMonth(feb); // 28 hoặc 29

    await prisma.recurringExpense.create({
      data: { categoryId: "fixed", amount: 1_000_000, dayOfMonth: 31, description: "Phí cố định" },
    });

    const created = await ensureRecurringExpenses(feb);
    expect(created).toBe(1);

    const expense = await prisma.expense.findFirst();
    expect(expense).not.toBeNull();
    expect(expense!.date.getMonth()).toBe(1); // tháng 2 (0-index)
    expect(expense!.date.getDate()).toBe(lastDayOfFeb); // 28 hoặc 29, KHÔNG tràn sang tháng 3
  });

  it("dayOfMonth lớn hơn ngày hiện tại → chưa sinh", async () => {
    const now = new Date();
    const daysThisMonth = getDaysInMonth(now);
    // Chọn tháng/ngày chắc chắn còn ở tương lai so với hôm nay. Ưu tiên tháng
    // hiện tại (ngày cuối tháng > hôm nay); nếu hôm nay đã là ngày cuối tháng
    // thì lùi sang tháng sau.
    const monthUnderTest = now.getDate() < daysThisMonth ? now : addMonths(now, 1);
    const futureDay = now.getDate() < daysThisMonth ? daysThisMonth : 15;

    await prisma.recurringExpense.create({
      data: { categoryId: "fixed", amount: 2_000_000, dayOfMonth: futureDay, description: "Chưa tới hạn" },
    });

    const created = await ensureRecurringExpenses(monthUnderTest);
    expect(created).toBe(0);
    expect(await prisma.expense.count()).toBe(0);
  });

  it("active=false → không sinh", async () => {
    await prisma.recurringExpense.create({
      data: { categoryId: "fixed", amount: 1_000_000, dayOfMonth: 10, description: "Đã tắt", active: false },
    });

    const created = await ensureRecurringExpenses(pastMonth);
    expect(created).toBe(0);
    expect(await prisma.expense.count()).toBe(0);
  });

  it("dòng sinh ra có source=RECURRING + recurringId đúng", async () => {
    const r = await prisma.recurringExpense.create({
      data: { categoryId: "shipping", amount: 500_000, dayOfMonth: 5, description: "Phí ship định kỳ", channelId: "shopee" },
    });

    await ensureRecurringExpenses(pastMonth);

    const expense = await prisma.expense.findFirst({ where: { recurringId: r.id } });
    expect(expense).not.toBeNull();
    expect(expense!.source).toBe("RECURRING");
    expect(expense!.recurringId).toBe(r.id);
    expect(expense!.categoryId).toBe("shipping");
    expect(expense!.amount).toBe(500_000);
    expect(expense!.channelId).toBe("shopee");
  });

  it("mẫu Lãi vay lỡ mang kênh (dựng trước cổng chặn) → dòng sinh ra KHÔNG gắn kênh", async () => {
    // Lãi vay không phân bổ kênh (bất biến #1). Ghi thẳng bảng để mô phỏng mẫu cũ lọt trước cổng
    // `createExpense` — không action nào sửa được mẫu, nên chỗ sinh phải tự gỡ.
    const r = await prisma.recurringExpense.create({
      data: { categoryId: "interest", amount: 900_000, dayOfMonth: 5, description: "Lãi vay tay", channelId: "shopee" },
    });

    await ensureRecurringExpenses(pastMonth);

    const expense = await prisma.expense.findFirst({ where: { recurringId: r.id } });
    expect(expense).not.toBeNull();
    expect(expense!.categoryId).toBe("interest");
    expect(expense!.channelId).toBeNull();
  });
});

describe("ensureRecurringExpensesForMonths", () => {
  // dayOfMonth=1 để tháng hiện tại LUÔN đã tới hạn (hôm nay ≥ ngày 1) — test
  // xác định bất kể ngày chạy.
  async function seedRecurringDay1(): Promise<void> {
    await prisma.recurringExpense.create({
      data: { categoryId: "fixed", amount: 3_000_000, dayOfMonth: 1, description: "Tiền mặt bằng" },
    });
  }

  it("backfill tháng quá khứ: mỗi tháng truyền vào đúng 1 Expense", async () => {
    await seedRecurringDay1();

    const thisMonth = startOfMonth(new Date());
    const months = [thisMonth, subMonths(thisMonth, 1), subMonths(thisMonth, 3)];
    const created = await ensureRecurringExpensesForMonths(months);

    expect(created).toBe(3);
    const expenses = await prisma.expense.findMany();
    expect(expenses).toHaveLength(3);
    // Mỗi tháng yêu cầu có ĐÚNG 1 dòng, không lẫn sang tháng khác.
    const monthKeys = expenses.map((e) => format(e.date, "yyyy-MM")).sort();
    expect(monthKeys).toEqual(months.map((m) => format(m, "yyyy-MM")).sort());
  });

  it("idempotent: gọi lại cùng danh sách → 0 tạo mới, tổng không đổi", async () => {
    await seedRecurringDay1();

    const thisMonth = startOfMonth(new Date());
    const months = [thisMonth, subMonths(thisMonth, 1), subMonths(thisMonth, 3)];
    const first = await ensureRecurringExpensesForMonths(months);
    const second = await ensureRecurringExpensesForMonths(months);

    expect(first).toBe(3);
    expect(second).toBe(0);
    expect(await prisma.expense.count()).toBe(3);
  });

  it("tháng tương lai → KHÔNG sinh (guard target > today giữ nguyên)", async () => {
    await seedRecurringDay1();

    const created = await ensureRecurringExpensesForMonths([startOfMonth(addMonths(new Date(), 1))]);

    expect(created).toBe(0);
    expect(await prisma.expense.count()).toBe(0);
  });

  it("dedupe: 2 Date khác nhau cùng tháng (yyyy-MM) → chỉ ensure 1 lần", async () => {
    await seedRecurringDay1();

    // pastMonth (ngày 1) và ngày 20 cùng tháng — cùng key yyyy-MM.
    const created = await ensureRecurringExpensesForMonths([pastMonth, setDate(pastMonth, 20)]);

    expect(created).toBe(1);
    expect(await prisma.expense.count()).toBe(1);
  });
});

describe("monthStartsInRange", () => {
  it("range vắt 3 tháng → 3 đầu tháng theo thứ tự", () => {
    // 20/05 → 16/07: giao với tháng 5, 6, 7.
    const months = monthStartsInRange({ from: new Date(2026, 4, 20), to: new Date(2026, 6, 16) });
    expect(months.map((m) => format(m, "yyyy-MM-dd"))).toEqual(["2026-05-01", "2026-06-01", "2026-07-01"]);
  });

  it("range 1 ngày giữa tháng → đúng 1 đầu tháng", () => {
    const day = new Date(2026, 6, 5);
    const months = monthStartsInRange({ from: day, to: day });
    expect(months.map((m) => format(m, "yyyy-MM-dd"))).toEqual(["2026-07-01"]);
  });

  it("range ngược (from > to) → rỗng, không loop vô hạn", () => {
    expect(monthStartsInRange({ from: new Date(2026, 6, 5), to: new Date(2026, 5, 1) })).toEqual([]);
  });
});
