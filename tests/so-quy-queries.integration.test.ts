import { addMonths, endOfMonth, format, getDaysInMonth, setDate, startOfDay, startOfMonth, subMonths } from "date-fns";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { ngayDenHanDinhKy } from "@/lib/expenses/ensure-recurring-expenses";
import { prisma } from "@/lib/prisma";
import { demKhoanVayCoKyChoDuyet, listKhoanVay } from "@/lib/so-quy/khoan-vay-queries";
import { tinhSoQuyThang } from "@/lib/so-quy/so-quy-queries";
import { seedReference, truncateBusinessTables } from "./helpers/test-db";

/**
 * Integration sổ quỹ trên `hogikids_test` — fixture spec §6, ngày mở sổ D0 = 01/10/2026.
 *
 * Bất biến kiểm bằng số THẬT trong DB: `ĐẦU KỲ + THU − CHI = CUỐI KỲ`, `CUỐI KỲ(N) = ĐẦU KỲ(N+1)`,
 * tiền về TRƯỚC ngày mở sổ không được cộng, tháng trước D0 là "chưa có sổ" chứ không phải 0 đồng.
 */

const T10 = { from: new Date(2026, 9, 1), to: new Date(2026, 9, 31) };
const T11 = { from: new Date(2026, 10, 1), to: new Date(2026, 10, 30) };
const T9 = { from: new Date(2026, 8, 1), to: new Date(2026, 8, 30) };

/** Fixture §6 ⇒ QUY = 300 − 10 + 30 + 5 − 43 + 1,5 = 283,5tr. */
const QUY_T10 = 283_500_000;

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

async function seedFixture(): Promise<void> {
  // Dòng LOAN_IN BẮT BUỘC gắn khoản vay (CHECK `CashMovement_loan_bat_buoc`).
  const loan = await prisma.loan.create({
    data: {
      name: "Vay test",
      startDate: new Date(2026, 9, 2),
      annualRateBp: 1050,
      termMonths: 12,
      firstDueDate: new Date(2026, 10, 2),
    },
  });

  await prisma.cashMovement.createMany({
    data: [
      { date: new Date(2026, 9, 1), kind: "CAPITAL_IN", amount: 100_000_000, description: "Góp vốn mở sổ" },
      { date: new Date(2026, 9, 2), kind: "LOAN_IN", amount: 200_000_000, description: "Giải ngân", loanId: loan.id },
      { date: new Date(2026, 9, 20), kind: "CAPITAL_OUT", amount: 10_000_000, description: "Rút vốn" },
    ],
  });

  await prisma.tiktokPayment.createMany({
    data: [
      {
        paymentId: "sq-pay-t10",
        shopId: "100975192",
        status: "PAID",
        paidTime: new Date(2026, 9, 5),
        settlementValue: 30_000_000,
        amountValue: 30_000_000,
      },
      // TRƯỚC ngày mở sổ ⇒ KHÔNG được cộng vào quỹ.
      {
        paymentId: "sq-pay-truoc-d0",
        shopId: "100975192",
        status: "PAID",
        paidTime: new Date(2026, 8, 30),
        settlementValue: 77_000_000,
        amountValue: 77_000_000,
      },
      // TRONG kỳ nhưng KHÔNG trả thành công ⇒ tiền chưa về bank, KHÔNG được cộng. Thiếu ca này thì
      // bỏ lọc `status: "PAID"` ở bộ lọc chung vẫn xanh (mọi lệnh trong kỳ đều PAID sẵn).
      {
        paymentId: "sq-pay-failed-t10",
        shopId: "100975192",
        status: "FAILED",
        paidTime: new Date(2026, 9, 6),
        settlementValue: 99_000_000,
        amountValue: 99_000_000,
      },
    ],
  });

  await prisma.shopeeSettlement.create({
    data: {
      externalId: "sq-shopee-rut-1",
      shopId: "1942992175",
      txnTime: new Date(2026, 9, 6),
      type: "WITHDRAWAL",
      amount: -5_000_000, // CÓ DẤU: rút ví = âm
      status: "ok",
      runningBalance: 0,
    },
  });

  await prisma.expense.createMany({
    data: [
      { date: new Date(2026, 9, 7), categoryId: "ads", adsSource: "TIKTOK_ADS", description: "Ads TikTok", amount: 2_000_000, source: "MANUAL" },
      { date: new Date(2026, 9, 7), categoryId: "ads", adsSource: "META", description: "Ads Meta", amount: 1_000_000, source: "MANUAL" },
      { date: new Date(2026, 9, 9), categoryId: "purchase", description: "Nhập hàng", amount: 40_000_000, source: "MANUAL" },
    ],
  });

  await prisma.tiktokAdsSettlement.create({
    data: {
      transactionId: "sq-ads-1",
      shopId: "100975192",
      orderCreateTime: new Date(2026, 9, 8),
      settlementAmount: -1_500_000, // sàn trừ ví ⇒ lưu ÂM
    },
  });
}

/**
 * Một sổ tiết kiệm đã tất toán: GỐC ra bằng `SAVINGS_OUT`, về bằng `SAVINGS_IN` (hai dòng
 * `CashMovement`), còn LÃI đi đường riêng qua bảng `ThuNhap`. Ngày đáo hạn để xa — tất toán sớm là
 * rút trước hạn, quỹ đọc tiền y hệt nên không cần phân biệt ở đây.
 */
async function seedSoTietKiem(o: {
  ten: string;
  goc: number;
  ngayGui: Date;
  ngayTatToan: Date;
  lai: number;
}): Promise<void> {
  const so = await prisma.soTietKiem.create({
    data: {
      name: o.ten,
      bank: "VCB",
      principal: o.goc,
      startDate: o.ngayGui,
      termMonths: 6,
      maturityDate: new Date(2027, 3, 3),
      annualRateBp: 520,
      closedAt: o.ngayTatToan,
    },
  });
  await prisma.cashMovement.createMany({
    data: [
      { date: o.ngayGui, kind: "SAVINGS_OUT", amount: o.goc, description: "Gửi tiết kiệm", savingsId: so.id },
      { date: o.ngayTatToan, kind: "SAVINGS_IN", amount: o.goc, description: "Nhận lại gốc", savingsId: so.id },
    ],
  });
  await prisma.thuNhap.create({
    data: {
      date: o.ngayTatToan,
      kind: "LAI_TIET_KIEM",
      amount: o.lai,
      description: `Lãi ${o.ten}`,
      savingsId: so.id,
      refId: `TIETKIEM:${so.id}`,
    },
  });
}

describe("tinhSoQuyThang", () => {
  it("tháng mở sổ: đầu kỳ 0, cuối kỳ 283.500.000, thu − chi = cuối kỳ", async () => {
    await seedFixture();
    const r = await tinhSoQuyThang(T10);

    expect(r.d0).toEqual(new Date(2026, 9, 1));
    expect(r.truocMoSo).toBe(false);
    expect(r.dauKy).toBe(0);
    expect(r.cuoiKy).toBe(QUY_T10);
    expect(r.thu - r.chi).toBe(QUY_T10);
    expect(r.thu).toBe(336_500_000); // 300 + 30 + 5 (đảo dấu rút ví) + 1,5 (cộng lại ads trừ ví)
    expect(r.chi).toBe(53_000_000); // 10 rút vốn + 43 sổ chi phí
    expect(r.adsTiktok).toEqual({ soChiPhi: 2_000_000, sanTruVi: 1_500_000 });
  });

  it("tháng sau không có dòng mới: ĐẦU KỲ(11) = CUỐI KỲ(10), thu = chi = 0", async () => {
    await seedFixture();
    const r = await tinhSoQuyThang(T11);

    expect(r.dauKy).toBe(QUY_T10);
    expect(r.thu).toBe(0);
    expect(r.chi).toBe(0);
    expect(r.cuoiKy).toBe(QUY_T10);
  });

  it("tháng TRỌN trước ngày mở sổ ⇒ truocMoSo, mọi số 0 (chưa có sổ, không phải 0 đồng)", async () => {
    await seedFixture();
    const r = await tinhSoQuyThang(T9);

    expect(r.truocMoSo).toBe(true);
    expect(r.d0).toEqual(new Date(2026, 9, 1));
    expect(r).toMatchObject({ dauKy: 0, thu: 0, chi: 0, cuoiKy: 0 });
  });

  it("tất toán sổ tiết kiệm: gốc về bằng SAVINGS_IN, LÃI về bằng ThuNhap ⇒ quỹ tăng đủ cả hai", async () => {
    await seedFixture();
    await seedSoTietKiem({
      ten: "Sổ 6 tháng VCB",
      goc: 200_000_000,
      ngayGui: new Date(2026, 9, 3),
      ngayTatToan: new Date(2026, 9, 12),
      lai: 8_500_000,
    });

    const r = await tinhSoQuyThang(T10);
    expect(r.chi).toBe(53_000_000 + 200_000_000); // 200tr gửi đi là tiền RA thật
    expect(r.thu).toBe(336_500_000 + 200_000_000 + 8_500_000); // gốc nhận lại + lãi
    expect(r.dauKy + r.thu - r.chi).toBe(r.cuoiKy);
    // Gửi rồi nhận lại trong cùng kỳ ⇒ gốc triệt tiêu, quỹ chỉ dôi ra ĐÚNG phần lãi.
    expect(r.cuoiKy).toBe(QUY_T10 + 8_500_000);
  });

  it("lãi ghi 01/11 00:30 KHÔNG rơi vào tháng 10; ĐẦU KỲ(11) = CUỐI KỲ(10)", async () => {
    await seedFixture();
    await seedSoTietKiem({
      ten: "Sổ ngắn",
      goc: 60_000_000,
      ngayGui: new Date(2026, 9, 5),
      ngayTatToan: new Date(2026, 10, 1, 0, 30),
      lai: 3_000_000,
    });

    const t10 = await tinhSoQuyThang(T10);
    expect(t10.thu).toBe(336_500_000); // lãi tháng 11 không được lọt vào đây
    expect(t10.chi).toBe(53_000_000 + 60_000_000);
    expect(t10.cuoiKy).toBe(QUY_T10 - 60_000_000);

    const t11 = await tinhSoQuyThang(T11);
    expect(t11.dauKy).toBe(t10.cuoiKy);
    expect(t11.thu).toBe(60_000_000 + 3_000_000); // gốc nhận lại + lãi, cùng ngày 01/11
    expect(t11.chi).toBe(0);
    expect(t11.cuoiKy).toBe(QUY_T10 + 3_000_000);
  });

  it("chưa có dòng ghi tay nào ⇒ d0 = null, mọi số 0", async () => {
    const r = await tinhSoQuyThang(T10);

    expect(r.d0).toBeNull();
    expect(r).toMatchObject({ dauKy: 0, thu: 0, chi: 0, cuoiKy: 0, truocMoSo: false });
  });

  it("lệnh TikTok PAID thiếu ngày ⇒ cảnh báo đếm 1 (tiền đó chưa vào quỹ)", async () => {
    await seedFixture();
    await prisma.tiktokPayment.create({
      data: {
        paymentId: "sq-pay-thieu-ngay",
        shopId: "100975192",
        status: "PAID",
        paidTime: null,
        settlementValue: 9_000_000,
        amountValue: 9_000_000,
      },
    });

    const r = await tinhSoQuyThang(T10);
    expect(r.canhBao.tiktokPaidThieuNgay).toBe(1);
    expect(r.cuoiKy).toBe(QUY_T10); // thiếu ngày ⇒ không cộng
  });

  it("biên phải kỳ là endOfDay: 31/10 23:30 còn trong tháng 10, 01/11 00:30 rơi sang tháng 11", async () => {
    await seedFixture();
    // Hai mốc này là phép kiểm DUY NHẤT chạm `lte: endOfDay(den)` — đổi thành `lte: den` là đỏ.
    await prisma.tiktokPayment.createMany({
      data: [
        {
          paymentId: "sq-pay-bien-t10",
          shopId: "100975192",
          status: "PAID",
          paidTime: new Date(2026, 9, 31, 23, 30),
          settlementValue: 7_000_000,
          amountValue: 7_000_000,
        },
        {
          paymentId: "sq-pay-bien-t11",
          shopId: "100975192",
          status: "PAID",
          paidTime: new Date(2026, 10, 1, 0, 30),
          settlementValue: 3_000_000,
          amountValue: 3_000_000,
        },
      ],
    });

    const t10 = await tinhSoQuyThang(T10);
    expect(t10.thu).toBe(336_500_000 + 7_000_000);
    expect(t10.cuoiKy).toBe(QUY_T10 + 7_000_000);

    const t11 = await tinhSoQuyThang(T11);
    expect(t11.dauKy).toBe(t10.cuoiKy); // CUỐI KỲ(10) ≡ ĐẦU KỲ(11)
    expect(t11.thu).toBe(3_000_000);
    expect(t11.chi).toBe(0);
    expect(t11.cuoiKy).toBe(t10.cuoiKy + 3_000_000);
  });

  it("Shopee rút ví rồi đảo rút tháng sau: luỹ kế về 0, mỗi tháng vẫn cân", async () => {
    await prisma.cashMovement.create({
      data: { date: new Date(2026, 9, 1), kind: "CAPITAL_IN", amount: 50_000_000, description: "Góp vốn mở sổ" },
    });
    await prisma.shopeeSettlement.createMany({
      data: [
        { externalId: "sq-rut-t10", shopId: "1942992175", txnTime: new Date(2026, 9, 15), type: "WITHDRAWAL", amount: -10_000_000, status: "ok", runningBalance: 0 },
        // Dòng ĐẢO lệnh rút mang dấu DƯƠNG — tự trừ lại, không được Math.abs.
        { externalId: "sq-dao-rut-t11", shopId: "1942992175", txnTime: new Date(2026, 10, 5), type: "WITHDRAWAL", amount: 10_000_000, status: "ok", runningBalance: 0 },
      ],
    });

    const t10 = await tinhSoQuyThang(T10);
    expect(t10.dauKy + t10.thu - t10.chi).toBe(t10.cuoiKy);
    expect(t10.cuoiKy).toBe(60_000_000); // 50tr góp + 10tr rút ví về bank

    const t11 = await tinhSoQuyThang(T11);
    expect(t11.dauKy).toBe(t10.cuoiKy);
    expect(t11.chi).toBe(10_000_000);
    expect(t11.dauKy + t11.thu - t11.chi).toBe(t11.cuoiKy);
    expect(t11.cuoiKy).toBe(50_000_000); // đóng góp luỹ kế của ví Shopee = 0
  });

  it("khoản vay mang sang: duNoMoSo CHỈ vào dư nợ, KHÔNG vào quỹ", async () => {
    await prisma.loan.create({
      data: {
        name: "Vay có từ trước",
        startDate: new Date(2026, 9, 1),
        duNoMoSo: 200_000_000,
        annualRateBp: 1050,
        termMonths: 10,
        firstDueDate: new Date(2026, 9, 10),
      },
    });
    await prisma.cashMovement.create({
      data: { date: new Date(2026, 9, 1), kind: "CAPITAL_IN", amount: 50_000_000, description: "Góp vốn mở sổ" },
    });

    expect((await tinhSoQuyThang(T10)).cuoiKy).toBe(50_000_000);
    const rows = await listKhoanVay();
    expect(rows[0]).toMatchObject({ giaiNgan: 0, duNo: 200_000_000, coTraGoc: false });
  });

  it("ví Shopee chỉ có dữ liệu SAU ngày mở sổ ⇒ cảnh báo thiếu tiền rút trước đó", async () => {
    await seedFixture();
    const r = await tinhSoQuyThang(T10);

    expect(r.canhBao.shopeeViTuNgay).toEqual(new Date(2026, 9, 6));
    expect(r.canhBao.shopeeThieuTruocD0).toBe(true);
  });
});

/**
 * Khoản vay neo theo HÔM NAY (kỳ chờ duyệt đọc `new Date()`), không neo mốc cố định như phần trên —
 * suite phải xanh dù chạy lại sau nhiều tháng.
 */
async function seedKhoanVay(): Promise<{ giaiNganNgay: Date; kyDau: Date }> {
  const homNay = new Date();
  const giaiNganNgay = startOfDay(subMonths(homNay, 2));
  const kyDau = startOfDay(subMonths(homNay, 1));

  const dangVay = await prisma.loan.create({
    data: {
      name: "Vay VPBank",
      lender: "VPBank",
      startDate: giaiNganNgay,
      annualRateBp: 1050,
      termMonths: 12,
      firstDueDate: kyDau,
      lastDueHandled: kyDau, // kỳ 1 đã ghi ⇒ kỳ chờ duyệt phải là kỳ 2
    },
  });
  // Khoản đã tất toán, KHÔNG lịch trả ⇒ không bao giờ có kỳ chờ duyệt.
  await prisma.loan.create({ data: { name: "Vay cũ", startDate: giaiNganNgay, closedAt: homNay } });

  await prisma.cashMovement.createMany({
    data: [
      { date: giaiNganNgay, kind: "LOAN_IN", amount: 200_000_000, description: "Giải ngân", loanId: dangVay.id },
      { date: kyDau, kind: "LOAN_REPAY", amount: 16_666_667, description: "Trả gốc kỳ 1", loanId: dangVay.id },
    ],
  });
  return { giaiNganNgay, kyDau };
}

describe("tinhSoQuyThang — đơn bán trực tiếp", () => {
  /** Một đơn tối thiểu — chỉ các cột Sổ quỹ đọc + cột bắt buộc. */
  const don = (pancakeId: string, channelId: string, status: "COMPLETED" | "RETURNED" | "PENDING", orderedAt: Date, paidAtShop: number) => ({
    pancakeId,
    code: pancakeId,
    channelId,
    status,
    orderedAt,
    itemsTotal: 999_000_000, // CỐ Ý lệch số đã trả: quỹ phải đọc paidAtShop, KHÔNG đọc doanh thu
    paidAtShop,
    syncedAt: new Date(),
  });

  it("chỉ cộng paidAtShop của đơn direct COMPLETED trong kỳ; đơn sàn/hoàn/chưa giao/khác tháng không vào", async () => {
    await prisma.cashMovement.create({
      data: { date: new Date(2026, 9, 1), kind: "CAPITAL_IN", amount: 1_000_000, description: "Mở sổ" },
    });
    await prisma.order.createMany({
      data: [
        don("bt-1", "direct", "COMPLETED", new Date(2026, 9, 21, 12, 51), 410_000),
        don("bt-2", "direct", "COMPLETED", new Date(2026, 9, 21, 12, 55), 520_000),
        don("bt-hoan", "direct", "RETURNED", new Date(2026, 9, 22), 300_000),
        don("bt-cho", "direct", "PENDING", new Date(2026, 9, 23), 200_000),
        don("bt-t11", "direct", "COMPLETED", new Date(2026, 10, 1, 0, 30), 100_000),
        // Đơn sàn lỡ mang paidAtShop (không bao giờ xảy ra qua mapping) vẫn KHÔNG được vào quỹ.
        don("san-1", "tiktok", "COMPLETED", new Date(2026, 9, 21), 777_000),
      ],
    });

    const t10 = await tinhSoQuyThang(T10);
    expect(t10.thu).toBe(1_000_000 + 930_000);
    expect(t10.cuoiKy).toBe(1_930_000);

    const t11 = await tinhSoQuyThang(T11);
    expect(t11.dauKy).toBe(t10.cuoiKy);
    expect(t11.thu).toBe(100_000);
  });
});

describe("listKhoanVay / demKhoanVayCoKyChoDuyet", () => {
  it("dư nợ suy từ sổ; khoản còn hiệu lực xếp TRƯỚC khoản đã tất toán", async () => {
    await seedKhoanVay();
    const rows = await listKhoanVay();

    // Postgres xếp NULL cuối khi ASC — sai chỗ này là khoản đã tất toán nhảy lên đầu bảng.
    expect(rows.map((r) => r.name)).toEqual(["Vay VPBank", "Vay cũ"]);
    expect(rows[0]).toMatchObject({
      giaiNgan: 200_000_000,
      duNo: 183_333_333, // 200tr − 16.666.667 đã trả
      coTraGoc: true,
    });
    expect(rows[0].kyCho?.ky).toBe(2); // kỳ 1 đã đóng dấu `lastDueHandled`
    expect(rows[0].kyCho?.duNoDauKy).toBe(183_333_333);
    expect(rows[1]).toMatchObject({ giaiNgan: 0, duNo: 0, coTraGoc: false, kyCho: null });
  });

  it("đếm KHOẢN VAY có kỳ chờ duyệt: chỉ khoản còn hiệu lực CÓ lịch; không khoản nào ⇒ 0", async () => {
    expect(await demKhoanVayCoKyChoDuyet()).toBe(0);
    await seedKhoanVay();
    expect(await demKhoanVayCoKyChoDuyet()).toBe(1);
  });

  it("dòng LOAN_REPAY thiếu loanId bị Postgres từ chối (CHECK CashMovement_loan_bat_buoc)", async () => {
    await expect(
      prisma.cashMovement.create({
        data: { date: new Date(2026, 9, 10), kind: "LOAN_REPAY", amount: 1_000_000 },
      })
    ).rejects.toThrow();
  });
});

describe("tinhSoQuyThang — canhBao.dinhKyChuaGhi", () => {
  /**
   * Cảnh báo "khoản chi định kỳ chưa ghi" — CHỈ ĐỌC, không tự sinh Expense, không đổi số quỹ. Neo
   * mọi mốc theo HÔM NAY thật (không hardcode năm/tháng cụ thể) để suite luôn xanh bất kể ngày chạy —
   * cùng cách xử lý biên "chưa tới hạn" của `recurring-expenses.test.ts` (chọn ngày/tháng chắc chắn
   * tương lai thay vì giả định hôm nay là ngày nào).
   */
  const homNay = new Date();
  const thangHienTai = startOfMonth(homNay);
  const thangTruoc = subMonths(thangHienTai, 1);
  const thangMoSo = subMonths(thangHienTai, 2);
  const range = { from: thangHienTai, to: endOfMonth(thangHienTai) };

  async function moSo(ngay: Date): Promise<void> {
    await prisma.cashMovement.create({
      data: { date: ngay, kind: "CAPITAL_IN", amount: 1_000_000, description: "Mở sổ" },
    });
  }

  async function sinhExpenseDinhKy(recurringId: string, ngay: Date, amount: number): Promise<void> {
    await prisma.expense.create({
      data: { date: ngay, categoryId: "fixed", description: "x", amount, source: "RECURRING", recurringId },
    });
  }

  it("mẫu active, tháng đã có Expense sinh ⇒ không báo", async () => {
    await moSo(thangMoSo);
    const r = await prisma.recurringExpense.create({
      data: { categoryId: "fixed", amount: 500_000, dayOfMonth: 1, description: "Mặt bằng" },
    });
    // Sinh sẵn Expense cho ĐỦ 3 tháng trong cửa sổ [D0, hôm nay] — không tháng nào thiếu.
    for (const m of [thangMoSo, thangTruoc, thangHienTai]) await sinhExpenseDinhKy(r.id, m, 500_000);

    const soQuy = await tinhSoQuyThang(range);
    expect(soQuy.canhBao.dinhKyChuaGhi).toEqual({ soKhoan: 0, thang: [], khoang: null });
  });

  it("tháng đến hạn chưa sinh Expense ⇒ báo đúng tháng + đúng số", async () => {
    await moSo(thangMoSo);
    const r = await prisma.recurringExpense.create({
      data: { categoryId: "fixed", amount: 500_000, dayOfMonth: 1, description: "Mặt bằng" },
    });
    // CỐ Ý bỏ trống `thangTruoc` — chỉ sinh Expense cho tháng mở sổ + tháng hiện tại.
    for (const m of [thangMoSo, thangHienTai]) await sinhExpenseDinhKy(r.id, m, 500_000);

    const soQuy = await tinhSoQuyThang(range);
    expect(soQuy.canhBao.dinhKyChuaGhi).toEqual({
      soKhoan: 1,
      thang: [format(thangTruoc, "MM/yyyy")],
      // Khoảng link sang Sổ chi phí phủ TRỌN tháng thiếu — mở đó là app ghi bù đúng tháng này.
      khoang: { from: startOfMonth(thangTruoc), to: endOfMonth(thangTruoc) },
    });
  });

  it("ngày đến hạn TRƯỚC D0 (trong chính tháng mở sổ) ⇒ không báo", async () => {
    // D0 = ngày 20 tháng mở sổ (không phải đầu tháng) — mẫu đến hạn ngày 5 CÙNG tháng là trước D0.
    await moSo(setDate(thangMoSo, 20));
    const r = await prisma.recurringExpense.create({
      data: { categoryId: "fixed", amount: 100_000, dayOfMonth: 5, description: "Đến hạn trước D0" },
    });
    // Tháng SAU tháng mở sổ mẫu vẫn đến hạn bình thường — sinh sẵn Expense để cô lập đúng case đang
    // kiểm (chỉ tháng mở sổ), không để 2 tháng kia lẫn vào kết quả.
    for (const m of [thangTruoc, thangHienTai]) await sinhExpenseDinhKy(r.id, setDate(m, 5), 100_000);

    const soQuy = await tinhSoQuyThang(range);
    expect(soQuy.canhBao.dinhKyChuaGhi).toEqual({ soKhoan: 0, thang: [], khoang: null });
  });

  it("ngày đến hạn SAU hôm nay ⇒ không báo", async () => {
    const daysThisMonth = getDaysInMonth(homNay);
    const coNgaySau = homNay.getDate() < daysThisMonth;
    // Hôm nay chưa phải ngày cuối tháng ⇒ dùng đúng ngày cuối tháng hiện tại (chắc chắn > hôm nay).
    // Hôm nay ĐÃ là ngày cuối tháng ⇒ lùi hẳn sang tháng SAU (mở sổ ở một mốc tương lai) — cùng cách
    // xử lý biên của `recurring-expenses.test.ts`, tránh test phụ thuộc hôm nay là ngày nào.
    const thangDangXet = coNgaySau ? thangHienTai : addMonths(thangHienTai, 1);
    const ngayDenHan = coNgaySau ? daysThisMonth : 15;
    await moSo(thangDangXet);
    await prisma.recurringExpense.create({
      data: { categoryId: "fixed", amount: 200_000, dayOfMonth: ngayDenHan, description: "Chưa tới hạn" },
    });

    const soQuy = await tinhSoQuyThang({ from: thangDangXet, to: endOfMonth(thangDangXet) });
    expect(soQuy.canhBao.dinhKyChuaGhi).toEqual({ soKhoan: 0, thang: [], khoang: null });
  });

  it("mẫu active=false ⇒ không báo dù đến hạn và chưa ghi", async () => {
    await moSo(thangMoSo);
    await prisma.recurringExpense.create({
      data: { categoryId: "fixed", amount: 300_000, dayOfMonth: 1, description: "Đã tắt", active: false },
    });

    const soQuy = await tinhSoQuyThang(range);
    expect(soQuy.canhBao.dinhKyChuaGhi).toEqual({ soKhoan: 0, thang: [], khoang: null });
  });

  it("mẫu có mốc activeFrom = tháng hiện tại ⇒ KHÔNG báo thiếu các tháng trước mốc", async () => {
    // Mẫu vừa bật lại/vừa tạo: bộ sinh không bao giờ sinh cho tháng trước mốc, nên báo "chưa ghi" ở
    // đó là đòi chủ shop mở một tháng mà mở ra cũng không có gì — cảnh báo không bao giờ tắt.
    await moSo(thangMoSo);
    const r = await prisma.recurringExpense.create({
      data: { categoryId: "fixed", amount: 500_000, dayOfMonth: 1, description: "Bật lại", activeFrom: thangHienTai },
    });
    await sinhExpenseDinhKy(r.id, thangHienTai, 500_000);

    const soQuy = await tinhSoQuyThang(range);
    expect(soQuy.canhBao.dinhKyChuaGhi).toEqual({ soKhoan: 0, thang: [], khoang: null });
  });

  it("mẫu có mốc = tháng trước ⇒ vẫn báo tháng thiếu TỪ mốc trở đi", async () => {
    await moSo(thangMoSo);
    await prisma.recurringExpense.create({
      data: { categoryId: "fixed", amount: 500_000, dayOfMonth: 1, description: "Mốc tháng trước", activeFrom: thangTruoc },
    });

    const soQuy = await tinhSoQuyThang(range);
    expect(soQuy.canhBao.dinhKyChuaGhi).toEqual({
      soKhoan: 2,
      thang: [format(thangTruoc, "MM/yyyy"), format(thangHienTai, "MM/yyyy")],
      khoang: { from: startOfMonth(thangTruoc), to: endOfMonth(thangHienTai) },
    });
  });

  it("dayOfMonth=31 gặp tháng 30 ngày ⇒ kẹp về ngày 30, không tự thêm entry hay tràn tháng sau", async () => {
    // Tìm tháng 30 ngày gần nhất (tháng 4/6/9/11), lùi từ 1 tháng trước — giữ cửa sổ nhỏ, tránh
    // hardcode năm/tháng cụ thể để test xanh bất kể chạy lúc nào.
    let thang30 = subMonths(thangHienTai, 1);
    while (getDaysInMonth(thang30) !== 30) thang30 = subMonths(thang30, 1);
    await moSo(thang30);

    const r = await prisma.recurringExpense.create({
      data: { categoryId: "fixed", amount: 400_000, dayOfMonth: 31, description: "Kẹp cuối tháng" },
    });
    // Neutralize mọi tháng SAU thang30 tới tháng hiện tại (nếu có) — chỉ để trống ĐÚNG thang30. Dùng
    // lại đúng hàm sinh ngày đến hạn (`ngayDenHanDinhKy`) — không lặp lại công thức kẹp ở test.
    for (let m = addMonths(thang30, 1); m <= thangHienTai; m = addMonths(m, 1)) {
      await sinhExpenseDinhKy(r.id, ngayDenHanDinhKy(31, m), 400_000);
    }

    const soQuy = await tinhSoQuyThang(range);
    expect(soQuy.canhBao.dinhKyChuaGhi).toEqual({
      soKhoan: 1,
      thang: [format(thang30, "MM/yyyy")],
      khoang: { from: startOfMonth(thang30), to: endOfMonth(thang30) },
    });
    expect(ngayDenHanDinhKy(31, thang30).getDate()).toBe(30); // kẹp về 30, không tràn sang tháng sau
  });
});
