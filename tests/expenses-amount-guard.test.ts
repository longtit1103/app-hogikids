import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { createExpense, updateExpense } from "@/lib/actions/expenses";
import { prisma } from "@/lib/prisma";
import { seedReference, truncateBusinessTables } from "./helpers/test-db";

/**
 * Guard trần số tiền khoản chi (`hogikids_test`) — Prisma `Expense.amount` là Int
 * (int32, chết ở 2.147.483.647). Không có `.max()` thì amount ≥ 2^31 lọt qua zod,
 * Postgres out-of-range và user chỉ thấy "Lỗi khi tạo khoản chi" generic. Suite
 * này chốt: vượt trần 2 tỷ → chặn tại biên với message tiếng Việt rõ, đúng field.
 */
vi.mock("@/lib/session", () => ({
  requireUser: vi.fn(async () => "test-user-id"),
}));
// revalidatePath cần request scope (không có trong vitest) — no-op cho unit test.
vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

/** Input hợp lệ mặc định — từng test chỉ đổi amount. */
const validInput = (amount: number) => ({
  date: "2026-07-10", // quá khứ so với hôm nay — qua refine "không cho ngày tương lai"
  categoryId: "other",
  amount,
  channelId: null,
  description: "test trần amount",
  recurringMonthly: false,
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

describe("createExpense — trần amount 2 tỷ", () => {
  it("amount 2.147.483.648 (vượt Int32) → {ok:false, field:'amount'} message chứa 'quá lớn', KHÔNG ghi DB", async () => {
    const res = await createExpense(validInput(2_147_483_648));
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.field).toBe("amount");
      expect(res.error).toContain("quá lớn");
    }
    expect(await prisma.expense.count()).toBe(0);
  });

  it("amount 2.000.000.001 (vượt trần app 1 đồng) → {ok:false}", async () => {
    const res = await createExpense(validInput(2_000_000_001));
    expect(res.ok).toBe(false);
  });

  it("amount đúng trần 2.000.000.000 → ok, Expense ghi đủ", async () => {
    const res = await createExpense(validInput(2_000_000_000));
    expect(res.ok).toBe(true);
    const row = await prisma.expense.findFirst();
    expect(row!.amount).toBe(2_000_000_000);
  });

  it("recurringMonthly=true + amount vượt trần → cũng bị chặn (RecurringExpense.amount cùng là Int)", async () => {
    const res = await createExpense({ ...validInput(2_147_483_648), recurringMonthly: true });
    expect(res.ok).toBe(false);
    expect(await prisma.recurringExpense.count()).toBe(0);
  });
});

describe("updateExpense — trần amount 2 tỷ", () => {
  it("sửa amount vượt trần → {ok:false, field:'amount'}, giữ nguyên số cũ", async () => {
    const existing = await prisma.expense.create({
      data: {
        date: new Date("2026-07-10T00:00:00+07:00"),
        categoryId: "other",
        description: "khoản chi gốc",
        amount: 500_000,
        source: "MANUAL",
      },
    });

    const res = await updateExpense(existing.id, validInput(3_000_000_000));
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.field).toBe("amount");
      expect(res.error).toContain("quá lớn");
    }
    const after = await prisma.expense.findUnique({ where: { id: existing.id } });
    expect(after!.amount).toBe(500_000);
  });
});
