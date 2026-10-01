import { addMonths, startOfMonth, subMonths } from "date-fns";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { deleteExpense } from "@/lib/actions/expenses";
import { ensureRecurringExpenses, ngayDenHanDinhKy } from "@/lib/expenses/ensure-recurring-expenses";
import { khoaThangDinhKy } from "@/lib/expenses/khoa-thang-dinh-ky";
import { prisma } from "@/lib/prisma";
import { seedReference, truncateBusinessTables } from "./helpers/test-db";

/**
 * Bộ sinh định kỳ đọc mẫu + kiểm dòng đã có bằng các câu autocommit RỜI (mỗi câu một snapshot), rồi mới
 * chèn. Lượt "Xoá và dừng lặp lại" / dừng / bật lại commit xen giữa thì danh sách "thiếu" đã cũ — câu chèn
 * phải tự xét lại điều kiện sinh trên dòng mẫu (khoá `FOR SHARE`), không được làm dòng vừa xoá sống lại.
 *
 * Tất định, không ngủ cố định: điểm chen là spy trên đúng câu đọc/câu chèn của bộ sinh; lượt chờ khoá
 * được xác nhận qua `pg_stat_activity` (`wait_event_type = 'Lock'`).
 */
// Ngữ cảnh người dùng giả (mặc định chủ shop) — action đi qua `congAction`, không có cookie trong vitest.
vi.mock("@/lib/quyen/nguoi-dung-phien", async (goc) => {
  const { nguoiDungGia } = await import("./helpers/nguoi-dung-gia");
  return {
    ...(await goc<typeof import("@/lib/quyen/nguoi-dung-phien")>()),
    docNguoiDungPhien: vi.fn(async () => nguoiDungGia()),
  };
});
vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

// Tháng quá khứ chắc chắn ⇒ mọi ngày đến hạn ≤ hôm nay.
const pastMonth = subMonths(startOfMonth(new Date()), 2);
const NGAY = 5;

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

function hen() {
  let xong!: () => void;
  const p = new Promise<void>((r) => (xong = r));
  return { p, xong };
}

async function taoMau() {
  return prisma.recurringExpense.create({
    data: { categoryId: "fixed", amount: 3_000_000, dayOfMonth: NGAY, description: "Mặt bằng" },
  });
}

/** Dòng định kỳ của `pastMonth` — y như bộ sinh ghi. */
async function taoDongThang(mau: { id: string; amount: number; description: string }) {
  const date = ngayDenHanDinhKy(NGAY, pastMonth);
  return prisma.expense.create({
    data: {
      date,
      categoryId: "fixed",
      description: mau.description,
      amount: mau.amount,
      source: "RECURRING",
      recurringId: mau.id,
      recurringMonth: khoaThangDinhKy(date),
    },
  });
}

/** Chờ tới khi một kết nối khác đang ĐỨNG CHỜ khoá ở câu chèn `Expense` của bộ sinh. */
async function choCauChenDungChoKhoa(): Promise<void> {
  const hetHan = performance.now() + 10_000;
  for (;;) {
    const [dong] = await prisma.$queryRaw<{ n: number }[]>`
      SELECT count(*)::int AS n FROM pg_stat_activity
      WHERE datname = current_database() AND pid <> pg_backend_pid()
        AND wait_event_type = 'Lock' AND query LIKE '%INSERT INTO "Expense"%'`;
    if (dong.n > 0) return;
    if (performance.now() > hetHan) throw new Error("Hết 10s mà câu chèn định kỳ không đứng chờ khoá nào");
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe("bộ sinh định kỳ gặp lượt dừng lặp lại chen giữa", () => {
  it("'Xoá và dừng' commit SAU lượt đọc mẫu, TRƯỚC lượt kiểm dòng ⇒ dòng vừa xoá KHÔNG sống lại", async () => {
    const mau = await taoMau();
    const e = await taoDongThang(mau);

    // Chen đúng khe: bộ sinh đã đọc mẫu `active=true`, sắp kiểm dòng đã có của tháng.
    const goc = prisma.expense.findMany.bind(prisma.expense);
    const spy = vi.spyOn(prisma.expense, "findMany").mockImplementationOnce((async (
      args: Parameters<typeof goc>[0]
    ) => {
      expect(await deleteExpense(e.id, "stop_recurring")).toEqual({ ok: true, data: undefined });
      return goc(args);
    }) as never);
    let taoMoi: number;
    try {
      taoMoi = await ensureRecurringExpenses(pastMonth);
    } finally {
      spy.mockRestore();
    }

    expect(taoMoi).toBe(0);
    expect(await prisma.expense.count({ where: { recurringId: mau.id } })).toBe(0);
    expect((await prisma.recurringExpense.findUniqueOrThrow({ where: { id: mau.id } })).active).toBe(false);
  });

  it("lượt dừng ĐANG GIỮ khoá mẫu lúc câu chèn chạy ⇒ câu chèn chờ, khoá nhả thì thấy mẫu đã dừng và không chèn", async () => {
    const mau = await taoMau();

    // Tình huống: bộ sinh A thấy tháng trống; ngay sau đó lượt sinh B chèn dòng E, chủ shop bấm "Xoá và
    // dừng" dòng E — transaction xoá đang mở (khoá mẫu, xoá E, tắt `active`) đúng lúc câu chèn của A chạy.
    const goc = prisma.$executeRaw.bind(prisma);
    const daGiu = hen();
    const choTha = hen();
    let luotXoa: Promise<unknown> | undefined;
    const spy = vi.spyOn(prisma, "$executeRaw").mockImplementationOnce((async (
      sql: TemplateStringsArray,
      ...giaTri: unknown[]
    ) => {
      const e = await taoDongThang(mau);
      luotXoa = prisma.$transaction(
        async (tx) => {
          await tx.$queryRaw`SELECT id FROM "RecurringExpense" WHERE id = ${mau.id} FOR UPDATE`;
          await tx.expense.delete({ where: { id: e.id } });
          await tx.recurringExpense.update({ where: { id: mau.id }, data: { active: false } });
          daGiu.xong();
          await choTha.p;
        },
        { timeout: 20_000 }
      );
      await daGiu.p;
      // PrismaPromise lười — chỉ gửi câu khi được `then`; bọc async để câu chèn chạy NGAY.
      const chen = (async () => goc(sql, ...giaTri))();
      try {
        await choCauChenDungChoKhoa();
      } finally {
        choTha.xong();
      }
      await luotXoa;
      return chen;
    }) as never);
    let taoMoi: number;
    try {
      taoMoi = await ensureRecurringExpenses(pastMonth);
    } finally {
      spy.mockRestore();
      choTha.xong();
      await luotXoa;
    }

    expect(taoMoi).toBe(0);
    expect(await prisma.expense.count({ where: { recurringId: mau.id } })).toBe(0);
    expect((await prisma.recurringExpense.findUniqueOrThrow({ where: { id: mau.id } })).active).toBe(false);
  });

  it("lượt ghi chỉ UPDATE `active=false` (KHÔNG FOR UPDATE) đang mở ⇒ câu chèn vẫn phải chờ và không chèn", async () => {
    // Phân biệt mức khoá của câu chèn: UPDATE trơn giữ `FOR NO KEY UPDATE` — xung đột với `FOR SHARE`
    // nhưng KHÔNG xung đột với `FOR KEY SHARE`. Hạ khoá xuống KEY SHARE thì câu chèn không chờ, đọc
    // bản `active=true` cũ và làm dòng vừa xoá sống lại — test này đỏ (bộ 3 test kia dùng FOR UPDATE
    // nên chặn MỌI mức khoá, không phân biệt được).
    const mau = await taoMau();
    const goc = prisma.$executeRaw.bind(prisma);
    const daGiu = hen();
    const choTha = hen();
    let luotGhi: Promise<unknown> | undefined;
    const spy = vi.spyOn(prisma, "$executeRaw").mockImplementationOnce((async (
      sql: TemplateStringsArray,
      ...giaTri: unknown[]
    ) => {
      const e = await taoDongThang(mau);
      luotGhi = prisma.$transaction(
        async (tx) => {
          await tx.expense.delete({ where: { id: e.id } });
          await tx.recurringExpense.update({ where: { id: mau.id }, data: { active: false } });
          daGiu.xong();
          await choTha.p;
        },
        { timeout: 20_000 }
      );
      await daGiu.p;
      const chen = (async () => goc(sql, ...giaTri))();
      try {
        await choCauChenDungChoKhoa();
      } finally {
        choTha.xong();
      }
      await luotGhi;
      return chen;
    }) as never);
    let taoMoi: number;
    try {
      taoMoi = await ensureRecurringExpenses(pastMonth);
    } finally {
      spy.mockRestore();
      choTha.xong();
      await luotGhi;
    }

    expect(taoMoi).toBe(0);
    expect(await prisma.expense.count({ where: { recurringId: mau.id } })).toBe(0);
  });

  it("mẫu bị dừng rồi bật lại với mốc SAU tháng đang sinh, xen trước câu chèn ⇒ không ghi lùi tháng đó", async () => {
    const mau = await taoMau();

    const goc = prisma.$executeRaw.bind(prisma);
    const spy = vi.spyOn(prisma, "$executeRaw").mockImplementationOnce((async (
      sql: TemplateStringsArray,
      ...giaTri: unknown[]
    ) => {
      await prisma.recurringExpense.update({ where: { id: mau.id }, data: { active: false } });
      await prisma.recurringExpense.update({
        where: { id: mau.id },
        data: { active: true, activeFrom: startOfMonth(addMonths(pastMonth, 1)) },
      });
      return goc(sql, ...giaTri);
    }) as never);
    let taoMoi: number;
    try {
      taoMoi = await ensureRecurringExpenses(pastMonth);
    } finally {
      spy.mockRestore();
    }

    expect(taoMoi).toBe(0);
    expect(await prisma.expense.count({ where: { recurringId: mau.id } })).toBe(0);
    // Tháng của mốc vẫn sinh bình thường — cổng mốc trong câu chèn trùng luật `mauDinhKySinhChoThang`.
    expect(await ensureRecurringExpenses(addMonths(pastMonth, 1))).toBe(1);
  });
});
