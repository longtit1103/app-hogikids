import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { Prisma } from "@prisma/client";

import { deleteExpense } from "@/lib/actions/expenses";
import { khoiPhucBanGhi } from "@/lib/actions/thung-rac";
import { ensureRecurringExpenses } from "@/lib/expenses/ensure-recurring-expenses";
import { prisma } from "@/lib/prisma";
import type { AnhBanGhi } from "@/lib/thung-rac/chup-anh-ban-ghi";
import { CAU_THANG_DA_CO_DINH_KY } from "@/lib/thung-rac/ly-do-khong-khoi-phuc";
import { seedReference, truncateBusinessTables } from "./helpers/test-db";

/**
 * Khôi phục thùng rác một dòng chi phí ĐỊNH KỲ vs UNIQUE `(recurringId, recurringMonth)` (`hogikids_test`).
 *
 * Phép dò "tháng đó đã có dòng thay thế" chạy TRƯỚC câu ghi (ReadCommitted) — bộ sinh định kỳ của một
 * lượt render song song vẫn chen được dòng thay thế vào giữa. Không mô phỏng được khe đó bằng hai
 * request thật một cách xác định, nên suite này ÉP phép dò trả "chưa có" (đúng cái nó thấy trong khe
 * đua) rồi để UNIQUE dưới DB làm cổng cuối: phải ra câu tiếng Việt, không trùng dòng, không 500.
 */
const epDoTruocBoQua = vi.hoisted(() => ({ bat: false }));

// Ngữ cảnh người dùng giả (mặc định chủ shop) — action đi qua `congAction`, không có cookie trong vitest.
vi.mock("@/lib/quyen/nguoi-dung-phien", async (goc) => {
  const { nguoiDungGia } = await import("./helpers/nguoi-dung-gia");
  return {
    ...(await goc<typeof import("@/lib/quyen/nguoi-dung-phien")>()),
    docNguoiDungPhien: vi.fn(async () => nguoiDungGia()),
  };
});
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/thung-rac/do-tinh-trang-khoi-phuc", async (importOriginal) => {
  const goc = await importOriginal<typeof import("@/lib/thung-rac/do-tinh-trang-khoi-phuc")>();
  return {
    ...goc,
    doTinhTrang: async (...args: Parameters<typeof goc.doTinhTrang>) => {
      const t = await goc.doTinhTrang(...args);
      return epDoTruocBoQua.bat ? { ...t, thangDaCoDinhKy: false } : t;
    },
  };
});

const THANG_7 = new Date(2026, 6, 1);

beforeAll(async () => {
  await seedReference();
}, 60_000);

beforeEach(async () => {
  epDoTruocBoQua.bat = false;
  await truncateBusinessTables();
});

afterAll(async () => {
  await truncateBusinessTables();
  await prisma.$disconnect();
});

/** Mẫu đang chạy + dòng tháng 7 do bộ sinh ghi, rồi "Xoá dòng này" (mẫu VẪN active) vào thùng rác. */
async function xoaDongThang7() {
  const mau = await prisma.recurringExpense.create({
    data: { categoryId: "fixed", amount: 10_000_000, dayOfMonth: 5, description: "Thuê nhà" },
  });
  expect(await ensureRecurringExpenses(THANG_7)).toBe(1);
  const dong = await prisma.expense.findFirstOrThrow({ where: { recurringId: mau.id } });
  expect((await deleteExpense(dong.id, "only")).ok).toBe(true);
  const muc = await prisma.banGhiDaXoa.findFirstOrThrow();
  return { mau, dong, muc };
}

describe("khôi phục dòng định kỳ khi tháng đó đã có dòng thay thế", () => {
  it("phép dò trước lọt (khe đua) ⇒ UNIQUE chặn: câu rõ, KHÔNG trùng, con dấu khôi phục tan theo", async () => {
    const { mau, muc } = await xoaDongThang7();
    // Lượt render kế sinh lại dòng thay thế (id mới) cho tháng 7.
    expect(await ensureRecurringExpenses(THANG_7)).toBe(1);

    epDoTruocBoQua.bat = true;
    const res = await khoiPhucBanGhi(muc.id);

    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe(CAU_THANG_DA_CO_DINH_KY);
    expect(await prisma.expense.count({ where: { recurringId: mau.id } })).toBe(1);
    // Rollback trọn — mục vẫn khôi phục được sau khi chủ shop xoá dòng thay thế.
    expect((await prisma.banGhiDaXoa.findUniqueOrThrow({ where: { id: muc.id } })).khoiPhucLuc).toBeNull();
  });

  it("tháng chưa có dòng thay thế ⇒ khôi phục được, dòng mang lại đúng khoá tháng", async () => {
    const { dong, muc } = await xoaDongThang7();

    const res = await khoiPhucBanGhi(muc.id);

    expect(res.ok).toBe(true);
    const lai = await prisma.expense.findUniqueOrThrow({ where: { id: dong.id } });
    expect(lai.recurringMonth).toBe("2026-07");
    // Bộ sinh không chèn thêm: tháng 7 đã có đúng 1 dòng của mẫu.
    expect(await ensureRecurringExpenses(THANG_7)).toBe(0);
  });

  it("ảnh chụp CŨ (trước khi có cột khoá tháng) vẫn khôi phục được — khoá tính lại từ ngày", async () => {
    const { dong, muc } = await xoaDongThang7();
    const anh = muc.anh as unknown as AnhBanGhi;
    const { recurringMonth: _boDi, ...chinhCu } = anh.chinh;
    expect(_boDi).toBe("2026-07");
    await prisma.banGhiDaXoa.update({
      where: { id: muc.id },
      data: { anh: { ...anh, chinh: chinhCu } as unknown as Prisma.InputJsonValue },
    });

    const res = await khoiPhucBanGhi(muc.id);

    expect(res.ok).toBe(true);
    expect((await prisma.expense.findUniqueOrThrow({ where: { id: dong.id } })).recurringMonth).toBe("2026-07");
  });
});
