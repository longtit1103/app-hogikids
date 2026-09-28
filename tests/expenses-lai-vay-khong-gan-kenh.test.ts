import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { createExpense, updateExpense } from "@/lib/actions/expenses";
import { prisma } from "@/lib/prisma";
import { seedReference, truncateBusinessTables } from "./helpers/test-db";

/**
 * MỌI dòng danh mục Lãi vay (`interest`) phải KHÔNG gắn kênh — cả tạo mới lẫn sửa, cả dòng chủ shop
 * nhập tay lẫn dòng do duyệt kỳ sinh ra (`hogikids_test`).
 *
 * Vì sao: lãi vay không phân bổ kênh (bất biến #1, cùng luật `fixed`). `pnl.ts` đã loại `interest`
 * khỏi lăng kính kênh nên gắn kênh không lệch tiền, nhưng làm mọc kênh rỗng ở `/kenh` + dashboard.
 * Khoá riêng dòng `LOAN:` là chưa đủ: dòng "Lãi vay" nhập tay lặp lại đúng triệu chứng đó.
 *
 * Cổng chặn MỌI kênh khác null chứ không so kênh cũ — dòng lỡ mang kênh tự gỡ ở lượt sửa kế. Danh
 * mục khác vẫn gắn kênh bình thường (không siết oan).
 */
vi.mock("@/lib/session", () => ({
  requireUser: vi.fn(async () => "test-user-id"),
}));
// revalidatePath cần request scope (không có trong vitest) — no-op cho unit test.
vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

// Ngày QUÁ KHỨ cố định: qua được refine "không cho ngày tương lai" của `ngayGhiTaySchema`.
const NGAY = "2026-07-10";
const TIEN = 850_000;

const input = (
  over: Partial<{ categoryId: string; channelId: string | null; recurringMonthly: boolean; adsSource: string }> = {},
) => ({
  date: NGAY,
  categoryId: "interest",
  amount: TIEN,
  channelId: null,
  description: "Lãi vay tháng 7 — nhập tay",
  ...over,
});

/** Dòng Lãi vay chủ shop nhập tay: `refId` null, không phải dòng duyệt kỳ. */
async function seedDongLaiNhapTay(channelId: string | null = null) {
  return prisma.expense.create({
    data: {
      date: new Date(`${NGAY}T00:00:00+07:00`),
      categoryId: "interest",
      description: "Lãi vay tháng 7 — nhập tay",
      amount: TIEN,
      channelId,
      source: "MANUAL",
      refId: null,
    },
  });
}

function kyVongChanKenh(res: Awaited<ReturnType<typeof createExpense>>) {
  expect(res.ok).toBe(false);
  if (res.ok) throw new Error("phải bị chặn");
  expect(res.field).toBe("channelId");
  expect(res.code).toBe("LAI_VAY_KHONG_GAN_KENH");
}

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

describe("createExpense — Lãi vay không gắn kênh", () => {
  it("Lãi vay + kênh → chặn ở ô 'channelId', KHÔNG dòng nào được ghi", async () => {
    const res = await createExpense(input({ channelId: "tiktok" }));

    kyVongChanKenh(res);
    expect(await prisma.expense.count()).toBe(0);
  });

  it("Lãi vay không kênh → lưu được, kênh trống", async () => {
    const res = await createExpense(input());

    expect(res.ok).toBe(true);
    const dong = await prisma.expense.findFirstOrThrow({ where: { categoryId: "interest" } });
    expect(dong.channelId).toBeNull();
    expect(dong.amount).toBe(TIEN);
  });

  it("Lãi vay + kênh + lặp hàng tháng → chặn TRƯỚC khi dựng mẫu: 0 RecurringExpense, 0 Expense", async () => {
    // Mẫu mang kênh sẽ được `ensureRecurringExpenses` sinh lại dòng sai mỗi tháng.
    const res = await createExpense(input({ channelId: "shopee", recurringMonthly: true }));

    kyVongChanKenh(res);
    expect(await prisma.recurringExpense.count()).toBe(0);
    expect(await prisma.expense.count()).toBe(0);
  });

  it("danh mục KHÁC ('other') + kênh → vẫn lưu được, giữ kênh (không siết oan)", async () => {
    const res = await createExpense(input({ categoryId: "other", channelId: "tiktok" }));

    expect(res.ok).toBe(true);
    const dong = await prisma.expense.findFirstOrThrow({ where: { categoryId: "other" } });
    expect(dong.channelId).toBe("tiktok");
  });

  it("danh mục 'ads' + kênh → vẫn lưu được, giữ kênh (không siết oan)", async () => {
    const res = await createExpense(input({ categoryId: "ads", adsSource: "META", channelId: "facebook" }));

    expect(res.ok).toBe(true);
    const dong = await prisma.expense.findFirstOrThrow({ where: { categoryId: "ads" } });
    expect(dong.channelId).toBe("facebook");
  });
});

describe("updateExpense — Lãi vay không gắn kênh", () => {
  it("dòng Lãi vay NHẬP TAY (refId null) gắn kênh → chặn; kênh sau vẫn trống", async () => {
    const dong = await seedDongLaiNhapTay();

    const res = await updateExpense(dong.id, input({ channelId: "tiktok" }));

    kyVongChanKenh(res);
    const sau = await prisma.expense.findUniqueOrThrow({ where: { id: dong.id } });
    expect(sau.channelId).toBeNull();
  });

  it("dòng Lãi vay nhập tay LỠ mang kênh → sửa với kênh trống lưu được và GỠ kênh", async () => {
    const dong = await seedDongLaiNhapTay("tiktok");

    const res = await updateExpense(dong.id, { ...input({ channelId: null }), amount: 900_000 });

    expect(res.ok).toBe(true);
    const sau = await prisma.expense.findUniqueOrThrow({ where: { id: dong.id } });
    expect(sau.channelId).toBeNull();
    expect(sau.amount).toBe(900_000);
  });

  it("dòng Lãi vay lỡ mang kênh, sửa mà GIỮ nguyên kênh cũ → vẫn chặn (không so với kênh đang có)", async () => {
    const dong = await seedDongLaiNhapTay("tiktok");

    const res = await updateExpense(dong.id, input({ channelId: "tiktok" }));

    kyVongChanKenh(res);
  });

  it("đổi danh mục một dòng CÓ kênh SANG Lãi vay mà giữ kênh → chặn; dòng giữ nguyên danh mục cũ", async () => {
    const dong = await prisma.expense.create({
      data: {
        date: new Date(`${NGAY}T00:00:00+07:00`),
        categoryId: "other",
        description: "Khoản khác",
        amount: TIEN,
        channelId: "shopee",
        source: "MANUAL",
      },
    });

    const res = await updateExpense(dong.id, input({ categoryId: "interest", channelId: "shopee" }));

    kyVongChanKenh(res);
    const sau = await prisma.expense.findUniqueOrThrow({ where: { id: dong.id } });
    expect(sau.categoryId).toBe("other");
    expect(sau.channelId).toBe("shopee");
  });

  it("danh mục KHÁC ('other') có kênh, sửa số tiền giữ kênh → vẫn lưu được (không siết oan)", async () => {
    const dong = await prisma.expense.create({
      data: {
        date: new Date(`${NGAY}T00:00:00+07:00`),
        categoryId: "other",
        description: "Khoản khác",
        amount: TIEN,
        channelId: "shopee",
        source: "MANUAL",
      },
    });

    const res = await updateExpense(dong.id, input({ categoryId: "other", channelId: "shopee" }));

    expect(res.ok).toBe(true);
    const sau = await prisma.expense.findUniqueOrThrow({ where: { id: dong.id } });
    expect(sau.channelId).toBe("shopee");
  });
});
