import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { getExpenseSummary, getExpensesPage, sumPlatformFeeEst } from "@/lib/expenses/expense-queries";
import { prisma } from "@/lib/prisma";
import { seedReference, truncateBusinessTables } from "./helpers/test-db";

/**
 * Integration test tổng hợp chi phí + phí sàn (`hogikids_test`).
 * Kỳ cố định tháng 6/2026 để tách khỏi ngày chạy.
 */

const RANGE = { from: new Date(2026, 5, 1), to: new Date(2026, 5, 30) }; // 01/06–30/06/2026
const IN_RANGE = new Date(2026, 5, 15); // 15/06/2026

beforeAll(async () => {
  await seedReference();
}, 60_000);

beforeEach(async () => {
  await truncateBusinessTables();
});

afterAll(async () => {
  await prisma.$disconnect();
});

async function seedExpensesAndOrders(): Promise<void> {
  await prisma.expense.createMany({
    data: [
      { date: IN_RANGE, categoryId: "purchase", description: "Nhập lô hàng", amount: 5_000_000, source: "MANUAL" },
      { date: IN_RANGE, categoryId: "ads", description: "Meta Ads", amount: 2_000_000, source: "ADS_API", adsSource: "META" },
      { date: IN_RANGE, categoryId: "fixed", description: "Mặt bằng", amount: 1_000_000, source: "MANUAL" },
    ],
  });
  await prisma.order.createMany({
    data: [
      {
        pancakeId: "EXP-O1", code: "O1", channelId: "shopee", status: "COMPLETED",
        orderedAt: IN_RANGE, syncedAt: IN_RANGE, platformFeeEst: 300_000,
      },
      {
        pancakeId: "EXP-O2", code: "O2", channelId: "shopee", status: "RETURNED",
        orderedAt: IN_RANGE, syncedAt: IN_RANGE, platformFeeEst: 200_000,
      },
    ],
  });
}

describe("getExpenseSummary", () => {
  it("total gồm purchase, KHÔNG gồm phí sàn; topCategory=purchase; adsTotal đúng; breakdown bỏ danh mục 0đ", async () => {
    await seedExpensesAndOrders();

    const summary = await getExpenseSummary(RANGE);

    expect(summary.total).toBe(8_000_000); // 5tr + 2tr + 1tr — KHÔNG cộng phí sàn
    expect(summary.topCategory?.categoryId).toBe("purchase");
    expect(summary.topCategory?.amount).toBe(5_000_000);
    expect(summary.adsTotal).toBe(2_000_000);
    // breakdown chỉ chứa danh mục có amount > 0 (3 danh mục), sort desc.
    expect(summary.breakdown.map((b) => b.categoryId)).toEqual(["purchase", "ads", "fixed"]);
    expect(summary.breakdown.every((b) => b.amount > 0)).toBe(true);
    expect(summary.breakdown.some((b) => b.categoryId === "shipping")).toBe(false); // 0đ → loại
  });

  it("kỳ trước = lùi đúng độ dài kỳ; kỳ này không có dữ liệu kỳ trước → totalPrev 0", async () => {
    await seedExpensesAndOrders();
    const summary = await getExpenseSummary(RANGE);
    expect(summary.totalPrev).toBe(0); // tháng 5/2026 không có chi phí
    expect(summary.adsTotalPrev).toBe(0);
  });
});

describe("sumPlatformFeeEst", () => {
  it("chỉ cộng đơn hợp lệ (loại RETURNED/CANCELLED)", async () => {
    await seedExpensesAndOrders();
    const fee = await sumPlatformFeeEst(RANGE);
    expect(fee).toBe(300_000); // 300k COMPLETED; loại 200k RETURNED
  });

  it("lọc theo channelId khi truyền", async () => {
    await seedExpensesAndOrders();
    expect(await sumPlatformFeeEst(RANGE, "shopee")).toBe(300_000);
    expect(await sumPlatformFeeEst(RANGE, "tiktok")).toBe(0);
  });
});

describe("getExpensesPage", () => {
  it("không lọc → count + totalAmount đúng, kèm tên danh mục", async () => {
    await seedExpensesAndOrders();
    const { rows, count, totalAmount } = await getExpensesPage({ range: RANGE, sort: "amount_desc", page: 1 });
    expect(count).toBe(3);
    expect(totalAmount).toBe(8_000_000);
    expect(rows[0].categoryId).toBe("purchase"); // sort amount desc
    expect(rows[0].categoryName).toBe("Nhập hàng");
    expect(rows[0].amount).toBe(5_000_000);
  });

  it("lọc theo categoryIds + trả adsSource thô", async () => {
    await seedExpensesAndOrders();
    const { rows, count, totalAmount } = await getExpensesPage({
      range: RANGE, categoryIds: ["ads"], sort: "date_desc", page: 1,
    });
    expect(count).toBe(1);
    expect(totalAmount).toBe(2_000_000);
    expect(rows[0].adsSource).toBe("META");
    expect(rows[0].source).toBe("ADS_API");
  });

  /**
   * Mảng RỖNG nghĩa là "có yêu cầu lọc mà không id nào hợp lệ" ⇒ phải ra 0 dòng. Trước đây gộp với
   * `undefined` (`length > 0`) nên bộ lọc tự bốc hơi: link drill mang id danh mục ĐÃ ẨN sang sổ,
   * đầu nhận loại thầm id đó rồi sổ liệt kê MỌI khoản chi trong kỳ — sai mà trông như đúng.
   */
  it("categoryIds rỗng → 0 dòng; undefined → không lọc (hai nghĩa KHÁC nhau)", async () => {
    await seedExpensesAndOrders();
    const rong = await getExpensesPage({ range: RANGE, categoryIds: [], sort: "date_desc", page: 1 });
    expect(rong.count).toBe(0);
    expect(rong.totalAmount).toBe(0);

    const khongLoc = await getExpensesPage({ range: RANGE, sort: "date_desc", page: 1 });
    expect(khongLoc.count).toBeGreaterThan(0);
  });

  it("channelId='none' → chỉ chi phí không gắn kênh", async () => {
    await seedExpensesAndOrders();
    // Thêm 1 chi phí gắn kênh shopee để phân biệt.
    await prisma.expense.create({
      data: { date: IN_RANGE, categoryId: "shipping", description: "Ship shopee", amount: 111_000, source: "MANUAL", channelId: "shopee" },
    });
    const withChannel = await getExpensesPage({ range: RANGE, channelId: "shopee", sort: "date_desc", page: 1 });
    expect(withChannel.count).toBe(1);
    expect(withChannel.rows[0].channelName).toBe("Shopee");

    const noChannel = await getExpensesPage({ range: RANGE, channelId: "none", sort: "date_desc", page: 1 });
    expect(noChannel.count).toBe(3); // purchase/ads/fixed đều channelId null
    expect(noChannel.rows.every((r) => r.channelId === null)).toBe(true);
  });
});
