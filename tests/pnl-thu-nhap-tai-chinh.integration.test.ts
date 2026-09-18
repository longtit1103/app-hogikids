import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { prisma } from "@/lib/prisma";
import { computeDailySeries } from "@/lib/reports/daily-series";
import { calcPnl, sumThuNhapTaiChinh } from "@/lib/reports/pnl";

import { seedReference, truncateBusinessTables } from "./helpers/test-db";

/**
 * Thu nhập tài chính đi từ DB THẬT (`hogikids_test`) vào P&L. Suite này phủ đúng chỗ mà kiểu dữ
 * liệu KHÔNG bảo vệ được: `opts.incomes` là optional, quên truyền ở một call site thì không có
 * lỗi compile — chỉ ra số thiếu. Ở đây là call site `calcPnl` (pnl.ts); call site `daily-series`
 * do test parity phủ; call site `cash-flow.ts` đã chặn ở tầng kiểu (overload statusIn).
 *
 * Kỳ cố định 6/2026, neo giờ VN.
 */

const RANGE = { from: new Date(2026, 5, 1), to: new Date(2026, 5, 30) };
const IN_RANGE = new Date(2026, 5, 15);
const CUOI_KY_TOI = new Date(2026, 5, 30, 21, 0); // 21h ngày cuối kỳ — bẫy quên endOfDay
const NGOAI_KY = new Date(2026, 6, 2);

beforeAll(async () => {
  await seedReference();
}, 60_000);

beforeEach(async () => {
  await truncateBusinessTables();
});

afterAll(async () => {
  await prisma.$disconnect();
});

/** 1 đơn COMPLETED không có dòng hàng ⇒ cogs 0 ⇒ grossProfit = 500.000 − 62.500 − 20.000 = 417.500. */
async function seedDon(): Promise<void> {
  await prisma.order.create({
    data: {
      pancakeId: "TN-DON-1",
      code: "TN1",
      channelId: "shopee",
      status: "COMPLETED",
      orderedAt: IN_RANGE,
      syncedAt: IN_RANGE,
      itemsTotal: 500_000,
      discount: 20_000,
      platformFeeEst: 62_500,
    },
  });
}

describe("calcPnl — đọc ThuNhap trong kỳ (không quên truyền opts.incomes)", () => {
  it("lãi trong kỳ vào financialIncome và CỘNG vào netProfit; dòng ngoài kỳ bị loại", async () => {
    await seedDon();
    await prisma.thuNhap.createMany({
      data: [
        { date: IN_RANGE, kind: "LAI_TIET_KIEM", amount: 2_000_000, description: "Lãi sổ 6 tháng VCB" },
        { date: NGOAI_KY, kind: "LAI_TIET_KIEM", amount: 9_000_000, description: "Lãi tháng sau" },
      ],
    });

    const b = await calcPnl(RANGE);
    expect(b.financialIncome).toBe(2_000_000); // 9tr ngoài kỳ KHÔNG lọt
    expect(b.grossProfit).toBe(417_500);
    expect(b.netProfit).toBe(2_417_500);
  });

  it("lãi ghi lúc 21h ngày CUỐI kỳ vẫn tính (biên phải endOfDay, khớp orders/expenses)", async () => {
    await prisma.thuNhap.create({
      data: { date: CUOI_KY_TOI, kind: "LAI_TIET_KIEM", amount: 1_500_000, description: "Tất toán cuối tháng" },
    });

    const b = await calcPnl(RANGE);
    expect(b.financialIncome).toBe(1_500_000);
    expect(b.netProfit).toBe(1_500_000);
  });

  it("kỳ không có ThuNhap nào → financialIncome 0, netProfit y hệt trước khi có tính năng", async () => {
    await seedDon();
    const b = await calcPnl(RANGE);
    expect(b.financialIncome).toBe(0);
    expect(b.netProfit).toBe(417_500);
  });

  it("lăng kính kênh qua loader: financialIncome = 0 dù kỳ có lãi", async () => {
    await seedDon();
    await prisma.thuNhap.create({
      data: { date: IN_RANGE, kind: "LAI_TIET_KIEM", amount: 2_000_000, description: "Lãi sổ" },
    });

    const b = await calcPnl(RANGE, { channelId: "shopee" });
    expect(b.financialIncome).toBe(0);
    expect(b.netProfit).toBe(417_500);
  });
});

describe("sumThuNhapTaiChinh — Σ nhanh cho các màn chỉ cần chú thích", () => {
  it("cộng đúng các dòng trong kỳ, loại dòng ngoài kỳ, khớp financialIncome của calcPnl", async () => {
    await prisma.thuNhap.createMany({
      data: [
        { date: IN_RANGE, kind: "LAI_TIET_KIEM", amount: 2_000_000, description: "Sổ A" },
        { date: CUOI_KY_TOI, kind: "LAI_TIET_KIEM", amount: 1_500_000, description: "Sổ B" },
        { date: NGOAI_KY, kind: "LAI_TIET_KIEM", amount: 9_000_000, description: "Tháng sau" },
      ],
    });

    expect(await sumThuNhapTaiChinh(RANGE)).toBe(3_500_000);
    expect(await sumThuNhapTaiChinh(RANGE)).toBe((await calcPnl(RANGE)).financialIncome);
  });

  it("kỳ rỗng → 0 (không phải null)", async () => {
    expect(await sumThuNhapTaiChinh(RANGE)).toBe(0);
  });
});

describe("computeDailySeries — thu nhập tài chính bucket theo NGÀY", () => {
  it("Σ netProfit từng ngày = netProfit cả kỳ KHI CÓ thu nhập tài chính (biểu đồ không lệch bảng)", async () => {
    await seedDon();
    await prisma.expense.create({
      data: { date: IN_RANGE, categoryId: "ads", description: "Meta", amount: 300_000, source: "MANUAL" },
    });
    await prisma.thuNhap.createMany({
      data: [
        { date: IN_RANGE, kind: "LAI_TIET_KIEM", amount: 2_000_000, description: "Sổ A" },
        { date: CUOI_KY_TOI, kind: "LAI_TIET_KIEM", amount: 1_500_000, description: "Sổ B" },
      ],
    });

    const [series, ky] = await Promise.all([computeDailySeries(RANGE), calcPnl(RANGE)]);
    const tongNgay = series.reduce((s, p) => s + p.netProfit, 0);

    expect(ky.financialIncome).toBe(3_500_000); // non-vacuity: kỳ thật sự có thu nhập
    expect(tongNgay).toBe(ky.netProfit);
  });

  it("lãi rơi ĐÚNG ngày tất toán, không dàn ra các ngày khác", async () => {
    await prisma.thuNhap.create({
      data: { date: IN_RANGE, kind: "LAI_TIET_KIEM", amount: 2_000_000, description: "Sổ A" },
    });

    const series = await computeDailySeries(RANGE);
    const ngay15 = series.find((p) => p.date === "2026-06-15")!;
    const ngay16 = series.find((p) => p.date === "2026-06-16")!;
    expect(ngay15.netProfit).toBe(2_000_000);
    expect(ngay16.netProfit).toBe(0);
  });
});
