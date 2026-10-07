import { startOfMonth } from "date-fns";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { createExpense } from "@/lib/actions/expenses";
import { formatVnd } from "@/lib/format";
import { prisma } from "@/lib/prisma";
import { seedReference, truncateBusinessTables } from "./helpers/test-db";

/**
 * Tạo khoản chi "lặp hàng tháng" khi đã có mẫu định kỳ cùng danh mục + kênh đang chạy (`hogikids_test`):
 * trùng số tiền hoặc trùng mô tả không rỗng ⇒ server từ chối `DINH_KY_TRUNG_MAU_DANG_CHAY` và KHÔNG
 * ghi gì; gửi lại kèm `xacNhanTrung` mới tạo. Chốt bằng số dòng THẬT trong DB, không bằng thông báo.
 */
vi.mock("@/lib/quyen/nguoi-dung-phien", async (goc) => {
  const { nguoiDungGia } = await import("./helpers/nguoi-dung-gia");
  return {
    ...(await goc<typeof import("@/lib/quyen/nguoi-dung-phien")>()),
    docNguoiDungPhien: vi.fn(async () => nguoiDungGia()),
  };
});
// revalidatePath cần request scope (không có trong vitest) — no-op.
vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

const thangNay = startOfMonth(new Date());
const MA_TRUNG = "DINH_KY_TRUNG_MAU_DANG_CHAY";

/** Mẫu đang chạy sẵn có: danh mục `fixed`, không kênh, 2.000.000đ, mô tả "Tiền nhà". */
async function seedMauDangChay(
  p: { amount?: number; description?: string; channelId?: string | null; active?: boolean; categoryId?: string } = {}
) {
  return prisma.recurringExpense.create({
    data: {
      categoryId: p.categoryId ?? "fixed",
      channelId: p.channelId ?? null,
      amount: p.amount ?? 2_000_000,
      dayOfMonth: 1,
      description: p.description ?? "Tiền nhà",
      active: p.active ?? true,
      activeFrom: thangNay,
    },
  });
}

/** Đầu vào tạo khoản lặp — mặc định KHÁC mẫu sẵn có ở cả số tiền lẫn mô tả (không trùng). */
function taoLap(p: Record<string, unknown> = {}) {
  return createExpense({
    date: new Date(),
    categoryId: "fixed",
    amount: 750_000,
    channelId: null,
    description: "Internet",
    recurringMonthly: true,
    ...p,
  });
}

const demMau = () => prisma.recurringExpense.count();
const demDong = () => prisma.expense.count();

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

describe("createExpense lặp hàng tháng — cảnh báo trùng mẫu đang chạy", () => {
  it("trùng SỐ TIỀN ⇒ trả mã riêng, câu lỗi nêu mô tả + số tiền mẫu cũ, KHÔNG ghi gì", async () => {
    await seedMauDangChay();

    const res = await taoLap({ amount: 2_000_000, description: "Khoản khác hẳn" });

    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("phải bị từ chối");
    expect(res.code).toBe(MA_TRUNG);
    expect(res.error).toContain("Tiền nhà");
    expect(res.error).toContain(formatVnd(2_000_000));
    expect(await demMau()).toBe(1);
    expect(await demDong()).toBe(0);
  });

  it("trùng MÔ TẢ (khác hoa/thường, dư khoảng trắng), khác số tiền ⇒ hỏi, không ghi gì", async () => {
    await seedMauDangChay();

    const res = await taoLap({ amount: 2_500_000, description: "  TIỀN NHÀ " });

    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe(MA_TRUNG);
    expect(await demMau()).toBe(1);
    expect(await demDong()).toBe(0);
  });

  it("có xacNhanTrung ⇒ tạo ĐÚNG 1 mẫu mới + 1 dòng đầu", async () => {
    await seedMauDangChay();

    const res = await taoLap({ amount: 2_000_000, description: "Tiền nhà", xacNhanTrung: true });

    expect(res.ok).toBe(true);
    expect(await demMau()).toBe(2);
    expect(await demDong()).toBe(1);
  });

  it("khác số tiền + khác mô tả ⇒ tạo thẳng, không hỏi", async () => {
    await seedMauDangChay();

    const res = await taoLap();

    expect(res.ok).toBe(true);
    expect(await demMau()).toBe(2);
    expect(await demDong()).toBe(1);
  });

  it("mô tả RỖNG cả hai bên, khác số tiền ⇒ không tính là trùng", async () => {
    await seedMauDangChay({ description: "" });

    const res = await taoLap({ description: "" });

    expect(res.ok).toBe(true);
    expect(await demMau()).toBe(2);
  });

  it("cùng danh mục nhưng KHÁC kênh (null vs có kênh, và ngược lại) ⇒ tạo thẳng dù trùng số tiền", async () => {
    await seedMauDangChay();
    const khacKenh = await taoLap({ amount: 2_000_000, description: "Tiền nhà", channelId: "shopee" });
    expect(khacKenh.ok).toBe(true);

    await truncateBusinessTables();
    await seedMauDangChay({ channelId: "shopee" });
    const nullVsKenh = await taoLap({ amount: 2_000_000, description: "Tiền nhà", channelId: null });
    expect(nullVsKenh.ok).toBe(true);
  });

  it("khác danh mục ⇒ tạo thẳng dù trùng số tiền + mô tả", async () => {
    await seedMauDangChay();

    const res = await taoLap({ categoryId: "packaging", amount: 2_000_000, description: "Tiền nhà" });

    expect(res.ok).toBe(true);
  });

  it("mẫu trùng đã DỪNG ⇒ tạo thẳng", async () => {
    await seedMauDangChay({ active: false });

    const res = await taoLap({ amount: 2_000_000, description: "Tiền nhà" });

    expect(res.ok).toBe(true);
    expect(await demMau()).toBe(2);
  });

  it("KHÔNG bật lặp ⇒ không bao giờ hỏi, dù trùng hệt mẫu đang chạy", async () => {
    await seedMauDangChay();

    const res = await taoLap({ recurringMonthly: false, amount: 2_000_000, description: "Tiền nhà" });

    expect(res.ok).toBe(true);
    expect(await demMau()).toBe(1);
    expect(await demDong()).toBe(1);
  });

  it("danh mục ads vẫn bị chặn lặp, cờ xacNhanTrung không mở được", async () => {
    const res = await taoLap({
      categoryId: "ads",
      adsSource: "META",
      channelId: "facebook",
      xacNhanTrung: true,
    });

    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.field).toBe("recurringMonthly");
    expect(await demMau()).toBe(0);
    expect(await demDong()).toBe(0);
  });
});

describe("createExpense lặp hàng tháng — hai lượt tạo ĐỒNG THỜI cùng nhóm", () => {
  const SO_VONG = 6;
  const demActive = () => prisma.recurringExpense.count({ where: { active: true } });

  /** Hai lượt trùng hệt nhau chạy song song: đúng 1 lượt tạo, lượt kia nhận mã trùng. */
  async function chayDua() {
    const [a, b] = await Promise.all([
      taoLap({ amount: 777_000, description: "Đua A" }),
      taoLap({ amount: 777_000, description: "Đua B" }),
    ]);
    expect([a, b].filter((r) => r.ok)).toHaveLength(1);
    const tuChoi = [a, b].filter((r) => !r.ok);
    expect(tuChoi).toHaveLength(1);
    const loi = tuChoi[0];
    if (loi.ok) throw new Error("không tới đây");
    expect(loi.code).toBe(MA_TRUNG);
  }

  it("nhóm đã có 1 mẫu ĐÃ DỪNG (khoá dòng) ⇒ đúng 1 lượt tạo, 1 mẫu đang chạy mới", async () => {
    for (let i = 0; i < SO_VONG; i++) {
      await truncateBusinessTables();
      await seedMauDangChay({ active: false, amount: 1_000, description: "Cũ đã dừng" });
      await chayDua();
      expect(await demActive()).toBe(1);
    }
  });

  it("nhóm RỖNG (không dòng nào để khoá dòng) ⇒ đúng 1 lượt tạo, 1 mẫu đang chạy", async () => {
    for (let i = 0; i < SO_VONG; i++) {
      await truncateBusinessTables();
      await chayDua();
      expect(await demActive()).toBe(1);
      expect(await demDong()).toBe(1);
    }
  });
});

