import { addMonths, format, startOfMonth, subMonths } from "date-fns";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { batLaiDinhKy, createExpense, deleteExpense, stopRecurring, updateExpense } from "@/lib/actions/expenses";
import { ensureRecurringExpenses, ensureRecurringExpensesForMonths } from "@/lib/expenses/ensure-recurring-expenses";
import { khoaThangDinhKy } from "@/lib/expenses/khoa-thang-dinh-ky";
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
// Ngữ cảnh người dùng giả (mặc định chủ shop) — action đi qua `congAction`, không có cookie trong vitest.
vi.mock("@/lib/quyen/nguoi-dung-phien", async (goc) => {
  const { nguoiDungGia } = await import("./helpers/nguoi-dung-gia");
  return {
    ...(await goc<typeof import("@/lib/quyen/nguoi-dung-phien")>()),
    docNguoiDungPhien: vi.fn(async () => nguoiDungGia()),
  };
});
// revalidatePath cần request scope (không có trong vitest) — no-op cho unit test.
vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

const thangNay = startOfMonth(new Date());
// Bốn tháng liền nhau kết thúc ở tháng hiện tại — dayOfMonth=1 nên tháng nào cũng đã tới hạn.
const bonThang = [3, 2, 1, 0].map((n) => subMonths(thangNay, n));
const TIEN = 2_000_000;
/** Lựa chọn trong hộp "Bật lại" — khoá `yyyy-MM` đúng như server render cho hộp xác nhận. */
const TU_THANG_NAY = { thangBatDau: format(thangNay, "yyyy-MM") };
const TU_THANG_SAU = { thangBatDau: format(addMonths(thangNay, 1), "yyyy-MM") };

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
      recurringMonth: khoaThangDinhKy(bonThang[0]),
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

    const res = await batLaiDinhKy(mau.id, TU_THANG_NAY);

    expect(res).toEqual({ ok: true, data: { tuThang: format(thangNay, "MM/yyyy") } });
    const sau = await prisma.recurringExpense.findUniqueOrThrow({ where: { id: mau.id } });
    expect(sau.active).toBe(true);
    expect(sau.activeFrom?.getTime()).toBe(thangNay.getTime());
  });

  it("CHỐT TIỀN: bật lại rồi render cả các tháng đã dừng ⇒ CHỈ sinh tháng hiện tại, không ghi bù", async () => {
    const mau = await seedMauDaDung();
    await batLaiDinhKy(mau.id, TU_THANG_NAY);

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
    expect((await batLaiDinhKy(mau.id, TU_THANG_NAY)).ok).toBe(true);

    expect(await ensureRecurringExpensesForMonths(bonThang)).toBe(1);
    expect(await thangCuaDong(mau.id)).toEqual([format(thangNay, "yyyy-MM")]);
  });

  it("mẫu ĐANG CHẠY ⇒ từ chối rõ ràng, KHÔNG đụng mốc (idempotent)", async () => {
    const mau = await prisma.recurringExpense.create({
      data: { categoryId: "fixed", amount: TIEN, dayOfMonth: 1, description: "Đang chạy", activeFrom: null },
    });

    const res = await batLaiDinhKy(mau.id, TU_THANG_NAY);

    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("phải bị từ chối");
    expect(res.code).toBe("DINH_KY_DANG_CHAY");
    const sau = await prisma.recurringExpense.findUniqueOrThrow({ where: { id: mau.id } });
    expect(sau.activeFrom).toBeNull(); // mốc KHÔNG bị kéo lên — mẫu cũ vẫn sinh đủ tháng quá khứ
  });

  it("bấm hai lần liền ⇒ lượt thứ hai bị từ chối, mốc giữ nguyên", async () => {
    const mau = await seedMauDaDung();

    const [a, b] = await Promise.all([batLaiDinhKy(mau.id, TU_THANG_NAY), batLaiDinhKy(mau.id, TU_THANG_NAY)]);

    expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1);
    const sau = await prisma.recurringExpense.findUniqueOrThrow({ where: { id: mau.id } });
    expect(sau.active).toBe(true);
    expect(sau.activeFrom?.getTime()).toBe(thangNay.getTime());
  });

  it("id không tồn tại ⇒ từ chối, không tạo gì", async () => {
    const res = await batLaiDinhKy("khong-co-id-nay", TU_THANG_NAY);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe("KHONG_TIM_THAY");
    expect(await prisma.recurringExpense.count()).toBe(0);
  });

  it.each([[""], [null], [42]])("id sai kiểu/rỗng (%s) ⇒ từ chối tại biên", async (id) => {
    const res = await batLaiDinhKy(id as unknown as string, TU_THANG_NAY);
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
    // Ngày đến hạn = 01 để tháng hiện tại LUÔN đã tới hạn, không phụ thuộc hôm nay là ngày mấy.
    const res = await createExpense(input(`${format(bonThang[1], "yyyy-MM")}-01`));
    expect(res.ok).toBe(true);

    const mau = await prisma.recurringExpense.findFirstOrThrow();
    expect(mau.activeFrom?.getTime()).toBe(bonThang[1].getTime());
    expect(await ensureRecurringExpensesForMonths(bonThang)).toBe(2); // T-1 và tháng hiện tại
    expect(await thangCuaDong(mau.id)).toEqual(bonThang.slice(1).map((m) => format(m, "yyyy-MM")));
  });

  // Mẫu đến hạn ngày 10: tháng hiện tại CHỈ được sinh từ ngày 10 trở đi (trước đó chưa tới hạn).
  // Đồng hồ giả chỉ cho `Date` — timer/Promise của Prisma + pool vẫn chạy thật.
  describe.each([1, 9, 10, 28])("mẫu đến hạn ngày 10, hôm nay là ngày %i của tháng", (homNay) => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it(homNay >= 10 ? "tháng hiện tại đã tới hạn ⇒ sinh" : "tháng hiện tại CHƯA tới hạn ⇒ chưa sinh", async () => {
      const res = await createExpense(input(`${format(bonThang[1], "yyyy-MM")}-10`));
      expect(res.ok).toBe(true);
      const mau = await prisma.recurringExpense.findFirstOrThrow();

      vi.useFakeTimers({ toFake: ["Date"], now: new Date(thangNay.getFullYear(), thangNay.getMonth(), homNay, 12, 0) });

      const daTaoHienTai = homNay >= 10;
      expect(await ensureRecurringExpensesForMonths(bonThang)).toBe(daTaoHienTai ? 2 : 1);
      const thangDuKien = daTaoHienTai ? bonThang.slice(1) : bonThang.slice(1, 3);
      expect(await thangCuaDong(mau.id)).toEqual(thangDuKien.map((m) => format(m, "yyyy-MM")));
    });
  });
});

describe("updateExpense — dời dòng của tháng TRƯỚC mốc", () => {
  it("mẫu đã bật lại, dòng cũ nằm trước mốc ⇒ dời được (tháng trống không bị sinh bù)", async () => {
    const mau = await seedMauDaDung();
    await batLaiDinhKy(mau.id, TU_THANG_NAY);
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
    expect((await batLaiDinhKy(mau.id, TU_THANG_NAY)).ok).toBe(true);
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
        recurringMonth: khoaThangDinhKy(bonThang[1]),
      },
    });
    expect((await batLaiDinhKy(mau.id, TU_THANG_NAY)).ok).toBe(true);

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
      data: { date: thangNay, categoryId: "fixed", description: "Mặt bằng", amount: TIEN, source: "RECURRING", recurringId: mau.id, recurringMonth: khoaThangDinhKy(thangNay) },
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

    const res = await batLaiDinhKy(cu.id, TU_THANG_NAY);

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

    const res = await batLaiDinhKy(cu.id, { ...TU_THANG_NAY, xacNhanTrung: true });

    expect(res.ok).toBe(true);
    expect((await prisma.recurringExpense.findUniqueOrThrow({ where: { id: cu.id } })).active).toBe(true);
  });

  it("mẫu đang chạy KHÁC danh mục ⇒ bật bình thường", async () => {
    const { cu } = await seedCapMau({ categoryId: "other" });
    expect((await batLaiDinhKy(cu.id, TU_THANG_NAY)).ok).toBe(true);
  });

  it("cùng danh mục nhưng KHÁC kênh ⇒ bật bình thường (null chỉ bằng null)", async () => {
    const { cu } = await seedCapMau({ channelId: "shopee" });
    expect((await batLaiDinhKy(cu.id, TU_THANG_NAY)).ok).toBe(true);
  });

  it("mẫu cùng danh mục nhưng cũng ĐÃ DỪNG ⇒ không tính là trùng", async () => {
    const { cu, moi } = await seedCapMau();
    await prisma.recurringExpense.update({ where: { id: moi.id }, data: { active: false } });
    expect((await batLaiDinhKy(cu.id, TU_THANG_NAY)).ok).toBe(true);
  });
});

describe("batLaiDinhKy — bắt đầu từ tháng sau", () => {
  it("chọn tháng sau ⇒ mốc = đầu tháng sau, tháng hiện tại KHÔNG sinh, nhãn = tháng sau", async () => {
    const mau = await seedMauDaDung();

    const res = await batLaiDinhKy(mau.id, TU_THANG_SAU);

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

    expect((await batLaiDinhKy(dong.recurringId!, TU_THANG_SAU)).ok).toBe(true);

    expect(await ensureRecurringExpenses(new Date())).toBe(0);
    expect(await prisma.expense.count()).toBe(0);
  });

  it.each([
    [undefined],
    [{}],
    [{ tuThangSau: true }],
    [{ ...TU_THANG_NAY, tuThangSau: true }],
    [{ thangBatDau: "2026-13" }],
    [{ thangBatDau: "2026-1" }],
    [{ thangBatDau: "10/2026" }],
    [{ thangBatDau: 202610 }],
    [{ ...TU_THANG_NAY, xacNhanTrung: 1 }],
    ["x"],
  ])(
    "tuỳ chọn sai kiểu (%j) ⇒ từ chối tại biên bằng câu tiếng Việt 'tải lại trang', không đổi DB",
    async (tuyChon) => {
      const mau = await seedMauDaDung();
      const res = await batLaiDinhKy(mau.id, tuyChon as never);
      // Sai hình dạng chỉ đến từ bundle cũ còn mở sau deploy — câu lỗi phải chỉ đúng cách chữa.
      expect(res).toMatchObject({ ok: false, error: "Trang đã cũ — tải lại trang rồi bật lại" });
      expect((await prisma.recurringExpense.findUniqueOrThrow({ where: { id: mau.id } })).active).toBe(false);
    }
  );
});

describe("batLaiDinhKy — cổng trang cũ: chỉ nhận tháng này hoặc tháng sau", () => {
  it.each([
    ["tháng trước (trang mở từ tháng trước)", subMonths(thangNay, 1)],
    ["hai tháng sau", addMonths(thangNay, 2)],
    ["năm sau cùng tháng", addMonths(thangNay, 12)],
  ])("%s ⇒ TRANG_CU, KHÔNG đổi DB", async (_moTa, thang) => {
    const mau = await seedMauDaDung();

    const res = await batLaiDinhKy(mau.id, { thangBatDau: format(thang, "yyyy-MM") });

    expect(res).toEqual({ ok: false, code: "TRANG_CU", error: "Trang đã cũ — tải lại trang rồi bật lại" });
    const sau = await prisma.recurringExpense.findUniqueOrThrow({ where: { id: mau.id } });
    expect(sau.active).toBe(false);
    expect(sau.activeFrom).toBeNull();
  });

  it("có mẫu TRÙNG đang chạy + tháng cũ ⇒ TRANG_CU trước, không bắt xác nhận trùng rồi mới đòi tải lại", async () => {
    // Báo trùng trước thì chủ shop bấm "Vẫn bật lại" xong mới bị đòi tải lại trang — rồi phải xác nhận
    // trùng thêm lần nữa trên trang mới.
    const mau = await seedMauDaDung();
    await prisma.recurringExpense.create({
      data: { categoryId: "fixed", amount: 5_500_000, dayOfMonth: 1, description: "Mặt bằng mới", activeFrom: thangNay },
    });

    const res = await batLaiDinhKy(mau.id, { thangBatDau: format(subMonths(thangNay, 1), "yyyy-MM") });

    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe("TRANG_CU");
    expect((await prisma.recurringExpense.findUniqueOrThrow({ where: { id: mau.id } })).active).toBe(false);
  });

  it("mẫu ĐANG CHẠY + tháng cũ ⇒ vẫn báo đang chạy (không bắt tải lại trang vô ích)", async () => {
    const mau = await prisma.recurringExpense.create({
      data: { categoryId: "fixed", amount: TIEN, dayOfMonth: 1, description: "Đang chạy" },
    });
    const res = await batLaiDinhKy(mau.id, { thangBatDau: format(subMonths(thangNay, 1), "yyyy-MM") });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe("DINH_KY_DANG_CHAY");
  });
});

describe("updateExpense — mẫu ĐANG DỪNG, dời dòng cũ vào tháng hiện tại", () => {
  // Mẫu dừng thì không ai sinh, nhưng "Bật lại" đặt mốc sớm nhất = tháng hiện tại. Dòng dời vào tháng
  // này mang `recurringId` ⇒ bật lại từ tháng này là bộ sinh thấy "tháng này đã có dòng" và không ghi
  // khoản của chính tháng này — cùng kết cục với lượt dời vào tháng còn sinh của mẫu đang chạy.
  const suaSang = (id: string, ngay: string, amount = TIEN) =>
    updateExpense(id, { date: ngay, categoryId: "fixed", amount, channelId: null, description: "Mặt bằng" });

  it("dời vào tháng hiện tại ⇒ chặn ở ô ngày, dòng cũ giữ nguyên tháng", async () => {
    const mau = await seedMauDaDung();
    const cu = await prisma.expense.findFirstOrThrow({ where: { recurringId: mau.id } });

    const res = await suaSang(cu.id, format(new Date(), "yyyy-MM-dd"));

    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.field).toBe("date");
    expect(await thangCuaDong(mau.id)).toEqual([format(bonThang[0], "yyyy-MM")]);
  });

  it("CHỐT TIỀN: thử dời rồi bật lại từ tháng này ⇒ tháng này có đúng khoản của mẫu, tháng cũ giữ khoản cũ", async () => {
    const mau = await seedMauDaDung();
    const cu = await prisma.expense.findFirstOrThrow({ where: { recurringId: mau.id } });

    await suaSang(cu.id, format(new Date(), "yyyy-MM-dd"), 1_500_000);
    expect((await batLaiDinhKy(mau.id, TU_THANG_NAY)).ok).toBe(true);
    await ensureRecurringExpenses(thangNay);

    expect(await thangCuaDong(mau.id)).toEqual([format(bonThang[0], "yyyy-MM"), format(thangNay, "yyyy-MM")]);
    const tong = await prisma.expense.aggregate({ where: { recurringId: mau.id }, _sum: { amount: true } });
    expect(tong._sum.amount).toBe(2 * TIEN);
  });

  it("dời sang tháng ĐÃ QUA vẫn lưu được — bật lại không bao giờ sinh cho tháng trước tháng hiện tại", async () => {
    const mau = await seedMauDaDung();
    const cu = await prisma.expense.findFirstOrThrow({ where: { recurringId: mau.id } });

    expect((await suaSang(cu.id, `${format(bonThang[2], "yyyy-MM")}-01`)).ok).toBe(true);
    expect((await batLaiDinhKy(mau.id, TU_THANG_NAY)).ok).toBe(true);
    await ensureRecurringExpensesForMonths(bonThang);

    expect(await thangCuaDong(mau.id)).toEqual([format(bonThang[2], "yyyy-MM"), format(thangNay, "yyyy-MM")]);
  });
});

describe("updateExpense — mẫu ĐANG CHẠY nhưng mốc còn ở tháng sau (bật lại 'từ tháng sau')", () => {
  // Mẫu chạy với mốc tháng sau cũng chưa sinh gì cho tháng này — nhưng chỉ cần dừng rồi bật lại "tháng
  // này" là mốc lùi về tháng này. Dòng dời vào tháng này lúc mốc còn ở tháng sau sẽ chiếm khoá
  // "1 dòng/mẫu/tháng" y như ca mẫu đang dừng.
  const suaSang = (id: string, ngay: string) =>
    updateExpense(id, { date: ngay, categoryId: "fixed", amount: TIEN, channelId: null, description: "Mặt bằng" });

  it("dời vào tháng hiện tại ⇒ chặn ở ô ngày, DB không đổi", async () => {
    const mau = await seedMauDaDung();
    expect((await batLaiDinhKy(mau.id, TU_THANG_SAU)).ok).toBe(true);
    const cu = await prisma.expense.findFirstOrThrow({ where: { recurringId: mau.id } });

    const res = await suaSang(cu.id, format(new Date(), "yyyy-MM-dd"));

    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.field).toBe("date");
    expect(await thangCuaDong(mau.id)).toEqual([format(bonThang[0], "yyyy-MM")]);
  });

  it("CHỐT TIỀN chuỗi 4 bước: bật lại tháng sau → dời vào tháng này → dừng → bật lại tháng này ⇒ Σ = 2 khoản", async () => {
    const mau = await seedMauDaDung();
    expect((await batLaiDinhKy(mau.id, TU_THANG_SAU)).ok).toBe(true);
    const cu = await prisma.expense.findFirstOrThrow({ where: { recurringId: mau.id } });

    await suaSang(cu.id, format(new Date(), "yyyy-MM-dd"));
    expect((await stopRecurring(mau.id)).ok).toBe(true);
    expect((await batLaiDinhKy(mau.id, TU_THANG_NAY)).ok).toBe(true);
    await ensureRecurringExpenses(thangNay);

    expect(await thangCuaDong(mau.id)).toEqual([format(bonThang[0], "yyyy-MM"), format(thangNay, "yyyy-MM")]);
    const tong = await prisma.expense.aggregate({ where: { recurringId: mau.id }, _sum: { amount: true } });
    expect(tong._sum.amount).toBe(2 * TIEN);
  });

  it("dời giữa hai tháng ĐÃ QUA vẫn lưu được", async () => {
    const mau = await seedMauDaDung();
    expect((await batLaiDinhKy(mau.id, TU_THANG_SAU)).ok).toBe(true);
    const cu = await prisma.expense.findFirstOrThrow({ where: { recurringId: mau.id } });

    expect((await suaSang(cu.id, `${format(bonThang[2], "yyyy-MM")}-01`)).ok).toBe(true);
  });
});

describe("updateExpense — mẫu đang chạy mốc KHÔNG ở tương lai: hành vi giữ nguyên", () => {
  const suaSang = (id: string, ngay: string) =>
    updateExpense(id, { date: ngay, categoryId: "fixed", amount: TIEN, channelId: null, description: "Mặt bằng" });

  it("mốc tháng trước, dòng T-3 (trước mốc) dời sang T-2 (trước mốc) ⇒ lưu được", async () => {
    const mau = await prisma.recurringExpense.create({
      data: { categoryId: "fixed", amount: TIEN, dayOfMonth: 1, description: "Mặt bằng", activeFrom: bonThang[2] },
    });
    const dong = await prisma.expense.create({
      data: { date: bonThang[0], categoryId: "fixed", description: "Mặt bằng", amount: TIEN, source: "RECURRING", recurringId: mau.id, recurringMonth: khoaThangDinhKy(bonThang[0]) },
    });

    expect((await suaSang(dong.id, `${format(bonThang[1], "yyyy-MM")}-01`)).ok).toBe(true);
  });

  it("mốc NULL (mẫu cũ) ⇒ vẫn chặn mọi lượt dời tháng như trước", async () => {
    const mau = await prisma.recurringExpense.create({
      data: { categoryId: "fixed", amount: TIEN, dayOfMonth: 1, description: "Mặt bằng" },
    });
    const dong = await prisma.expense.create({
      data: { date: bonThang[0], categoryId: "fixed", description: "Mặt bằng", amount: TIEN, source: "RECURRING", recurringId: mau.id, recurringMonth: khoaThangDinhKy(bonThang[0]) },
    });

    expect((await suaSang(dong.id, `${format(bonThang[1], "yyyy-MM")}-01`)).ok).toBe(false);
  });
});

describe("batLaiDinhKy — hai mẫu trùng đã dừng bật lại đồng thời", () => {
  async function seedHaiMauDung(channelId: string | null = null) {
    const [a, b] = await Promise.all(
      ["Mặt bằng", "Mặt bằng mới"].map((description) =>
        prisma.recurringExpense.create({
          data: { categoryId: "fixed", channelId, amount: TIEN, dayOfMonth: 1, description, active: false },
        })
      )
    );
    return { a, b };
  }

  it.each([[null], ["shopee"]])(
    "kênh %s: lượt kia đang bật dở (chưa commit) ⇒ lượt này CHỜ rồi thấy mẫu kia đã chạy ⇒ từ chối trùng",
    async (channelId) => {
      // Mô phỏng `batLaiDinhKy(a)` đang dở: đã UPDATE mẫu a nhưng chưa commit. Dò trùng mà không khoá
      // cả nhóm danh mục + kênh thì lượt b thấy a "đang dừng" và tự bật ⇒ mỗi tháng trừ 2 lần.
      const { a, b } = await seedHaiMauDung(channelId);

      let daGiuKhoa!: () => void;
      const giuKhoa = new Promise<void>((r) => (daGiuKhoa = r));
      let thaKhoa!: () => void;
      const choTha = new Promise<void>((r) => (thaKhoa = r));
      const batADangDo = prisma.$transaction(
        async (tx) => {
          await tx.recurringExpense.update({ where: { id: a.id }, data: { active: true, activeFrom: thangNay } });
          daGiuKhoa();
          await choTha;
        },
        { timeout: 20_000 }
      );
      await giuKhoa;

      const batB = batLaiDinhKy(b.id, TU_THANG_NAY);
      // Lượt b có khoá thì đang CHỜ; không khoá thì đã bật xong trong khoảng này.
      await new Promise((r) => setTimeout(r, 800));
      thaKhoa();
      await batADangDo;

      const res = await batB;
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.code).toBe("DINH_KY_TRUNG_MAU_DANG_CHAY");
      expect((await prisma.recurringExpense.findUniqueOrThrow({ where: { id: b.id } })).active).toBe(false);
    }
  );

  it("bấm cùng lúc ở hai tab ⇒ đúng MỘT mẫu chạy, lượt kia bị từ chối trùng (không lỗi hệ thống)", async () => {
    const { a, b } = await seedHaiMauDung();

    const kq = await Promise.all([batLaiDinhKy(a.id, TU_THANG_NAY), batLaiDinhKy(b.id, TU_THANG_NAY)]);

    expect(kq.filter((r) => r.ok)).toHaveLength(1);
    const tuChoi = kq.find((r) => !r.ok);
    expect(tuChoi && !tuChoi.ok ? tuChoi.code : null).toBe("DINH_KY_TRUNG_MAU_DANG_CHAY");
    expect(await prisma.recurringExpense.count({ where: { active: true } })).toBe(1);
  });
});
