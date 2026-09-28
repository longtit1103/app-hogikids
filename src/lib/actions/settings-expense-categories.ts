"use server";

import { randomUUID } from "node:crypto";

import { Prisma } from "@prisma/client";
import { revalidatePath } from "next/cache";
import { z } from "zod";

import type { ActionResult } from "@/lib/actions/action-result";
import { dangPhucHoi, LOI_DANG_PHUC_HOI } from "@/lib/backup/khoa-bao-tri";
import { laDanhMucKhoaAn, LOI_DANH_MUC_KHOA_AN } from "@/lib/expenses/danh-muc-khoa-an";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";

// ---- Cài đặt › Danh mục chi phí (CRUD) --------------------------------------

const expenseCategoryNameSchema = z
  .string()
  .trim()
  .min(1, "Tên danh mục không được để trống")
  .max(30, "Tên danh mục tối đa 30 ký tự");

/**
 * Trùng tên case-insensitive so với TOÀN BỘ danh mục (hệ thống + tùy chỉnh) —
 * tên hệ thống ("Nhập hàng", "Khác"…) cũng bị chặn trùng, không chỉ tùy chỉnh.
 * `excludeId` dùng khi đổi tên (bỏ qua chính nó).
 */
async function hasDuplicateCategoryName(name: string, excludeId?: string): Promise<boolean> {
  const categories = await prisma.expenseCategory.findMany({ select: { id: true, name: true } });
  const lower = name.toLowerCase();
  return categories.some((c) => c.id !== excludeId && c.name.toLowerCase() === lower);
}

/** Thêm danh mục tùy chỉnh — id tự sinh (schema KHÔNG có @default cho id). */
export async function createExpenseCategory(name: string): Promise<ActionResult<{ id: string }>> {
  await requireUser();
  if (dangPhucHoi()) return { ok: false, error: LOI_DANG_PHUC_HOI };

  const parsed = expenseCategoryNameSchema.safeParse(name);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0].message, field: "name" };
  }
  if (await hasDuplicateCategoryName(parsed.data)) {
    return { ok: false, error: "Tên danh mục đã tồn tại", field: "name" };
  }

  const id = randomUUID();
  try {
    await prisma.expenseCategory.create({
      data: { id, name: parsed.data, isSystem: false, isHidden: false },
    });
  } catch (e) {
    // Ràng buộc duy nhất trên tên là cổng CUỐI: phép kiểm phía trên đọc rồi mới ghi, nên hai submit
    // đồng thời đều lọt qua nó và lượt thua rơi vào đây. Trả đúng thông báo mà lượt kiểm đã trả,
    // đừng để nó hiện ra thành "Lỗi khi thêm danh mục" (chủ shop bấm lại mãi không hiểu vì sao).
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      return { ok: false, error: "Tên danh mục đã tồn tại", field: "name" };
    }
    return { ok: false, error: "Lỗi khi thêm danh mục" };
  }

  revalidatePath("/tai-chinh");
  revalidatePath("/cai-dat");
  return { ok: true, data: { id } };
}

/** Đổi tên danh mục tùy chỉnh — danh mục hệ thống khóa tên (không sửa được). */
export async function renameExpenseCategory(id: string, name: string): Promise<ActionResult> {
  await requireUser();
  if (dangPhucHoi()) return { ok: false, error: LOI_DANG_PHUC_HOI };

  const parsed = expenseCategoryNameSchema.safeParse(name);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0].message, field: "name" };
  }

  const category = await prisma.expenseCategory.findUnique({ where: { id } });
  if (!category) {
    return { ok: false, error: "Danh mục không tồn tại" };
  }
  if (category.isSystem) {
    return { ok: false, error: "Không thể đổi tên danh mục hệ thống" };
  }
  if (await hasDuplicateCategoryName(parsed.data, id)) {
    return { ok: false, error: "Tên danh mục đã tồn tại", field: "name" };
  }

  try {
    await prisma.expenseCategory.update({ where: { id }, data: { name: parsed.data } });
  } catch (e) {
    // Đổi tên đụng đúng ràng buộc duy nhất đó — cùng lý do như lúc thêm mới.
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      return { ok: false, error: "Tên danh mục đã tồn tại", field: "name" };
    }
    return { ok: false, error: "Lỗi khi đổi tên danh mục" };
  }

  revalidatePath("/tai-chinh");
  revalidatePath("/cai-dat");
  return { ok: true, data: undefined };
}

/**
 * Bật/tắt hiện-ẩn 1 danh mục trong dropdown "Thêm chi phí". Danh mục app tự ghi vào
 * (`other` hứng ghi tự động, `interest` nhận lãi vay khi duyệt kỳ trả nợ) KHÔNG được ẩn —
 * chặn cứng ở server dù UI đã disable toggle (không tin client). Danh sách dùng CHUNG với UI
 * ở `@/lib/expenses/danh-muc-khoa-an`.
 */
export async function toggleExpenseCategoryHidden(id: string, isHidden: boolean): Promise<ActionResult> {
  await requireUser();
  if (dangPhucHoi()) return { ok: false, error: LOI_DANG_PHUC_HOI };

  if (laDanhMucKhoaAn(id)) {
    return { ok: false, error: LOI_DANH_MUC_KHOA_AN };
  }

  try {
    await prisma.expenseCategory.update({ where: { id }, data: { isHidden } });
  } catch {
    return { ok: false, error: "Lỗi khi cập nhật danh mục" };
  }

  revalidatePath("/tai-chinh");
  revalidatePath("/cai-dat");
  return { ok: true, data: undefined };
}

/**
 * Xóa danh mục tùy chỉnh — chặn danh mục hệ thống, và chặn nếu còn bị tham
 * chiếu. `RecurringExpense.categoryId` KHÔNG có FK trong schema (app-owned,
 * không sửa được) nên phải tự đếm ở đây: nếu xóa category còn đang được 1 quy
 * tắc định kỳ dùng, lần chạy `ensureRecurringExpenses()` kế tiếp (mỗi lần vào
 * `/chi-phi`, `/`, `/bao-cao`) sẽ tạo `Expense` với `categoryId` treo → vỡ FK
 * `Expense.categoryId`. Ưu tiên báo lỗi theo `Expense` thật trước (số hiển thị
 * cho user quan trọng hơn), rồi mới tới quy tắc định kỳ.
 */
export async function deleteExpenseCategory(id: string): Promise<ActionResult> {
  await requireUser();
  if (dangPhucHoi()) return { ok: false, error: LOI_DANG_PHUC_HOI };

  const category = await prisma.expenseCategory.findUnique({ where: { id } });
  if (!category) {
    return { ok: false, error: "Danh mục không tồn tại" };
  }
  if (category.isSystem) {
    return { ok: false, error: "Không thể xóa danh mục hệ thống" };
  }

  const [expenseCount, recurringCount] = await Promise.all([
    prisma.expense.count({ where: { categoryId: id } }),
    prisma.recurringExpense.count({ where: { categoryId: id } }),
  ]);

  if (expenseCount > 0) {
    return { ok: false, code: "HAS_EXPENSES", error: `Danh mục có ${expenseCount} khoản chi, không thể xóa` };
  }
  if (recurringCount > 0) {
    return {
      ok: false,
      code: "HAS_EXPENSES",
      error: `Danh mục đang được dùng bởi ${recurringCount} khoản định kỳ, không thể xóa`,
    };
  }

  try {
    await prisma.expenseCategory.delete({ where: { id } });
  } catch {
    return { ok: false, error: "Lỗi khi xóa danh mục" };
  }

  revalidatePath("/tai-chinh");
  revalidatePath("/cai-dat");
  return { ok: true, data: undefined };
}
