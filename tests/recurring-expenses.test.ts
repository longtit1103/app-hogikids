import { readFileSync } from "node:fs";
import path from "node:path";

import { addMonths, format, getDaysInMonth, setDate, startOfMonth, subMonths } from "date-fns";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  ensureRecurringExpenses,
  ensureRecurringExpensesForMonths,
  mauDinhKySinhChoThang,
  monthStartsInRange,
} from "@/lib/expenses/ensure-recurring-expenses";
import { khoaThangDinhKy } from "@/lib/expenses/khoa-thang-dinh-ky";
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

describe("lượt kiểm chỉ-đọc trước câu chèn", () => {
  // Render trang (cả lượt tải sẵn tab) gọi hàm này MỖI lần — gần như lần nào tháng cũng đã đủ dòng,
  // nên lượt đó chỉ được ĐỌC: không transaction, không câu INSERT nào.
  it("tháng đã đủ dòng ⇒ KHÔNG phát câu chèn nào, không mở transaction", async () => {
    await prisma.recurringExpense.create({
      data: { categoryId: "fixed", amount: 1_000_000, dayOfMonth: 5, description: "Điện" },
    });
    expect(await ensureRecurringExpenses(pastMonth)).toBe(1);
    const spyChen = vi.spyOn(prisma, "$executeRaw");
    const spyTx = vi.spyOn(prisma, "$transaction");
    try {
      expect(await ensureRecurringExpenses(pastMonth)).toBe(0);
      expect(spyChen).not.toHaveBeenCalled();
      expect(spyTx).not.toHaveBeenCalled();
    } finally {
      spyChen.mockRestore();
      spyTx.mockRestore();
    }
    expect(await prisma.expense.count()).toBe(1);
  });

  it("thiếu 1 trong 2 mẫu ⇒ chèn ĐÚNG dòng thiếu", async () => {
    const a = await prisma.recurringExpense.create({
      data: { categoryId: "fixed", amount: 1_000_000, dayOfMonth: 5, description: "Điện" },
    });
    await ensureRecurringExpenses(pastMonth);
    const b = await prisma.recurringExpense.create({
      data: { categoryId: "fixed", amount: 2_000_000, dayOfMonth: 7, description: "Nước" },
    });
    expect(await ensureRecurringExpenses(pastMonth)).toBe(1);
    const rows = await prisma.expense.findMany({ select: { recurringId: true } });
    expect(rows.map((r) => r.recurringId).sort()).toEqual([a.id, b.id].sort());
  });
});

describe("ràng buộc 1 dòng/mẫu/tháng dưới DB", () => {
  it("2 lượt ĐỒNG THỜI cùng thấy thiếu ⇒ đúng 1 dòng/mẫu, không ném, tổng created = số mẫu", async () => {
    const mau = await Promise.all(
      [5, 7, 9].map((dayOfMonth) =>
        prisma.recurringExpense.create({
          data: { categoryId: "fixed", amount: 1_000_000 * dayOfMonth, dayOfMonth, description: `Mẫu ${dayOfMonth}` },
        })
      )
    );
    // Rào: cả hai lượt phải qua lượt kiểm chỉ-đọc (cùng thấy thiếu 3 dòng) rồi mới được chèn — không
    // có rào thì lượt sau có thể tới khi lượt đầu đã chèn xong và thử nghiệm không đua thật.
    const goc = prisma.$executeRaw.bind(prisma);
    let soLuotToi = 0;
    let moRao!: () => void;
    const rao = new Promise<void>((r) => (moRao = r));
    const spy = vi.spyOn(prisma, "$executeRaw").mockImplementation((async (
      mau: TemplateStringsArray,
      ...giaTri: unknown[]
    ) => {
      soLuotToi++;
      if (soLuotToi === 2) moRao();
      await rao;
      return goc(mau, ...giaTri);
    }) as never);
    let ketQua: number[];
    try {
      ketQua = await Promise.all([ensureRecurringExpenses(pastMonth), ensureRecurringExpenses(pastMonth)]);
    } finally {
      spy.mockRestore();
    }
    expect(soLuotToi).toBe(2);
    expect(ketQua[0] + ketQua[1]).toBe(mau.length);
    const rows = await prisma.expense.findMany({ select: { recurringId: true, recurringMonth: true } });
    expect(rows).toHaveLength(mau.length);
    expect(rows.map((r) => r.recurringId).sort()).toEqual(mau.map((m) => m.id).sort());
    expect(new Set(rows.map((r) => r.recurringMonth))).toEqual(new Set([format(pastMonth, "yyyy-MM")]));
  });

  it("chèn thẳng trùng (recurringId, recurringMonth) ⇒ P2002 — ràng buộc nằm ở DB, không ở app", async () => {
    const r = await prisma.recurringExpense.create({
      data: { categoryId: "fixed", amount: 1_000_000, dayOfMonth: 5, description: "Điện" },
    });
    expect(await ensureRecurringExpenses(pastMonth)).toBe(1);
    const ngayKhac = setDate(pastMonth, 20); // khác ngày, CÙNG tháng
    await expect(
      prisma.expense.create({
        data: {
          date: ngayKhac,
          categoryId: "fixed",
          description: "Điện (trùng)",
          amount: 1_000_000,
          source: "RECURRING",
          recurringId: r.id,
          recurringMonth: khoaThangDinhKy(ngayKhac),
        },
      })
    ).rejects.toMatchObject({ code: "P2002" });
    expect(await prisma.expense.count()).toBe(1);
  });

  it("CHECK: dòng định kỳ thiếu khoá tháng, hoặc khoá lệch tháng của ngày ⇒ DB từ chối", async () => {
    const r = await prisma.recurringExpense.create({
      data: { categoryId: "fixed", amount: 1_000_000, dayOfMonth: 5, description: "Điện" },
    });
    const ngay = setDate(pastMonth, 5);
    const goc = {
      date: ngay,
      categoryId: "fixed",
      description: "Điện",
      amount: 1_000_000,
      source: "RECURRING" as const,
      recurringId: r.id,
    };
    await expect(prisma.expense.create({ data: goc })).rejects.toThrow(/Expense_recurringMonth_chi_cho_dinh_ky/);
    await expect(
      prisma.expense.create({ data: { ...goc, recurringMonth: format(subMonths(ngay, 1), "yyyy-MM") } })
    ).rejects.toThrow(/Expense_recurringMonth_khop_ngay/);
    // Dòng THƯỜNG mang khoá tháng cũng bị chặn (khoá chỉ dành cho dòng định kỳ).
    await expect(
      prisma.expense.create({
        data: { ...goc, source: "MANUAL", recurringId: null, recurringMonth: khoaThangDinhKy(ngay) },
      })
    ).rejects.toThrow(/Expense_recurringMonth_chi_cho_dinh_ky/);
    expect(await prisma.expense.count()).toBe(0);
  });
});

describe("mốc tháng của khoá định kỳ theo GIỜ VN", () => {
  // Cột `date` là timestamp không múi giờ chứa giờ UTC. 00:00 VN ngày 1 = 17:00 UTC ngày cuối tháng
  // TRƯỚC ⇒ tính khoá theo UTC là lệch sang tháng trước; 23:30 VN ngày cuối tháng bắt ca dịch QUÁ tay
  // (cộng +7 hai lần ⇒ nhảy sang tháng sau).
  const cuoiThang = new Date(2026, 7, 31, 23, 30); // 31/08/2026 23:30 giờ VN
  const dauThang = new Date(2026, 8, 1, 0, 0); // 01/09/2026 00:00 giờ VN

  it("khoaThangDinhKy: 23:30 VN ngày cuối tháng thuộc tháng đó; 00:00 VN ngày 1 thuộc tháng mới", () => {
    expect(khoaThangDinhKy(cuoiThang)).toBe("2026-08");
    expect(khoaThangDinhKy(dauThang)).toBe("2026-09");
  });

  it("DB đồng ý với app ở cả 2 biên — CHECK nhận khoá, câu backfill của migration ra ĐÚNG khoá đó", async () => {
    const r = await prisma.recurringExpense.create({
      data: { categoryId: "fixed", amount: 1_000_000, dayOfMonth: 1, description: "Điện" },
    });
    const r2 = await prisma.recurringExpense.create({
      data: { categoryId: "fixed", amount: 1_000_000, dayOfMonth: 31, description: "Nước" },
    });
    for (const [recurringId, date] of [
      [r2.id, cuoiThang],
      [r.id, dauThang],
    ] as const) {
      await prisma.expense.create({
        data: {
          date,
          categoryId: "fixed",
          description: "Biên tháng",
          amount: 1_000_000,
          source: "RECURRING",
          recurringId,
          recurringMonth: khoaThangDinhKy(date),
        },
      });
    }
    // Chạy lại NGUYÊN VĂN câu backfill trong file migration: sai chiều múi giờ thì hoặc CHECK (viết
    // đúng chiều) từ chối, hoặc khoá đổi khác khoá app ⇒ phép so dưới đỏ.
    await prisma.$executeRawUnsafe(cauBackfillTrongMigration());
    const rows = await prisma.expense.findMany({ select: { date: true, recurringMonth: true }, orderBy: { date: "asc" } });
    expect(rows.map((e) => e.recurringMonth)).toEqual(["2026-08", "2026-09"]);
  });

  it("bộ sinh: mẫu ngày 1 (00:00 VN = 17:00 UTC tháng trước) mang khoá đúng tháng VN", async () => {
    await prisma.recurringExpense.create({
      data: { categoryId: "fixed", amount: 1_000_000, dayOfMonth: 1, description: "Mặt bằng" },
    });
    expect(await ensureRecurringExpenses(pastMonth)).toBe(1);
    const e = await prisma.expense.findFirstOrThrow();
    expect(e.recurringMonth).toBe(format(pastMonth, "yyyy-MM"));
    expect(format(e.date, "yyyy-MM")).toBe(format(pastMonth, "yyyy-MM"));
  });
});

/** Câu `UPDATE … SET "recurringMonth" = …` nguyên văn trong migration thêm ràng buộc. */
function cauBackfillTrongMigration(): string {
  const file = path.resolve(
    process.cwd(),
    "prisma/migrations/20260928160000_mot_dong_dinh_ky_moi_thang_rang_buoc_duy_nhat/migration.sql"
  );
  const cau = readFileSync(file, "utf8").match(/UPDATE "Expense"[\s\S]*?;/);
  if (!cau) throw new Error("Không tìm thấy câu backfill trong migration");
  return cau[0];
}

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

describe("mốc activeFrom — mẫu chỉ sinh từ tháng của mốc trở đi", () => {
  // dayOfMonth=1 để mọi tháng ≤ tháng hiện tại đều đã tới hạn — chỉ cổng mốc quyết định có sinh hay không.
  const thisMonth = startOfMonth(new Date());
  const baThang = [subMonths(thisMonth, 2), subMonths(thisMonth, 1), thisMonth];

  it("mốc = tháng trước ⇒ KHÔNG sinh tháng trước mốc, sinh từ tháng mốc tới tháng hiện tại", async () => {
    await prisma.recurringExpense.create({
      data: {
        categoryId: "fixed",
        amount: 3_000_000,
        dayOfMonth: 1,
        description: "Có mốc",
        activeFrom: subMonths(thisMonth, 1),
      },
    });

    const created = await ensureRecurringExpensesForMonths(baThang);

    expect(created).toBe(2);
    const keys = (await prisma.expense.findMany()).map((e) => format(e.date, "yyyy-MM")).sort();
    expect(keys).toEqual([subMonths(thisMonth, 1), thisMonth].map((m) => format(m, "yyyy-MM")));
  });

  it("mốc GIỮA tháng (sau ngày đến hạn) ⇒ tháng của mốc VẪN sinh — so theo tháng, không theo ngày", async () => {
    await prisma.recurringExpense.create({
      data: {
        categoryId: "fixed",
        amount: 1_000_000,
        dayOfMonth: 1,
        description: "Mốc ngày 20",
        activeFrom: setDate(subMonths(thisMonth, 1), 20),
      },
    });

    expect(await ensureRecurringExpenses(subMonths(thisMonth, 1))).toBe(1);
    expect(await ensureRecurringExpenses(subMonths(thisMonth, 2))).toBe(0);
  });

  it("activeFrom NULL (mẫu có từ trước khi có cột) ⇒ giữ hành vi cũ: sinh cả tháng quá khứ", async () => {
    await prisma.recurringExpense.create({
      data: { categoryId: "fixed", amount: 3_000_000, dayOfMonth: 1, description: "Mẫu cũ", activeFrom: null },
    });

    expect(await ensureRecurringExpensesForMonths(baThang)).toBe(3);
  });
});

describe("mauDinhKySinhChoThang", () => {
  const thang9 = new Date(2026, 8, 1);

  it("NULL ⇒ mọi tháng", () => {
    expect(mauDinhKySinhChoThang(null, new Date(2020, 0, 1))).toBe(true);
  });

  it("tháng trước mốc ⇒ không; cùng tháng (kể cả mốc cuối tháng) và sau ⇒ có", () => {
    const mocCuoiThang9 = new Date(2026, 8, 30, 23, 59);
    expect(mauDinhKySinhChoThang(mocCuoiThang9, new Date(2026, 7, 31, 23, 59))).toBe(false);
    expect(mauDinhKySinhChoThang(mocCuoiThang9, thang9)).toBe(true);
    expect(mauDinhKySinhChoThang(thang9, new Date(2026, 8, 15))).toBe(true);
    expect(mauDinhKySinhChoThang(thang9, new Date(2026, 9, 1))).toBe(true);
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
