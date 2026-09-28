import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { getCashMovementSummary, listCashMovements } from "@/lib/cash-movements/cash-movement-queries";
import { prisma } from "@/lib/prisma";
import { seedReference, truncateBusinessTables } from "./helpers/test-db";

/**
 * Integration test (`hogikids_test`) cho query "khoản tiền khác". Kỳ cố định 6/2026 — cùng RANGE với
 * cash-flow.test.ts. Khoá: biên phải endOfDay (dòng 23:30 ngày 30/06 vẫn thuộc kỳ), ngoài kỳ bị loại,
 * byKind chỉ có loại phát sinh và sắp VÀO trước RA, list sắp date desc, CHECK DB chặn amount ≤ 0.
 */
const RANGE = { from: new Date(2026, 5, 1), to: new Date(2026, 5, 30) };

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

async function seed(): Promise<void> {
  // Dòng LOAN_IN/LOAN_REPAY BẮT BUỘC gắn khoản vay (CHECK `CashMovement_loan_bat_buoc`).
  const loan = await prisma.loan.create({
    data: { name: "Vay Techcombank", startDate: new Date(2026, 5, 15) },
  });
  await prisma.cashMovement.createMany({
    data: [
      { date: new Date(2026, 5, 15), kind: "LOAN_IN", amount: 100_000_000, description: "Vay Techcombank", loanId: loan.id },
      { date: new Date(2026, 5, 20), kind: "LOAN_REPAY", amount: 20_000_000, description: "Trả gốc kỳ 1", loanId: loan.id },
      { date: new Date(2026, 5, 30, 23, 30), kind: "DIRECT_SALE", amount: 3_000_000, description: "Bán tại nhà" },
      { date: new Date(2026, 6, 1), kind: "CAPITAL_IN", amount: 5_000_000, description: "NGOÀI kỳ (01/07)" },
    ],
  });

  // Sổ tiết kiệm sinh lãi + dòng gửi của nó: bảng phải hiện thẳng TÊN SỔ, và form sửa cần `savingsId`.
  const so = await prisma.soTietKiem.create({
    data: {
      name: "Sổ 6 tháng VCB",
      bank: "Vietcombank",
      principal: 30_000_000,
      startDate: new Date(2026, 5, 18),
      termMonths: 6,
      maturityDate: new Date(2026, 11, 18),
      annualRateBp: 520,
    },
  });
  await prisma.cashMovement.create({
    data: {
      date: new Date(2026, 5, 18),
      kind: "SAVINGS_OUT",
      amount: 30_000_000,
      description: "Gửi tiết kiệm",
      savingsId: so.id,
    },
  });
}

describe("getCashMovementSummary", () => {
  it("tổng vào/ra theo kỳ (biên endOfDay), byKind chỉ loại phát sinh, VÀO trước RA, giảm dần", async () => {
    await seed();
    const s = await getCashMovementSummary(RANGE);
    expect(s.inTotal).toBe(103_000_000); // 100tr + 3tr (23:30 ngày 30/06 vẫn trong kỳ); 5tr ngày 01/07 bị loại
    // 20tr trả gốc + 30tr gửi tiết kiệm: tiền gửi RỜI quỹ thật (dù vẫn là tiền của shop) nên nó
    // thuộc vế RA y như mọi dòng OUT khác — số đó "về" lại quỹ khi tất toán, qua dòng SAVINGS_IN.
    expect(s.outTotal).toBe(50_000_000);
    expect(s.byKind.map((b) => [b.kind, b.direction, b.amount])).toEqual([
      ["LOAN_IN", "IN", 100_000_000],
      ["DIRECT_SALE", "IN", 3_000_000],
      ["SAVINGS_OUT", "OUT", 30_000_000],
      ["LOAN_REPAY", "OUT", 20_000_000],
    ]);
    expect(s.byKind[0].label).toBe("Vay vốn");
  });

  it("kỳ trống → 0/0/[]", async () => {
    const s = await getCashMovementSummary(RANGE);
    expect(s).toEqual({ inTotal: 0, outTotal: 0, byKind: [] });
  });
});

describe("listCashMovements", () => {
  it("chỉ dòng trong kỳ, sắp ngày giảm dần, đủ field hai trục", async () => {
    await seed();
    const rows = await listCashMovements(RANGE);
    expect(rows.map((r) => r.kind)).toEqual([
      "DIRECT_SALE",
      "LOAN_REPAY",
      "SAVINGS_OUT",
      "LOAN_IN",
    ]);
    expect(rows[3]).toMatchObject({ kind: "LOAN_IN", amount: 100_000_000, description: "Vay Techcombank" });
    expect(typeof rows[0].id).toBe("string");
    expect(rows[0].date).toBeInstanceOf(Date);
  });

  // Bảng hiện thẳng tên, khỏi bắt người đọc tra id; `savingsId` để form SỬA prefill đúng ô.
  it("dòng gắn sổ tiết kiệm mang savingsId + savingsName, dòng khác để null cả hai", async () => {
    await seed();
    const rows = await listCashMovements(RANGE);

    const gui = rows.find((r) => r.kind === "SAVINGS_OUT");
    expect(gui?.savingsName).toBe("Sổ 6 tháng VCB");
    expect(typeof gui?.savingsId).toBe("string");
    expect(gui?.loanId).toBeNull();

    const vay = rows.find((r) => r.kind === "LOAN_IN");
    expect(vay?.savingsId).toBeNull();
    expect(vay?.savingsName).toBeNull();
    expect(vay?.loanName).toBe("Vay Techcombank");
  });
});

describe("CHECK CashMovement_amount_duong (cổng DB)", () => {
  // Loại KHÔNG đòi `loanId` có chủ đích: dùng LOAN_* thì dòng bị chặn bởi CHECK khoản vay, phép kiểm
  // này thành xanh giả — gỡ CHECK amount đi vẫn không đỏ.
  it("amount 0 và âm bị Postgres từ chối dù đi vòng qua Prisma", async () => {
    await expect(
      prisma.cashMovement.create({ data: { date: new Date(2026, 5, 1), kind: "CAPITAL_IN", amount: 0 } }),
    ).rejects.toThrow();
    await expect(
      prisma.cashMovement.create({ data: { date: new Date(2026, 5, 1), kind: "CAPITAL_OUT", amount: -1 } }),
    ).rejects.toThrow();
    expect(await prisma.cashMovement.count()).toBe(0);
  });
});
