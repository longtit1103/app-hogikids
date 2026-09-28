import type { Prisma } from "@prisma/client";
import { startOfDay } from "date-fns";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { prisma } from "@/lib/prisma";
import { seedReference, truncateBusinessTables } from "./helpers/test-db";

/**
 * Integration test (`hogikids_test`) cho NỀN DỮ LIỆU sổ tiết kiệm sinh lãi: 2 giá trị enum dòng tiền
 * mới, 2 bảng mới (`SoTietKiem`, `ThuNhap`), cột `CashMovement.savingsId`, và TỪNG CHECK dưới DB.
 *
 * Vì sao kiểm CHECK ở tầng DB chứ không chỉ zod: zod là lớp MỘT (chặn form), còn script/psql/ingest
 * đi thẳng Prisma thì không qua zod. `Expense` hiện chỉ chặn `amount > 0` ở zod nên đường ingest ads
 * đi vòng qua được — bảng mới không lặp lại lỗ hổng đó.
 */
const ngayVn = (ngay: string) => startOfDay(new Date(`${ngay}T00:00:00+07:00`));

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

describe("enum CashMovementKind — 2 loại dòng tiền tiết kiệm sinh lãi", () => {
  it("Postgres có SAVINGS_OUT và SAVINGS_IN, nối vào CUỐI danh sách", async () => {
    const rows = await prisma.$queryRaw<{ kind: string }[]>`
      SELECT unnest(enum_range(NULL::"CashMovementKind"))::text AS kind
    `;
    const kinds = rows.map((r) => r.kind);
    expect(kinds).toEqual([
      "LOAN_IN", "CAPITAL_IN", "DIRECT_SALE", "OTHER_IN", "LOAN_REPAY", "CAPITAL_OUT",
      "DEPOSIT_OUT", "DEPOSIT_IN", "SAVINGS_OUT", "SAVINGS_IN",
    ]);
  });
});

/** Sổ hợp lệ dùng lại nhiều ca: 200tr, gửi 10/09/2026, kỳ hạn 6 tháng, 5,2%/năm (520 bp). */
async function taoSoHopLe(sua: Partial<Prisma.SoTietKiemUncheckedCreateInput> = {}) {
  return prisma.soTietKiem.create({
    data: {
      name: "Sổ 6 tháng VCB",
      bank: "Vietcombank",
      principal: 200_000_000,
      startDate: ngayVn("2026-09-10"),
      termMonths: 6,
      maturityDate: ngayVn("2027-03-10"),
      annualRateBp: 520,
      ...sua,
    },
  });
}

describe("bảng SoTietKiem + ThuNhap — ca HỢP LỆ (chống xanh giả: CHECK không được chặn nhầm)", () => {
  it("ghi được sổ + dòng SAVINGS_OUT + ThuNhap lãi, đọc lại đúng từng field", async () => {
    const so = await taoSoHopLe();
    await prisma.cashMovement.create({
      data: {
        date: ngayVn("2026-09-10"),
        kind: "SAVINGS_OUT",
        amount: 200_000_000,
        description: "Gửi sổ 6 tháng VCB",
        savingsId: so.id,
      },
    });
    await prisma.thuNhap.create({
      data: {
        date: ngayVn("2027-03-10"),
        kind: "LAI_TIET_KIEM",
        amount: 5_200_000,
        description: "Lãi sổ 6 tháng VCB",
        savingsId: so.id,
        refId: `TIETKIEM:${so.id}`,
      },
    });

    const doc = await prisma.soTietKiem.findUniqueOrThrow({
      where: { id: so.id },
      include: { movements: true, thuNhap: true },
    });
    expect(doc.principal).toBe(200_000_000);
    expect(doc.termMonths).toBe(6);
    expect(doc.annualRateBp).toBe(520);
    expect(doc.maturityDate).toEqual(ngayVn("2027-03-10"));
    expect(doc.closedAt).toBeNull();
    expect(doc.loanId).toBeNull();
    expect(doc.bank).toBe("Vietcombank");
    expect(doc.movements.map((m) => [m.kind, m.amount])).toEqual([["SAVINGS_OUT", 200_000_000]]);
    expect(doc.thuNhap.map((t) => [t.kind, t.amount, t.refId])).toEqual([
      ["LAI_TIET_KIEM", 5_200_000, `TIETKIEM:${so.id}`],
    ]);
  });

  it("refId @unique chặn ghi lãi lần hai cho cùng một sổ", async () => {
    const so = await taoSoHopLe();
    const lai = {
      date: ngayVn("2027-03-10"),
      kind: "LAI_TIET_KIEM" as const,
      amount: 5_200_000,
      savingsId: so.id,
      refId: `TIETKIEM:${so.id}`,
    };
    await prisma.thuNhap.create({ data: lai });
    await expect(prisma.thuNhap.create({ data: lai })).rejects.toThrow(/Unique constraint/i);
    expect(await prisma.thuNhap.count()).toBe(1);
  });

  // onDelete: SetNull là CỐ Ý (spec §5.1): liên kết chỉ để SO lãi vay-để-gửi, không mang đồng nào.
  // Restrict sẽ làm kẹt xoaKhoanVay trong khi menu ⋯ vẫn hứa "xoá được".
  it("xoá khoản vay nguồn ⇒ loanId của sổ về NULL, sổ còn nguyên", async () => {
    const loan = await prisma.loan.create({
      data: { name: "Vay Techcombank", startDate: ngayVn("2026-09-01") },
    });
    const so = await taoSoHopLe({ loanId: loan.id });
    await prisma.loan.delete({ where: { id: loan.id } });

    const doc = await prisma.soTietKiem.findUniqueOrThrow({ where: { id: so.id } });
    expect(doc.loanId).toBeNull();
    expect(doc.principal).toBe(200_000_000);
  });
});

describe("CHECK dưới DB — đủ 8 constraint đúng tên", () => {
  // Lưới chống "ai đó gỡ một CHECK mà không test nào đỏ": tên constraint là hợp đồng công khai,
  // Phase 03/04 khoá theo tên trong thông báo lỗi.
  it("pg_constraint liệt kê đủ 8 CHECK của sổ tiết kiệm", async () => {
    const rows = await prisma.$queryRaw<{ conname: string }[]>`
      SELECT c.conname::text AS conname
      FROM pg_constraint c
      JOIN pg_class t ON t.oid = c.conrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
      WHERE c.contype = 'c'
        AND n.nspname = 'app'
        AND t.relname IN ('SoTietKiem', 'ThuNhap', 'CashMovement')
    `;
    expect(rows.map((r) => r.conname).sort()).toEqual(
      expect.arrayContaining([
        "CashMovement_loan_savings_loai_tru",
        "CashMovement_savings_bat_buoc",
        "CashMovement_savings_dung_cho",
        "SoTietKiem_annualRateBp_khong_am",
        "SoTietKiem_dao_han_sau_ngay_gui",
        "SoTietKiem_principal_duong",
        "SoTietKiem_termMonths_duong",
        "ThuNhap_amount_duong",
      ]),
    );
  });
});

describe("CHECK dưới DB — SoTietKiem", () => {
  it("principal = 0 bị từ chối (SoTietKiem_principal_duong)", async () => {
    await expect(taoSoHopLe({ principal: 0 })).rejects.toThrow(/SoTietKiem_principal_duong/);
    expect(await prisma.soTietKiem.count()).toBe(0);
  });

  it("principal âm bị từ chối (SoTietKiem_principal_duong)", async () => {
    await expect(taoSoHopLe({ principal: -1 })).rejects.toThrow(/SoTietKiem_principal_duong/);
    expect(await prisma.soTietKiem.count()).toBe(0);
  });

  it("termMonths = 0 bị từ chối (SoTietKiem_termMonths_duong)", async () => {
    await expect(taoSoHopLe({ termMonths: 0 })).rejects.toThrow(/SoTietKiem_termMonths_duong/);
    expect(await prisma.soTietKiem.count()).toBe(0);
  });

  it("annualRateBp âm bị từ chối (SoTietKiem_annualRateBp_khong_am)", async () => {
    await expect(taoSoHopLe({ annualRateBp: -1 })).rejects.toThrow(
      /SoTietKiem_annualRateBp_khong_am/,
    );
    expect(await prisma.soTietKiem.count()).toBe(0);
  });

  // Lãi suất 0 là ca HỢP LỆ (gửi giữ hộ, không lấy lãi) — chặn nhầm là cắt mất một tình huống thật.
  it("annualRateBp = 0 vẫn ghi được", async () => {
    const so = await taoSoHopLe({ annualRateBp: 0 });
    expect(so.annualRateBp).toBe(0);
  });

  it("maturityDate = startDate bị từ chối (SoTietKiem_dao_han_sau_ngay_gui)", async () => {
    await expect(taoSoHopLe({ maturityDate: ngayVn("2026-09-10") })).rejects.toThrow(
      /SoTietKiem_dao_han_sau_ngay_gui/,
    );
    expect(await prisma.soTietKiem.count()).toBe(0);
  });

  it("maturityDate trước startDate bị từ chối (SoTietKiem_dao_han_sau_ngay_gui)", async () => {
    await expect(taoSoHopLe({ maturityDate: ngayVn("2026-09-09") })).rejects.toThrow(
      /SoTietKiem_dao_han_sau_ngay_gui/,
    );
    expect(await prisma.soTietKiem.count()).toBe(0);
  });
});

describe("CHECK dưới DB — ThuNhap", () => {
  it("amount = 0 bị từ chối (ThuNhap_amount_duong)", async () => {
    const so = await taoSoHopLe();
    await expect(
      prisma.thuNhap.create({
        data: { date: ngayVn("2027-03-10"), kind: "LAI_TIET_KIEM", amount: 0, savingsId: so.id },
      }),
    ).rejects.toThrow(/ThuNhap_amount_duong/);
    expect(await prisma.thuNhap.count()).toBe(0);
  });

  it("amount âm bị từ chối (ThuNhap_amount_duong)", async () => {
    const so = await taoSoHopLe();
    await expect(
      prisma.thuNhap.create({
        data: { date: ngayVn("2027-03-10"), kind: "LAI_TIET_KIEM", amount: -1, savingsId: so.id },
      }),
    ).rejects.toThrow(/ThuNhap_amount_duong/);
    expect(await prisma.thuNhap.count()).toBe(0);
  });
});

describe("CHECK dưới DB — CashMovement gắn sổ tiết kiệm", () => {
  it("SAVINGS_OUT thiếu savingsId bị từ chối (CashMovement_savings_bat_buoc)", async () => {
    await expect(
      prisma.cashMovement.create({
        data: { date: ngayVn("2026-09-10"), kind: "SAVINGS_OUT", amount: 200_000_000 },
      }),
    ).rejects.toThrow(/CashMovement_savings_bat_buoc/);
    expect(await prisma.cashMovement.count()).toBe(0);
  });

  it("SAVINGS_IN thiếu savingsId bị từ chối (CashMovement_savings_bat_buoc)", async () => {
    await expect(
      prisma.cashMovement.create({
        data: { date: ngayVn("2027-03-10"), kind: "SAVINGS_IN", amount: 200_000_000 },
      }),
    ).rejects.toThrow(/CashMovement_savings_bat_buoc/);
    expect(await prisma.cashMovement.count()).toBe(0);
  });

  it("savingsId gắn vào loại KHÁC bị từ chối (CashMovement_savings_dung_cho)", async () => {
    const so = await taoSoHopLe();
    await expect(
      prisma.cashMovement.create({
        data: {
          date: ngayVn("2026-09-10"),
          kind: "CAPITAL_OUT",
          amount: 1_000_000,
          savingsId: so.id,
        },
      }),
    ).rejects.toThrow(/CashMovement_savings_dung_cho/);
    expect(await prisma.cashMovement.count()).toBe(0);
  });

  it("loanId và savingsId cùng khác NULL bị từ chối (CashMovement_loan_savings_loai_tru)", async () => {
    const loan = await prisma.loan.create({
      data: { name: "Vay Techcombank", startDate: ngayVn("2026-09-01") },
    });
    const so = await taoSoHopLe();
    await expect(
      prisma.cashMovement.create({
        data: {
          date: ngayVn("2027-03-10"),
          kind: "SAVINGS_IN",
          amount: 200_000_000,
          loanId: loan.id,
          savingsId: so.id,
        },
      }),
    ).rejects.toThrow(/CashMovement_loan_savings_loai_tru/);
    expect(await prisma.cashMovement.count()).toBe(0);
  });
});

describe("truncateBusinessTables — dọn cả 2 bảng mới, đúng thứ tự con-trước-cha", () => {
  it("xoá sạch ThuNhap + CashMovement + SoTietKiem + Loan, không vướng FK Restrict", async () => {
    const loan = await prisma.loan.create({
      data: { name: "Vay Techcombank", startDate: ngayVn("2026-09-01") },
    });
    const so = await taoSoHopLe({ loanId: loan.id });
    await prisma.cashMovement.create({
      data: {
        date: ngayVn("2026-09-10"),
        kind: "SAVINGS_OUT",
        amount: 200_000_000,
        savingsId: so.id,
      },
    });
    await prisma.thuNhap.create({
      data: {
        date: ngayVn("2027-03-10"),
        kind: "LAI_TIET_KIEM",
        amount: 5_200_000,
        savingsId: so.id,
        refId: `TIETKIEM:${so.id}`,
      },
    });

    await truncateBusinessTables();

    expect(await prisma.thuNhap.count()).toBe(0);
    expect(await prisma.cashMovement.count()).toBe(0);
    expect(await prisma.soTietKiem.count()).toBe(0);
    expect(await prisma.loan.count()).toBe(0);
  });
});
