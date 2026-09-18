import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { prisma } from "@/lib/prisma";
import { computeCashFlow, sumGmv } from "@/lib/reports/cash-flow";
import { calcPnl } from "@/lib/reports/pnl";
import { seedReference, truncateBusinessTables } from "./helpers/test-db";

/**
 * Integration test lăng kính Dòng tiền (`hogikids_test`). Kỳ cố định 6/2026.
 * Bất biến kiểm: tiền vào = ĐƠN ĐÃ GIAO (COMPLETED); PENDING/SHIPPING = đang
 * chờ (KHÔNG vào số dư); tiền ra GỒM Nhập hàng (purchase); GMV gồm cả đơn hủy.
 */

const RANGE = { from: new Date(2026, 5, 1), to: new Date(2026, 5, 30) };
const IN_RANGE = new Date(2026, 5, 15);

beforeAll(async () => {
  await seedReference();
}, 60_000);

beforeEach(async () => {
  await truncateBusinessTables();
});

afterAll(async () => {
  await prisma.$disconnect();
});

async function seed(): Promise<void> {
  await prisma.expense.createMany({
    data: [
      { date: IN_RANGE, categoryId: "purchase", description: "Nhập hàng", amount: 5_000_000, source: "MANUAL" },
      { date: IN_RANGE, categoryId: "ads", description: "Meta Ads", amount: 2_000_000, source: "ADS_API", adsSource: "META" },
    ],
  });
  await prisma.order.createMany({
    data: [
      {
        pancakeId: "CF-COMPLETED", code: "C1", channelId: "shopee", status: "COMPLETED",
        orderedAt: IN_RANGE, syncedAt: IN_RANGE, itemsTotal: 500_000, discount: 20_000, platformFeeEst: 62_500,
      },
      {
        pancakeId: "CF-SHIPPING", code: "C2", channelId: "shopee", status: "SHIPPING",
        orderedAt: IN_RANGE, syncedAt: IN_RANGE, itemsTotal: 300_000, discount: 0, platformFeeEst: 30_000,
      },
      {
        pancakeId: "CF-CANCELLED", code: "C3", channelId: "shopee", status: "CANCELLED",
        orderedAt: IN_RANGE, syncedAt: IN_RANGE, itemsTotal: 999_000, discount: 0, platformFeeEst: 0,
      },
    ],
  });
}

describe("computeCashFlow — dòng tiền dự kiến", () => {
  it("vào = COMPLETED; đang chờ = SHIPPING; ra gồm Nhập hàng; số dư & actualIn", async () => {
    await seed();
    const cf = await computeCashFlow(RANGE);

    expect(cf.expectedIn).toBe(417_500); // 500.000 − 62.500 − 20.000 (chỉ COMPLETED)
    expect(cf.pendingIn).toBe(270_000); // 300.000 − 30.000 (SHIPPING; CANCELLED bị loại)
    expect(cf.pendingCount).toBe(1);
    expect(cf.cashOut).toBe(7_000_000); // Nhập hàng 5tr + ads 2tr (GỒM Nhập hàng)
    expect(cf.balance).toBe(417_500 - 7_000_000);
    expect(cf.otherIn).toBe(0); // kỳ chưa ghi khoản tiền khác nào
    expect(cf.otherOut).toBe(0);
    expect(cf.otherByKind).toEqual([]);
    expect(cf.actualIn.tiktok).toBeNull();
    expect(cf.actualIn.shopee).toBeNull();
    expect(cf.outBreakdown.some((b) => b.categoryId === "purchase")).toBe(true);
  });

  it("lãi sổ tiết kiệm đã nhận LÀM TĂNG chênh lệch trong tháng (tiền thật, không phải số dự kiến)", async () => {
    await seed();
    await prisma.thuNhap.createMany({
      data: [
        { date: IN_RANGE, kind: "LAI_TIET_KIEM", amount: 2_000_000, description: "Lãi sổ 6 tháng" },
        { date: new Date(2026, 6, 2), kind: "LAI_TIET_KIEM", amount: 9_000_000, description: "Tháng sau" },
      ],
    });

    const cf = await computeCashFlow(RANGE);
    expect(cf.thuNhapTaiChinh).toBe(2_000_000); // dòng ngoài kỳ KHÔNG lọt
    expect(cf.balance).toBe(417_500 + 2_000_000 - 7_000_000);
    // Không đụng các vế khác: lãi đi đường riêng, KHÔNG được gộp vào "vào khác" (ghi tay) hay
    // "thu dự kiến" (tiền sàn) — gộp là đếm hai lần ở tab Dòng tiền.
    expect(cf.otherIn).toBe(0);
    expect(cf.expectedIn).toBe(417_500);
  });

  it("kỳ không có lãi → thuNhapTaiChinh 0, số dư y hệt trước khi có tính năng", async () => {
    await seed();
    const cf = await computeCashFlow(RANGE);
    expect(cf.thuNhapTaiChinh).toBe(0);
    expect(cf.balance).toBe(417_500 - 7_000_000);
  });
});

describe("sumGmv — doanh số", () => {
  it("gồm MỌI đơn kể cả hủy (khác doanh thu)", async () => {
    await seed();
    // 500.000 + 300.000 + 999.000 (cancelled) = 1.799.000
    expect(await sumGmv(RANGE)).toBe(1_799_000);
  });
});

describe("computeCashFlow — actualIn (Tiền đã về TikTok)", () => {
  it("net + adsDeducted(|Σ|) + bankPaid(chỉ PAID); độc lập expectedIn/cashOut", async () => {
    await prisma.tiktokSettlement.createMany({
      data: [
        { statementId: "S1", shopId: "T", statementTime: IN_RANGE, paymentStatus: "SETTLED", settlementAmount: 1_000_000, revenueAmount: 0, feeAmount: 0, adjustmentAmount: 0, netSalesAmount: 0, shippingCostAmount: 0 },
        { statementId: "S2", shopId: "T", statementTime: IN_RANGE, paymentStatus: "SETTLED", settlementAmount: 500_000, revenueAmount: 0, feeAmount: 0, adjustmentAmount: 0, netSalesAmount: 0, shippingCostAmount: 0 },
      ],
    });
    await prisma.tiktokAdsSettlement.create({
      data: { transactionId: "A1", shopId: "T", orderCreateTime: IN_RANGE, settlementAmount: -200_000 },
    });
    await prisma.tiktokPayment.createMany({
      data: [
        { paymentId: "P1", shopId: "T", status: "PAID", paidTime: IN_RANGE, settlementValue: 1_800_000, amountValue: 1_800_000 },
        { paymentId: "P2", shopId: "T", status: "FAILED", paidTime: IN_RANGE, settlementValue: 999_000, amountValue: 999_000 }, // loại (không PAID)
      ],
    });

    const cf = await computeCashFlow(RANGE);
    expect(cf.actualIn.tiktok).not.toBeNull();
    expect(cf.actualIn.tiktok!.net).toBe(1_500_000);
    expect(cf.actualIn.tiktok!.adsDeducted).toBe(200_000); // |Σ ads| (âm → dương)
    expect(cf.actualIn.tiktok!.bankPaid).toBe(1_800_000); // chỉ PAID
    expect(cf.actualIn.tiktok!.channel).toBe("tiktok");
    expect(cf.actualIn.shopee).toBeNull(); // không seed Shopee → độc lập kênh
    // Độc lập P&L: không seed đơn/chi phí → expectedIn/cashOut = 0, không bị settlement chạm
    expect(cf.expectedIn).toBe(0);
    expect(cf.cashOut).toBe(0);
  });

  it("kỳ 0 settlement → cả 2 kênh null (Sắp có)", async () => {
    const cf = await computeCashFlow(RANGE);
    expect(cf.actualIn.tiktok).toBeNull();
    expect(cf.actualIn.shopee).toBeNull();
  });
});

describe("computeCashFlow — actualIn.shopee (Tiền đã về ví Shopee)", () => {
  it("net gộp REVENUE+ADJUSTMENT (hoàn âm tự giảm) + withdrawn; độc lập tiktok/P&L", async () => {
    await prisma.shopeeSettlement.createMany({
      data: [
        { externalId: "SP-REV1", shopId: "1942992175", txnTime: IN_RANGE, type: "REVENUE", orderCode: "O1", amount: 503_310, status: "ok", runningBalance: 0 },
        // REVENUE nhưng "Tiền ra" (case F2) — amount ÂM, gộp vào net.
        { externalId: "SP-REV2", shopId: "1942992175", txnTime: IN_RANGE, type: "REVENUE", orderCode: "O2", amount: -1_620, status: "ok", runningBalance: 0 },
        { externalId: "SP-ADJ1", shopId: "1942992175", txnTime: IN_RANGE, type: "ADJUSTMENT", orderCode: "O3", amount: -172_007, status: "ok", runningBalance: 0 },
        { externalId: "SP-WD1", shopId: "1942992175", txnTime: IN_RANGE, type: "WITHDRAWAL", orderCode: null, amount: -2_097_069, status: "ok", runningBalance: 0 },
      ],
    });

    const cf = await computeCashFlow(RANGE);
    expect(cf.actualIn.shopee).not.toBeNull();
    // net = 503.310 − 1.620 − 172.007 = 329.683 (hoàn/điều chỉnh âm tự trừ)
    expect(cf.actualIn.shopee!.net).toBe(329_683);
    expect(cf.actualIn.shopee!.withdrawn).toBe(2_097_069); // |Σ WITHDRAWAL|
    expect(cf.actualIn.shopee!.channel).toBe("shopee");
    expect(cf.actualIn.shopee!.unclassifiedCount).toBe(0); // không seed OTHER
    expect(cf.actualIn.tiktok).toBeNull(); // không seed TikTok → độc lập kênh
    // Độc lập P&L: WITHDRAWAL không chạm expectedIn/cashOut
    expect(cf.expectedIn).toBe(0);
    expect(cf.cashOut).toBe(0);
  });

  it("dòng OTHER (nhãn lạ) KHÔNG cộng vào net nhưng ĐẾM để cảnh báo (chống undercount âm thầm)", async () => {
    await prisma.shopeeSettlement.createMany({
      data: [
        { externalId: "SP-REV-X", shopId: "1942992175", txnTime: IN_RANGE, type: "REVENUE", orderCode: "OX", amount: 100_000, status: "ok", runningBalance: 0 },
        { externalId: "SP-OTHER1", shopId: "1942992175", txnTime: IN_RANGE, type: "OTHER", orderCode: null, amount: 50_000, status: "ok", runningBalance: 0 },
        { externalId: "SP-OTHER2", shopId: "1942992175", txnTime: IN_RANGE, type: "OTHER", orderCode: null, amount: 7_000, status: "ok", runningBalance: 0 },
      ],
    });

    const cf = await computeCashFlow(RANGE);
    expect(cf.actualIn.shopee).not.toBeNull();
    expect(cf.actualIn.shopee!.net).toBe(100_000); // OTHER KHÔNG cộng vào net
    expect(cf.actualIn.shopee!.unclassifiedCount).toBe(2);
    expect(cf.actualIn.shopee!.unclassifiedAmount).toBe(57_000);
  });

  it("kỳ CHỈ có OTHER (net/withdrawn=0) vẫn HIỆN card để cảnh báo, không ẩn im", async () => {
    await prisma.shopeeSettlement.create({
      data: { externalId: "SP-ONLY-OTHER", shopId: "1942992175", txnTime: IN_RANGE, type: "OTHER", orderCode: null, amount: 12_345, status: "ok", runningBalance: 0 },
    });

    const cf = await computeCashFlow(RANGE);
    expect(cf.actualIn.shopee).not.toBeNull(); // KHÔNG null dù net=0 → card hiện cảnh báo
    expect(cf.actualIn.shopee!.net).toBe(0);
    expect(cf.actualIn.shopee!.unclassifiedCount).toBe(1);
  });
});

describe("computeCashFlow — khoản tiền khác ghi tay (CashMovement)", () => {
  it("vào khác/ra khác theo kỳ, số dư cộng-trừ đúng; bảng Lãi/Lỗ KHÔNG đổi một đồng", async () => {
    await seed();
    const pnlTruoc = await calcPnl(RANGE);

    // Dòng LOAN_IN/LOAN_REPAY BẮT BUỘC gắn khoản vay (CHECK `CashMovement_loan_bat_buoc`).
    const loan = await prisma.loan.create({
      data: { name: "Vay Techcombank", startDate: IN_RANGE },
    });

    await prisma.cashMovement.createMany({
      data: [
        { date: IN_RANGE, kind: "LOAN_IN", amount: 100_000_000, description: "Vay Techcombank", loanId: loan.id },
        // Bán trực tiếp: tiền vào THẬT nhưng KHÔNG phải doanh thu sàn — phép kiểm P&L-không-đổi dưới
        // đây chỉ có nghĩa khi kỳ có sẵn một loại dễ bị nhầm là doanh thu.
        { date: IN_RANGE, kind: "DIRECT_SALE", amount: 3_000_000, description: "Bán tại nhà" },
        { date: IN_RANGE, kind: "LOAN_REPAY", amount: 20_000_000, description: "Trả gốc kỳ 1", loanId: loan.id },
        { date: new Date(2026, 6, 1), kind: "CAPITAL_IN", amount: 5_000_000, description: "NGOÀI kỳ" },
      ],
    });

    const cf = await computeCashFlow(RANGE);
    expect(cf.otherIn).toBe(103_000_000);
    expect(cf.otherOut).toBe(20_000_000);
    expect(cf.otherByKind.map((b) => [b.kind, b.amount])).toEqual([
      ["LOAN_IN", 100_000_000],
      ["DIRECT_SALE", 3_000_000],
      ["LOAN_REPAY", 20_000_000],
    ]);
    // Các số cũ KHÔNG đổi — khoản tiền khác không chạm thu dự kiến / chi thật / tiền đã về.
    expect(cf.expectedIn).toBe(417_500);
    expect(cf.pendingIn).toBe(270_000);
    expect(cf.cashOut).toBe(7_000_000);
    expect(cf.actualIn.tiktok).toBeNull();
    // Số dư = thu dự kiến + vào khác − chi thật − ra khác
    expect(cf.balance).toBe(417_500 + 103_000_000 - 7_000_000 - 20_000_000);

    // Bất biến #1: P&L đo SAU khi seed 3 khoản phải bằng TRƯỚC từng field.
    expect(await calcPnl(RANGE)).toEqual(pnlTruoc);
  });

  it("chỉ có chiều RA trong kỳ → số dư giảm đúng số đó", async () => {
    await seed();
    await prisma.cashMovement.create({
      data: { date: IN_RANGE, kind: "CAPITAL_OUT", amount: 1_500_000, description: "Rút về túi" },
    });
    const cf = await computeCashFlow(RANGE);
    expect(cf.otherIn).toBe(0);
    expect(cf.otherOut).toBe(1_500_000);
    expect(cf.balance).toBe(417_500 - 7_000_000 - 1_500_000);
  });
});

/**
 * Hai trục tách bạch, đo TRÊN DB THẬT (fixture thuần ở `tests/pnl.test.ts` không chạm Prisma
 * nên không chứng minh được đường ghi thật): tiền GỐC vay/trả gốc chỉ là dòng tiền — bảng
 * Lãi/Lỗ không được nhúc nhích một đồng; còn LÃI vay đi đường `Expense` danh mục `interest`
 * thì PHẢI trừ vào lãi ròng, mà KHÔNG được đụng doanh thu.
 */
describe("Khoản vay — gốc KHÔNG vào P&L, lãi vay CÓ (danh mục interest)", () => {
  it("LOAN_IN 300tr + LOAN_REPAY 50tr: P&L y nguyên từng field; thêm lãi vay 2.625.000 ⇒ chỉ netProfit giảm đúng số đó", async () => {
    await seed();
    const pnlTruoc = await calcPnl(RANGE);
    // Non-vacuity: kỳ này thật sự có số để mà lệch, không phải so 0 với 0.
    expect(pnlTruoc.revenue).toBeGreaterThan(0);
    expect(pnlTruoc.interest).toBe(0);

    // `firstDueDate`/`termMonths` cùng NULL (CHECK `Loan_lich_du_doi`); LOAN_IN/LOAN_REPAY
    // bắt buộc `loanId` (CHECK `CashMovement_loan_bat_buoc`).
    const loan = await prisma.loan.create({
      data: { name: "Vay VPBank", startDate: IN_RANGE },
    });
    await prisma.cashMovement.createMany({
      data: [
        { date: IN_RANGE, kind: "LOAN_IN", amount: 300_000_000, description: "Giải ngân", loanId: loan.id },
        { date: IN_RANGE, kind: "LOAN_REPAY", amount: 50_000_000, description: "Trả gốc kỳ 1", loanId: loan.id },
      ],
    });
    expect(await calcPnl(RANGE)).toEqual(pnlTruoc);

    await prisma.expense.create({
      data: {
        categoryId: "interest",
        amount: 2_625_000,
        date: IN_RANGE,
        description: "Lãi vay kỳ 1",
        source: "MANUAL",
      },
    });
    const pnlSau = await calcPnl(RANGE);
    expect(pnlSau.interest).toBe(2_625_000);
    expect(pnlSau.other).toBe(pnlTruoc.other); // KHÔNG rơi vào "Khác"
    expect(pnlSau.netProfit).toBe(pnlTruoc.netProfit - 2_625_000);
    // Lãi vay là chi phí, KHÔNG phải khoản giảm doanh thu.
    expect(pnlSau.revenue).toBe(pnlTruoc.revenue);
    expect(pnlSau.netRevenue).toBe(pnlTruoc.netRevenue);
    expect(pnlSau.grossProfit).toBe(pnlTruoc.grossProfit);
  });
});
