import { startOfMonth, subMonths } from "date-fns";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Hai đường ghi KHÔNG qua cửa ghi (chạy lúc render trang / trong route xuất file) kiểm `dangPhucHoi()`
 * một lần rồi mới ghi. Lượt phục hồi bật cờ ĐÚNG giữa câu kiểm đó và câu ghi ⇒ cổng cấp op chặn câu
 * ghi bằng `LoiCongGhiDangKhoa`. Hành vi đúng: bỏ lượt ghi như nhánh `dangPhucHoi()` — KHÔNG ném làm
 * trang lỗi 500 / làm hỏng lượt tải file.
 *
 * Giả lập khe "kiểm xong rồi cờ mới bật": `dangPhucHoi` (câu kiểm của đường ghi) trả false, còn cờ
 * cổng là cờ THẬT (`batCo`). KHÔNG mock cờ cổng: singleton `prisma` được dựng ở `tests/setup.ts` TRƯỚC
 * khi mock của file này có hiệu lực ⇒ cổng của nó luôn đọc `khoa-bao-tri` thật — mock cờ cổng chỉ đổi
 * bản sao module trong đồ thị của file test, cổng không thấy (test xanh/đỏ không phản ánh gì).
 */
vi.mock("@/lib/backup/khoa-bao-tri", async (goc) => {
  const thuc = await goc<typeof import("@/lib/backup/khoa-bao-tri")>();
  return { ...thuc, dangPhucHoi: () => false };
});

import { ensureRecurringExpenses } from "@/lib/expenses/ensure-recurring-expenses";
import { prisma } from "@/lib/prisma";
import { ghiNhatKyXuat } from "@/lib/reports/xuat-xlsx-server";
import { seedReference, truncateBusinessTables } from "../helpers/test-db";
import { batCo, datLaiCongGhi, traCoNeuCon } from "./cong-ghi-helpers";

const thangQuaKhu = subMonths(startOfMonth(new Date()), 2);

beforeAll(async () => {
  await seedReference();
}, 60_000);

beforeEach(async () => {
  await truncateBusinessTables();
});

afterEach(() => {
  datLaiCongGhi();
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("đường ghi ngoài cửa khi cờ phục hồi bật giữa chừng", () => {
  it("bộ sinh chi phí định kỳ: không sinh, không ném", async () => {
    await prisma.recurringExpense.create({
      data: { categoryId: "fixed", amount: 3_000_000, dayOfMonth: 15, description: "Tiền mặt bằng" },
    });
    batCo();

    await expect(ensureRecurringExpenses(thangQuaKhu)).resolves.toBe(0);
    expect(await prisma.expense.count()).toBe(0);

    // Cờ tắt ⇒ lần render sau sinh bù đúng 1 dòng.
    traCoNeuCon();
    await expect(ensureRecurringExpenses(thangQuaKhu)).resolves.toBe(1);
  });

  it("nhật ký xuất file: bỏ dòng, không ném", async () => {
    const truoc = await prisma.auditLog.count();
    batCo();

    await expect(
      ghiNhatKyXuat({ id: "u-test", email: "owner@test.local" } as Parameters<typeof ghiNhatKyXuat>[0], "Expense"),
    ).resolves.toBeUndefined();

    traCoNeuCon();
    expect(await prisma.auditLog.count()).toBe(truoc);
  });
});
