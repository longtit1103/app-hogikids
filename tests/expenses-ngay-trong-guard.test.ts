import { addDays, format } from "date-fns";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { createExpense, updateExpense } from "@/lib/actions/expenses";
import { prisma } from "@/lib/prisma";
import { seedReference, truncateBusinessTables } from "./helpers/test-db";

/**
 * Lưới "ô Ngày bị xoá trống" của Sổ chi phí (`hogikids_test`) — cùng họ lỗi đã vá ở khoản tiền khác
 * 03/09: form gửi Invalid Date ⇒ React serialize thành `null` ⇒ `z.coerce.date()` ra 01/01/1970 ⇒ dòng
 * chi phí ghi (hoặc bị DỜI khi sửa) về năm 1970, không hiện ở tháng nào mà toast vẫn xanh. Với
 * `recurringMonthly` còn tệ hơn: `RecurringExpense.dayOfMonth = getDate(1970-01-01) = 1` ⇒ từ đó mỗi
 * tháng tự đẻ thêm một dòng ngày 1. Suite chốt: cả bốn dạng ngày trống đều bị từ chối ở ô "date",
 * KHÔNG ghi gì; ngày hợp lệ vẫn qua (refine "hợp lệ" không chặn oan) và refine "tương lai" vẫn chạy.
 */
vi.mock("@/lib/session", () => ({
  requireUser: vi.fn(async () => "test-user-id"),
}));
// revalidatePath cần request scope (không có trong vitest) — no-op cho unit test.
vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

const hopLe = (ghiDe: Record<string, unknown> = {}) => ({
  date: "2026-07-10",
  categoryId: "other",
  amount: 150_000,
  channelId: null,
  description: "test ngày trống",
  recurringMonthly: false,
  ...ghiDe,
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

describe("createExpense — ô Ngày trống", () => {
  // `null`/`0` ra Date năm 1970 (hợp lệ với zod, chỉ refine bắt được); `undefined`/`""` ra Invalid Date
  // nên chết ngay ở bước coerce với message tiếng Anh của zod. Cả bốn đều PHẢI từ chối ở ô "date".
  it.each([
    [null, "Ngày không hợp lệ"],
    [0, "Ngày không hợp lệ"],
    [undefined, undefined],
    ["", undefined],
  ])("date %s → từ chối field 'date', không ghi dòng nào", async (date, thongBao) => {
    const res = await createExpense(hopLe({ date }));
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.field).toBe("date");
      if (thongBao) expect(res.error).toBe(thongBao);
    }
    expect(await prisma.expense.count()).toBe(0);
  });

  it("recurringMonthly=true + date null → từ chối, KHÔNG sinh RecurringExpense ngày 1", async () => {
    const res = await createExpense(hopLe({ date: null, recurringMonthly: true }));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.field).toBe("date");
    expect(await prisma.recurringExpense.count()).toBe(0);
    expect(await prisma.expense.count()).toBe(0);
  });

  it("ngày mai → vẫn từ chối 'Không cho ngày tương lai' (refine thứ hai còn chạy)", async () => {
    const res = await createExpense(hopLe({ date: format(addDays(new Date(), 1), "yyyy-MM-dd") }));
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.field).toBe("date");
      expect(res.error).toBe("Không cho ngày tương lai");
    }
    expect(await prisma.expense.count()).toBe(0);
  });

  it("ngày hợp lệ → ok, ghi đúng ngày (refine 'hợp lệ' không chặn oan)", async () => {
    const res = await createExpense(hopLe());
    expect(res.ok).toBe(true);
    const row = await prisma.expense.findFirstOrThrow();
    expect(format(row.date, "yyyy-MM-dd")).toBe("2026-07-10");
  });
});

describe("updateExpense — ô Ngày trống", () => {
  it("date null (ô Ngày bị xoá trống) → từ chối, ngày của dòng thật KHÔNG bị dời về 1970", async () => {
    await createExpense(hopLe());
    const row = await prisma.expense.findFirstOrThrow();

    const res = await updateExpense(row.id, hopLe({ date: null }));
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.field).toBe("date");
      expect(res.error).toBe("Ngày không hợp lệ");
    }
    const sau = await prisma.expense.findUniqueOrThrow({ where: { id: row.id } });
    expect(format(sau.date, "yyyy-MM-dd")).toBe("2026-07-10");
  });
});
