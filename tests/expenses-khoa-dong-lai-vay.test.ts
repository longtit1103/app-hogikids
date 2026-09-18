import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { deleteExpense, updateExpense } from "@/lib/actions/expenses";
import { prisma } from "@/lib/prisma";
import { seedReference, truncateBusinessTables } from "./helpers/test-db";

/**
 * Dòng lãi vay theo kỳ (`refId` `LOAN:{loanId}:{yyyy-MM-dd}`) phải KHOÁ ngày + danh mục ở đường
 * SỬA (`hogikids_test`).
 *
 * Vì sao: con dấu `Loan.lastDueHandled` không lùi ở bất kỳ đâu. Dời ngày dòng lãi = tách kỳ khỏi
 * tháng P&L của nó mà không còn đường duyệt lại qua UI (lãi biến mất khỏi Lãi/Lỗ trong khi dư nợ
 * và quỹ đã trừ gốc). Đổi danh mục = mất dòng "Lãi vay" riêng trong bảng Lãi/Lỗ (bất biến #1).
 *
 * Nhưng SỐ TIỀN phải mở: đó là đường duy nhất chủ shop tự chữa số lãi khai sai sau khi con dấu đã
 * đóng. Và đường XOÁ CỐ Ý không chặn — xem ca cuối.
 */
vi.mock("@/lib/session", () => ({
  requireUser: vi.fn(async () => "test-user-id"),
}));
// revalidatePath cần request scope (không có trong vitest) — no-op cho unit test.
vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

const NGAY_KY = "2026-07-10";
const LAI = 1_121_096;

/** Dòng lãi như `ghiKyTraNo` ghi ra: danh mục `interest`, source MANUAL, refId mang mốc kỳ. */
async function seedDongLaiVay() {
  return prisma.expense.create({
    data: {
      date: new Date(`${NGAY_KY}T00:00:00+07:00`),
      categoryId: "interest",
      description: "Lãi kỳ 10/07/2026",
      amount: LAI,
      channelId: null,
      source: "MANUAL",
      refId: `LOAN:loan-test-x:${NGAY_KY}`,
    },
  });
}

const inputSua = (over: Partial<{ date: string; categoryId: string; amount: number }> = {}) => ({
  date: NGAY_KY,
  categoryId: "interest",
  amount: LAI,
  channelId: null,
  description: "Lãi kỳ 10/07/2026",
  ...over,
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

describe("updateExpense — khoá dòng lãi vay theo kỳ", () => {
  it("đổi NGÀY → từ chối ở ô 'date'; ngày + refId giữ nguyên", async () => {
    const dong = await seedDongLaiVay();

    const res = await updateExpense(dong.id, inputSua({ date: "2026-07-11" }));

    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("phải bị chặn");
    expect(res.field).toBe("date");
    expect(res.code).toBe("KY_VAY_KHOA_NGAY");

    const sau = await prisma.expense.findUniqueOrThrow({ where: { id: dong.id } });
    expect(sau.date.toISOString()).toBe(new Date(`${NGAY_KY}T00:00:00+07:00`).toISOString());
    expect(sau.refId).toBe(`LOAN:loan-test-x:${NGAY_KY}`);
  });

  it("đổi DANH MỤC sang 'other' → từ chối ở ô 'categoryId'; danh mục sau vẫn 'interest'", async () => {
    const dong = await seedDongLaiVay();

    const res = await updateExpense(dong.id, inputSua({ categoryId: "other" }));

    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("phải bị chặn");
    expect(res.field).toBe("categoryId");
    expect(res.code).toBe("KY_VAY_KHOA_DANH_MUC");

    const sau = await prisma.expense.findUniqueOrThrow({ where: { id: dong.id } });
    expect(sau.categoryId).toBe("interest");
  });

  it("sửa SỐ TIỀN + mô tả, giữ ngày/danh mục → lưu được (đường chữa số lãi sai PHẢI mở)", async () => {
    const dong = await seedDongLaiVay();

    const res = await updateExpense(dong.id, {
      ...inputSua({ amount: 1_200_000 }),
      description: "Lãi kỳ 10/07 theo giấy báo ngân hàng",
    });

    expect(res.ok).toBe(true);
    const sau = await prisma.expense.findUniqueOrThrow({ where: { id: dong.id } });
    expect(sau.amount).toBe(1_200_000);
    expect(sau.description).toContain("giấy báo ngân hàng");
  });

  it("dòng refId tiền tố KHÁC (PANCAKE_PURCHASE:…) đổi ngày + danh mục → vẫn lưu được", async () => {
    // Phiếu nhập tự lành: `doc-phieu-nhap-bronze.ts` suy "đã ghi" bằng chính sự tồn tại của dòng
    // mang refId đó, nên sửa/xoá là phiếu hiện lại ở màn đối chiếu để duyệt lại. Không được siết oan.
    const dong = await prisma.expense.create({
      data: {
        date: new Date(`${NGAY_KY}T00:00:00+07:00`),
        categoryId: "interest",
        description: "Nhập hàng phiếu 9",
        amount: 5_000_000,
        channelId: null,
        source: "MANUAL",
        refId: "PANCAKE_PURCHASE:a15aa15c",
      },
    });

    const res = await updateExpense(dong.id, inputSua({ date: "2026-07-11", categoryId: "other" }));

    expect(res.ok).toBe(true);
    const sau = await prisma.expense.findUniqueOrThrow({ where: { id: dong.id } });
    expect(sau.categoryId).toBe("other");
  });

  it("XOÁ dòng lãi vay VẪN ok và có đúng 1 ảnh trong thùng rác", async () => {
    // Lưới chống trôi phạm vi: câu lỗi của app chỉ "xoá dòng lãi ở Sổ chi phí" là lối thoát duy
    // nhất cho ca khai nhầm khoản vay. Ai nới cổng trên sang deleteExpense thì ca này đỏ.
    const dong = await seedDongLaiVay();

    const res = await deleteExpense(dong.id, "only");

    expect(res.ok).toBe(true);
    expect(await prisma.expense.count({ where: { id: dong.id } })).toBe(0);
    expect(await prisma.banGhiDaXoa.count({ where: { bang: "Expense" } })).toBe(1);
  });
});
