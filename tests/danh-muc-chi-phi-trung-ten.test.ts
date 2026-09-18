import { beforeEach, describe, expect, it, vi } from "vitest";
import { Prisma } from "@prisma/client";

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/session", () => ({ requireUser: vi.fn(async () => "test-user") }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    expenseCategory: { findMany: vi.fn(), create: vi.fn(), findUnique: vi.fn(), update: vi.fn() },
  },
}));

import { createExpenseCategory, toggleExpenseCategoryHidden } from "@/lib/actions/settings-expense-categories";
import { prisma } from "@/lib/prisma";

/**
 * Tên danh mục có ràng buộc duy nhất ở DB vì phép kiểm trong app là đọc-rồi-ghi: hai submit đồng
 * thời đều thấy "chưa có". Lượt thua phải nhận ĐÚNG thông báo trùng tên, không phải lỗi chung chung.
 */
describe("createExpenseCategory — trùng tên", () => {
  beforeEach(() => {
    vi.mocked(prisma.expenseCategory.findMany).mockReset().mockResolvedValue([] as never);
    vi.mocked(prisma.expenseCategory.create).mockReset().mockResolvedValue({} as never);
  });

  it("bảng đã có tên đó → chặn ở phép kiểm, KHÔNG gọi create", async () => {
    vi.mocked(prisma.expenseCategory.findMany).mockResolvedValue([
      { id: "x", name: "Thuê kho" },
    ] as never);

    const r = await createExpenseCategory("  thuê kho  "); // trim + không phân biệt hoa/thường
    expect(r).toEqual({ ok: false, error: "Tên danh mục đã tồn tại", field: "name" });
    expect(prisma.expenseCategory.create).not.toHaveBeenCalled();
  });

  it("lượt song song lọt phép kiểm → P2002 từ DB thành thông báo trùng tên", async () => {
    vi.mocked(prisma.expenseCategory.create).mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError("unique", {
        code: "P2002",
        clientVersion: "test",
      }),
    );

    const r = await createExpenseCategory("Thuê kho");
    expect(r).toEqual({ ok: false, error: "Tên danh mục đã tồn tại", field: "name" });
  });

  it("lỗi DB khác vẫn là lỗi chung (không nói sai nguyên nhân)", async () => {
    vi.mocked(prisma.expenseCategory.create).mockRejectedValue(new Error("mất kết nối"));

    const r = await createExpenseCategory("Thuê kho");
    expect(r).toMatchObject({ ok: false, error: "Lỗi khi thêm danh mục" });
  });
});

/**
 * Ẩn một danh mục mà chính app tự ghi vào là tự chặn đường ghi của mình mà không có gì báo:
 * `validateCategory` (`src/lib/actions/expenses.ts`) từ chối `categoryId` đã ẩn, còn link drill
 * `?danh_muc=...` của dòng P&L thì dẫn vào bộ lọc rỗng. UI đã disable công tắc, nhưng server là
 * chỗ chặn thật (không tin client) — nên chặn phải đo ở đây.
 */
describe("toggleExpenseCategoryHidden — danh mục app tự ghi vào thì KHÔNG ẩn được", () => {
  beforeEach(() => {
    vi.mocked(prisma.expenseCategory.update).mockReset().mockResolvedValue({} as never);
  });

  it.each([
    ["other", "Khác — chỗ hứng mọi khoản ghi tự động"],
    ["interest", "Lãi vay — màn Khoản vay ghi vào khi duyệt kỳ trả nợ"],
  ])("%s bị chặn, KHÔNG chạm DB (%s)", async (id) => {
    const r = await toggleExpenseCategoryHidden(id, true);
    expect(r).toEqual({ ok: false, error: "Danh mục nhận ghi tự động, không thể ẩn" });
    expect(prisma.expenseCategory.update).not.toHaveBeenCalled();
  });

  it("danh mục thường vẫn ẩn được (chặn hẹp đúng 2 id, không khoá nhầm cả bảng)", async () => {
    const r = await toggleExpenseCategoryHidden("fixed", true);
    expect(r).toEqual({ ok: true, data: undefined });
    expect(prisma.expenseCategory.update).toHaveBeenCalledWith({
      where: { id: "fixed" },
      data: { isHidden: true },
    });
  });
});
