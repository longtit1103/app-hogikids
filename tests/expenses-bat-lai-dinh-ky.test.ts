import { addMonths, format, startOfMonth, subMonths } from "date-fns";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { batLaiDinhKy, createExpense, deleteExpense, stopRecurring, updateExpense } from "@/lib/actions/expenses";
import { ensureRecurringExpenses, ensureRecurringExpensesForMonths } from "@/lib/expenses/ensure-recurring-expenses";
import { formatVnd } from "@/lib/format";
import { prisma } from "@/lib/prisma";
import { seedReference, truncateBusinessTables } from "./helpers/test-db";

/**
 * Bật lại khoản chi định kỳ đã dừng + mốc `activeFrom` của mẫu tạo mới (`hogikids_test`).
 *
 * Vì sao cần mốc: bộ sinh `ensureRecurringExpenses` là LAZY — sinh cho MỌI tháng được render mà mẫu
 * còn `active`. Không có cận dưới thì bật lại mẫu đã dừng là ghi LÙI chi phí vào đúng các tháng đã
 * dừng (Lãi/Lỗ tháng cũ tụt mà không ai hay). Suite chốt bằng số dòng/tiền THẬT sau khi chạy bộ sinh.
 */
vi.mock("@/lib/session", () => ({
  requireUser: vi.fn(async () => "test-user-id"),
}));
// revalidatePath cần request scope (không có trong vitest) — no-op cho unit test.
vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

const thangNay = startOfMonth(new Date());
// Bốn tháng liền nhau kết thúc ở tháng hiện tại — dayOfMonth=1 nên tháng nào cũng đã tới hạn.
const bonThang = [3, 2, 1, 0].map((n) => subMonths(thangNay, n));
const TIEN = 2_000_000;

/** Mẫu đã DỪNG, dựng trước khi có cột mốc (activeFrom NULL), từng sinh dòng ở tháng T-3. */
async function seedMauDaDung() {
  const mau = await prisma.recurringExpense.create({
    data: { categoryId: "fixed", amount: TIEN, dayOfMonth: 1, description: "Mặt bằng", active: false },
  });
  await prisma.expense.create({
    data: {
      date: bonThang[0],
      categoryId: "fixed",
      description: "Mặt bằng",
      amount: TIEN,
      source: "RECURRING",
      recurringId: mau.id,
    },
  });
  return mau;
}

const thangCuaDong = async (recurringId: string) =>
  (await prisma.expense.findMany({ where: { recurringId }, orderBy: { date: "asc" } })).map((e) =>
    format(e.date, "yyyy-MM")
  );

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

describe("batLaiDinhKy", () => {
  it("mẫu đã dừng ⇒ bật, mốc = đầu tháng hiện tại, trả nhãn tháng MM/yyyy", async () => {
    const mau = await seedMauDaDung();

    const res = await batLaiDinhKy(mau.id);

    expect(res).toEqual({ ok: true, data: { tuThang: format(thangNay, "MM/yyyy") } });
    const sau = await prisma.recurringExpense.findUniqueOrThrow({ where: { id: mau.id } });
    expect(sau.active).toBe(true);
    expect(sau.activeFrom?.getTime()).toBe(thangNay.getTime());
  });

  it("CHỐT TIỀN: bật lại rồi render cả các tháng đã dừng ⇒ CHỈ sinh tháng hiện tại, không ghi bù", async () => {
    const mau = await seedMauDaDung();
    await batLaiDinhKy(mau.id);

    const daSinh = await ensureRecurringExpensesForMonths(bonThang);

    expect(daSinh).toBe(1);
    expect(await thangCuaDong(mau.id)).toEqual([format(bonThang[0], "yyyy-MM"), format(thangNay, "yyyy-MM")]);
    const tong = await prisma.expense.aggregate({ where: { recurringId: mau.id }, _sum: { amount: true } });
    expect(tong._sum.amount).toBe(2 * TIEN);
  });

  it("dừng lại lần nữa rồi bật lại ⇒ mốc dời về tháng hiện tại, vẫn không ghi bù", async () => {
    const mau = await prisma.recurringExpense.create({
      data: {
        categoryId: "fixed",
        amount: TIEN,
        dayOfMonth: 1,
        description: "Có mốc cũ",
        active: true,
        activeFrom: bonThang[0],
      },
    });
    expect((await stopRecurring(mau.id)).ok).toBe(true);
    expect((await batLaiDinhKy(mau.id)).ok).toBe(true);

    expect(await ensureRecurringExpensesForMonths(bonThang)).toBe(1);
    expect(await thangCuaDong(mau.id)).toEqual([format(thangNay, "yyyy-MM")]);
  });

  it("mẫu ĐANG CHẠY ⇒ từ chối rõ ràng, KHÔNG đụng mốc (idempotent)", async () => {
    const mau = await prisma.recurringExpense.create({
      data: { categoryId: "fixed", amount: TIEN, dayOfMonth: 1, description: "Đang chạy", activeFrom: null },
    });

    const res = await batLaiDinhKy(mau.id);

    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("phải bị từ chối");
    expect(res.code).toBe("DINH_KY_DANG_CHAY");
    const sau = await prisma.recurringExpense.findUniqueOrThrow({ where: { id: mau.id } });
    expect(sau.activeFrom).toBeNull(); // mốc KHÔNG bị kéo lên — mẫu cũ vẫn sinh đủ tháng quá khứ
  });

  it("bấm hai lần liền ⇒ lượt thứ hai bị từ chối, mốc giữ nguyên", async () => {
    const mau = await seedMauDaDung();

    const [a, b] = await Promise.all([batLaiDinhKy(mau.id), batLaiDinhKy(mau.id)]);

    expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1);
    const sau = await prisma.recurringExpense.findUniqueOrThrow({ where: { id: mau.id } });
    expect(sau.active).toBe(true);
    expect(sau.activeFrom?.getTime()).toBe(thangNay.getTime());
  });

  it("id không tồn tại ⇒ từ chối, không tạo gì", async () => {
    const res = await batLaiDinhKy("khong-co-id-nay");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe("KHONG_TIM_THAY");
    expect(await prisma.recurringExpense.count()).toBe(0);
  });

  it.each([[""], [null], [42]])("id sai kiểu/rỗng (%s) ⇒ từ chối tại biên", async (id) => {
    const res = await batLaiDinhKy(id as unknown as string);
    expect(res.ok).toBe(false);
  });
});

describe("createExpense lặp hàng tháng — mẫu mới mang mốc", () => {
  const input = (date: string) => ({
    date,
    categoryId: "fixed",
    amount: TIEN,
    channelId: null,
    description: "Mặt bằng mới",
    recurringMonthly: true,
  });

  it("ngày hôm nay ⇒ activeFrom = đầu tháng hiện tại; tháng trước KHÔNG bị sinh lùi", async () => {
    const res = await createExpense(input(format(new Date(), "yyyy-MM-dd")));
    expect(res.ok).toBe(true);

    const mau = await prisma.recurringExpense.findFirstOrThrow();
    expect(mau.activeFrom?.getTime()).toBe(thangNay.getTime());
    expect(await ensureRecurringExpenses(subMonths(thangNay, 1))).toBe(0);
    expect(await thangCuaDong(mau.id)).toEqual([format(thangNay, "yyyy-MM")]);
  });

  it("ngày ở tháng CŨ (ghi lùi khoản đã bắt đầu từ trước) ⇒ mốc = tháng của dòng đầu tiên", async () => {
    // Mốc theo tháng của chính dòng đầu mẫu vừa ghi: tháng trước đó không sinh lùi, còn các tháng từ đó
    // tới nay là khoản chi THẬT chủ shop khai "lặp hàng tháng" — vẫn được sinh như thường.
    const res = await createExpense(input(`${format(bonThang[1], "yyyy-MM")}-10`));
    expect(res.ok).toBe(true);

    const mau = await prisma.recurringExpense.findFirstOrThrow();
    expect(mau.activeFrom?.getTime()).toBe(bonThang[1].getTime());
    expect(await ensureRecurringExpensesForMonths(bonThang)).toBe(2); // T-1 và tháng hiện tại
    expect(await thangCuaDong(mau.id)).toEqual(bonThang.slice(1).map((m) => format(m, "yyyy-MM")));
  });
});

describe("updateExpense — dời dòng của tháng TRƯỚC mốc", () => {
  it("mẫu đã bật lại, dòng cũ nằm trước mốc ⇒ dời được (tháng trống không bị sinh bù)", async () => {
    const mau = await seedMauDaDung();
    await batLaiDinhKy(mau.id);
    const dong = await prisma.expense.findFirstOrThrow({ where: { recurringId: mau.id } });

    const res = await updateExpense(dong.id, {
      date: `${format(bonThang[1], "yyyy-MM")}-01`,
      categoryId: "fixed",
      amount: TIEN,
      channelId: null,
      description: "Mặt bằng",
    });

    expect(res.ok).toBe(true);
    expect(await ensureRecurringExpenses(bonThang[0])).toBe(0);
  });

  it("dòng nằm TỪ mốc trở đi ⇒ vẫn chặn dời tháng (tháng trống sẽ bị sinh bù)", async () => {
    const mau = await prisma.recurringExpense.create({
      data: { categoryId: "fixed", amount: TIEN, dayOfMonth: 1, description: "Mặt bằng", activeFrom: bonThang[1] },
    });
    await ensureRecurringExpenses(bonThang[1]);
    const dong = await prisma.expense.findFirstOrThrow({ where: { recurringId: mau.id } });

    const res = await updateExpense(dong.id, {
      date: `${format(bonThang[2], "yyyy-MM")}-01`,
      categoryId: "fixed",
      amount: TIEN,
      channelId: null,
      description: "Mặt bằng",
    });

    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.field).toBe("date");
  });
});

describe("updateExpense — dời dòng VÀO tháng mà mẫu còn sinh", () => {
  // Mẫu đã bật lại (mốc = tháng này), dòng cũ nằm trước mốc. Tháng nguồn không còn bị sinh bù, nhưng
  // tháng ĐÍCH là tháng bộ sinh còn sinh: dòng dời mang `recurringId` chiếm đúng khoá chống trùng
  // "1 dòng/mẫu/tháng" của bộ sinh.
  const suaSangThangNay = (id: string) =>
    updateExpense(id, {
      date: format(thangNay, "yyyy-MM-dd"),
      categoryId: "fixed",
      amount: TIEN,
      channelId: null,
      description: "Mặt bằng",
    });

  it("tháng đích ĐÃ sinh dòng ⇒ chặn, tháng đích giữ đúng 1 dòng, dòng cũ không nhúc nhích", async () => {
    const mau = await seedMauDaDung();
    expect((await batLaiDinhKy(mau.id)).ok).toBe(true);
    expect(await ensureRecurringExpenses(thangNay)).toBe(1);
    const cu = await prisma.expense.findFirstOrThrow({ where: { recurringId: mau.id }, orderBy: { date: "asc" } });

    const res = await suaSangThangNay(cu.id);

    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.field).toBe("date");
    expect(await thangCuaDong(mau.id)).toEqual([format(bonThang[0], "yyyy-MM"), format(thangNay, "yyyy-MM")]);
  });

  it("tháng đích CHƯA sinh ⇒ vẫn chặn — dời vào là lấp mất khoản của chính tháng đó", async () => {
    // dayOfMonth=31 ⇒ kẹp về cuối tháng: thường chưa tới hạn; tới hạn rồi thì bộ sinh cũng chưa chạy.
    // Cả hai đều là "tháng đích bộ sinh còn sinh" — cổng phải chặn như nhau.
    const mau = await prisma.recurringExpense.create({
      data: { categoryId: "fixed", amount: TIEN, dayOfMonth: 31, description: "Mặt bằng", active: false },
    });
    const cu = await prisma.expense.create({
      data: {
        date: bonThang[1],
        categoryId: "fixed",
        description: "Mặt bằng",
        amount: TIEN,
        source: "RECURRING",
        recurringId: mau.id,
      },
    });
    expect((await batLaiDinhKy(mau.id)).ok).toBe(true);

    const res = await suaSangThangNay(cu.id);

    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.field).toBe("date");
    expect(await thangCuaDong(mau.id)).toEqual([format(bonThang[1], "yyyy-MM")]);
  });
});

describe("updateExpense — dời dòng RA KHỎI tháng mẫu còn sinh, sang tháng trước mốc", () => {
  it("mốc = tháng này, dòng tháng này dời về tháng trước ⇒ chặn (tháng này trống sẽ bị sinh bù), DB không đổi", async () => {
    // Tháng đích nằm TRƯỚC mốc ⇒ cổng tháng đích không bắt; chỉ cổng tháng NGUỒN đứng giữa lượt dời và
    // khoản chi tính 2 lần.
    const mau = await prisma.recurringExpense.create({
      data: { categoryId: "fixed", amount: TIEN, dayOfMonth: 1, description: "Mặt bằng", activeFrom: thangNay },
    });
    expect(await ensureRecurringExpenses(thangNay)).toBe(1);
    const dong = await prisma.expense.findFirstOrThrow({ where: { recurringId: mau.id } });

    const res = await updateExpense(dong.id, {
      date: `${format(bonThang[2], "yyyy-MM")}-01`,
      categoryId: "fixed",
      amount: TIEN,
      channelId: null,
      description: "Mặt bằng",
    });

    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.field).toBe("date");
    const sau = await prisma.expense.findUniqueOrThrow({ where: { id: dong.id } });
    expect(sau.date.getTime()).toBe(dong.date.getTime());
    expect(await thangCuaDong(mau.id)).toEqual([format(thangNay, "yyyy-MM")]);
  });
});

describe("updateExpense — Bật lại chen giữa lượt dời tháng", () => {
  it("lượt bật lại đang giữ dòng mẫu ⇒ lượt dời CHỜ rồi đọc mẫu đã bật ⇒ bị chặn (không sinh bù đôi)", async () => {
    // Mẫu dừng, dòng của THÁNG NÀY. Một transaction mô phỏng `batLaiDinhKy` đang dở: đã UPDATE mẫu
    // (active + mốc tháng này) nhưng chưa commit. Cổng dời tháng mà đọc mẫu ngoài khoá thì thấy "đã
    // dừng", cho dời dòng tháng này đi ⇒ commit xong bộ sinh ghi bù tháng này ⇒ tính 2 lần.
    const mau = await prisma.recurringExpense.create({
      data: { categoryId: "fixed", amount: TIEN, dayOfMonth: 1, description: "Mặt bằng", active: false },
    });
    const dong = await prisma.expense.create({
      data: { date: thangNay, categoryId: "fixed", description: "Mặt bằng", amount: TIEN, source: "RECURRING", recurringId: mau.id },
    });

    let daGiuKhoa!: () => void;
    const giuKhoa = new Promise<void>((r) => (daGiuKhoa = r));
    let thaKhoa!: () => void;
    const choTha = new Promise<void>((r) => (thaKhoa = r));
    const batLaiDangDo = prisma.$transaction(
      async (tx) => {
        await tx.recurringExpense.update({ where: { id: mau.id }, data: { active: true, activeFrom: thangNay } });
        daGiuKhoa();
        await choTha;
      },
      { timeout: 20_000 }
    );
    await giuKhoa;

    const sua = updateExpense(dong.id, {
      date: `${format(bonThang[2], "yyyy-MM")}-01`,
      categoryId: "fixed",
      amount: TIEN,
      channelId: null,
      description: "Mặt bằng",
    });
    // Lượt dời có khoá thì đang CHỜ; không khoá thì đã xong trong khoảng này.
    await new Promise((r) => setTimeout(r, 800));
    thaKhoa();
    await batLaiDangDo;

    const res = await sua;
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.field).toBe("date");
    expect(await thangCuaDong(mau.id)).toEqual([format(thangNay, "yyyy-MM")]);
  });
});

describe("batLaiDinhKy — đã có mẫu khác cùng danh mục + kênh đang chạy", () => {
  /** Mẫu cũ đã dừng + mẫu THAY THẾ đang chạy — đúng thứ UI cũ dạy ("thêm khoản định kỳ mới"). */
  async function seedCapMau(thayThe: { categoryId?: string; channelId?: string | null } = {}) {
    const cu = await prisma.recurringExpense.create({
      data: { categoryId: "fixed", amount: TIEN, dayOfMonth: 1, description: "Mặt bằng", active: false },
    });
    const moi = await prisma.recurringExpense.create({
      data: {
        categoryId: thayThe.categoryId ?? "fixed",
        channelId: thayThe.channelId ?? null,
        amount: 5_500_000,
        dayOfMonth: 1,
        description: "Mặt bằng mới",
        activeFrom: thangNay,
      },
    });
    return { cu, moi };
  }

  it("trùng ⇒ từ chối mã riêng, câu lỗi nêu mô tả + số tiền mẫu đang chạy, KHÔNG đổi DB", async () => {
    const { cu } = await seedCapMau();

    const res = await batLaiDinhKy(cu.id);

    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("phải bị từ chối");
    expect(res.code).toBe("DINH_KY_TRUNG_MAU_DANG_CHAY");
    expect(res.error).toContain("Mặt bằng mới");
    expect(res.error).toContain(formatVnd(5_500_000));
    const sau = await prisma.recurringExpense.findUniqueOrThrow({ where: { id: cu.id } });
    expect(sau.active).toBe(false);
    expect(sau.activeFrom).toBeNull();
  });

  it("trùng + cờ xacNhanTrung ⇒ vẫn bật", async () => {
    const { cu } = await seedCapMau();

    const res = await batLaiDinhKy(cu.id, { xacNhanTrung: true });

    expect(res.ok).toBe(true);
    expect((await prisma.recurringExpense.findUniqueOrThrow({ where: { id: cu.id } })).active).toBe(true);
  });

  it("mẫu đang chạy KHÁC danh mục ⇒ bật bình thường", async () => {
    const { cu } = await seedCapMau({ categoryId: "other" });
    expect((await batLaiDinhKy(cu.id)).ok).toBe(true);
  });

  it("cùng danh mục nhưng KHÁC kênh ⇒ bật bình thường (null chỉ bằng null)", async () => {
    const { cu } = await seedCapMau({ channelId: "shopee" });
    expect((await batLaiDinhKy(cu.id)).ok).toBe(true);
  });

  it("mẫu cùng danh mục nhưng cũng ĐÃ DỪNG ⇒ không tính là trùng", async () => {
    const { cu, moi } = await seedCapMau();
    await prisma.recurringExpense.update({ where: { id: moi.id }, data: { active: false } });
    expect((await batLaiDinhKy(cu.id)).ok).toBe(true);
  });
});

describe("batLaiDinhKy — bắt đầu từ tháng sau", () => {
  it("tuThangSau ⇒ mốc = đầu tháng sau, tháng hiện tại KHÔNG sinh, nhãn = tháng sau", async () => {
    const mau = await seedMauDaDung();

    const res = await batLaiDinhKy(mau.id, { tuThangSau: true });

    const thangSau = addMonths(thangNay, 1);
    expect(res).toEqual({ ok: true, data: { tuThang: format(thangSau, "MM/yyyy") } });
    const sau = await prisma.recurringExpense.findUniqueOrThrow({ where: { id: mau.id } });
    expect(sau.activeFrom?.getTime()).toBe(thangSau.getTime());
    expect(await ensureRecurringExpensesForMonths(bonThang)).toBe(0);
    expect(await thangCuaDong(mau.id)).toEqual([format(bonThang[0], "yyyy-MM")]);
  });

  it("Xoá-và-dừng dòng tháng này rồi bật lại từ tháng sau ⇒ dòng vừa xoá KHÔNG bị sinh lại", async () => {
    const tao = await createExpense({
      date: format(new Date(), "yyyy-MM-dd"),
      categoryId: "fixed",
      amount: TIEN,
      channelId: null,
      description: "Phần mềm",
      recurringMonthly: true,
    });
    expect(tao.ok).toBe(true);
    const dong = await prisma.expense.findFirstOrThrow();
    expect((await deleteExpense(dong.id, "stop_recurring")).ok).toBe(true);

    expect((await batLaiDinhKy(dong.recurringId!, { tuThangSau: true })).ok).toBe(true);

    expect(await ensureRecurringExpenses(new Date())).toBe(0);
    expect(await prisma.expense.count()).toBe(0);
  });

  it.each([[{ tuThangSau: "co" }], [{ xacNhanTrung: 1 }], ["x"]])(
    "tuỳ chọn sai kiểu (%j) ⇒ từ chối tại biên, không đổi DB",
    async (tuyChon) => {
      const mau = await seedMauDaDung();
      const res = await batLaiDinhKy(mau.id, tuyChon as never);
      expect(res.ok).toBe(false);
      expect((await prisma.recurringExpense.findUniqueOrThrow({ where: { id: mau.id } })).active).toBe(false);
    }
  );
});
