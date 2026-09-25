import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { getRecurringExpenseList } from "@/lib/expenses/expense-queries";
import { prisma } from "@/lib/prisma";
import { seedReference, truncateBusinessTables } from "./helpers/test-db";

/**
 * Integration test (`hogikids_test`) cho `getRecurringExpenseList` — khối CHỈ-ĐỌC liệt kê mọi mẫu
 * chi định kỳ (đang chạy lẫn đã dừng) ở tab Sổ chi phí. `RecurringExpense` không có quan hệ Prisma
 * tới ExpenseCategory/Channel nên hàm tra tên bằng Map — kiểm tra ĐÚNG tên danh mục/kênh, không
 * lệch id thô. Sắp: active trước, rồi mô tả A→Z.
 */
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

describe("getRecurringExpenseList", () => {
  it("trả cả active lẫn inactive, đúng tên danh mục/kênh, active trước rồi mô tả A→Z", async () => {
    await prisma.recurringExpense.createMany({
      data: [
        // Cố ý tạo lệch thứ tự chèn để chứng minh hàm TỰ SẮP, không dựa vào thứ tự DB trả về.
        { categoryId: "fixed", amount: 3_000_000, dayOfMonth: 30, description: "Mặt bằng", channelId: "shopee" },
        { categoryId: "other", amount: 1_000_000, dayOfMonth: 5, description: "Phần mềm" }, // không gắn kênh
        {
          categoryId: "ads",
          amount: 7_000_000,
          dayOfMonth: 28,
          description: "Ads cũ đã tắt",
          active: false,
        },
        { categoryId: "fixed", amount: 500_000, dayOfMonth: 1, description: "Internet" },
      ],
    });

    const rows = await getRecurringExpenseList();

    expect(rows).toHaveLength(4);
    // Active trước (3 dòng), inactive sau (1 dòng) — trong mỗi nhóm sắp mô tả A→Z.
    expect(rows.map((r) => [r.description, r.active])).toEqual([
      ["Internet", true],
      ["Mặt bằng", true],
      ["Phần mềm", true],
      ["Ads cũ đã tắt", false],
    ]);

    const matBang = rows.find((r) => r.description === "Mặt bằng");
    expect(matBang).toMatchObject({
      categoryName: "Mặt bằng-cố định", // tra tên qua Map, KHÔNG phải id thô "fixed"
      channelName: "Shopee",
      amount: 3_000_000,
      dayOfMonth: 30,
    });

    const phanMem = rows.find((r) => r.description === "Phần mềm");
    expect(phanMem).toMatchObject({ categoryName: "Khác", channelName: null });

    const adsCu = rows.find((r) => r.description === "Ads cũ đã tắt");
    expect(adsCu).toMatchObject({ categoryName: "Quảng cáo", active: false });
  });

  it("trả kèm mốc activeFrom (NULL với mẫu cũ)", async () => {
    const moc = new Date(2026, 8, 1);
    await prisma.recurringExpense.createMany({
      data: [
        { categoryId: "fixed", amount: 1_000, dayOfMonth: 1, description: "Có mốc", activeFrom: moc },
        { categoryId: "fixed", amount: 1_000, dayOfMonth: 1, description: "Không mốc" },
      ],
    });

    const rows = await getRecurringExpenseList();

    expect(rows.find((r) => r.description === "Có mốc")?.activeFrom?.getTime()).toBe(moc.getTime());
    expect(rows.find((r) => r.description === "Không mốc")?.activeFrom).toBeNull();
  });

  it("không có mẫu nào ⇒ mảng rỗng", async () => {
    const rows = await getRecurringExpenseList();
    expect(rows).toEqual([]);
  });
});
