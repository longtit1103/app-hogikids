import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { datQuyToiThieu } from "@/lib/actions/so-quy-quy-toi-thieu";
import { ensureRecurringExpenses } from "@/lib/expenses/ensure-recurring-expenses";
import { prisma } from "@/lib/prisma";
import type { KhoanDuKien } from "@/lib/so-quy/du-bao-quy-types";
import {
  docCanhBaoSapCan,
  docDuBaoQuy,
  docNguongQuy,
  KEY_QUY_TOI_THIEU,
} from "@/lib/so-quy/du-bao-quy-queries";
import { tinhSoQuyThang } from "@/lib/so-quy/so-quy-queries";

import { seedReference, truncateBusinessTables } from "../helpers/test-db";

/**
 * Biểu đồ quỹ + dự báo "sắp cạn" trên DB thật (`hogikids_test`). Mọi số là LITERAL tính tay.
 *
 * Trọng tâm: một kỳ trả nợ đã được duyệt TRƯỚC hạn (dòng trả gốc + dòng lãi mang ngày tương lai, con
 * dấu `lastDueHandled` đã tiến tới kỳ đó) phải xuất hiện ĐÚNG MỘT LẦN — ở phần "đã ghi" — và KHÔNG có
 * kỳ trả nợ dự kiến trùng. Cộng thêm: quỹ hôm nay = số to của thẻ; biên ngày giờ VN; định kỳ; ngưỡng.
 *
 * `vi.useFakeTimers({ toFake: ["Date"] })` — CHỈ Date: fake luôn timer thì Prisma/pool treo.
 */
vi.mock("@/lib/session", () => ({
  requireUser: vi.fn(async () => "test-user-id"),
}));
vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

const vn = (iso: string) => new Date(`${iso}+07:00`);

/** Hôm nay giả: 24/09/2026 09:00 VN ⇒ lịch sử 27/06 → 24/09, dự báo 25/09 → 24/10. */
const HOM_NAY = vn("2026-09-24T09:00:00");

/**
 * Tính tay:
 *   Lịch sử: +100tr (01/06 mở sổ) −10tr (20/06) −3×10tr trả gốc khoản A (10/07, 10/08, 10/09) −1tr
 *   định kỳ đã sinh (05/09) +0,4tr (24/09 23:59 VN) ⇒ QUỸ HÔM NAY 59,4tr. Đầu cửa sổ 27/06 = 90tr.
 *   Dự báo: hôm nay −2tr (kỳ 15/09 khoản B quá hạn) ⇒ 57,4 · 25/09 +0,7 (00:30 VN) ⇒ 58,1 · 30/09 −3
 *   (định kỳ ngày 30) ⇒ 55,1 · 05/10 −1 (định kỳ ngày 5) ⇒ 54,1 · 10/10 −10 −1 (kỳ khoản A duyệt
 *   TRƯỚC hạn) ⇒ 43,1 · 15/10 −2 (kỳ khoản B) ⇒ 41,1.
 */
const QUY_HOM_NAY = 59_400_000;

let loanA = "";

async function seedFixture(): Promise<void> {
  // Khoản A: vay kỳ hạn 0%/năm mang sang 120tr, 12 kỳ ngày 10 ⇒ gốc đều 10tr/kỳ. Kỳ 10/10 ĐÃ DUYỆT
  // TRƯỚC HẠN: dòng trả gốc + dòng lãi mang ngày 10/10 (tương lai), con dấu tiến tới 10/10.
  const a = await prisma.loan.create({
    data: {
      name: "Khoản A",
      kind: "TERM",
      duNoMoSo: 120_000_000,
      startDate: vn("2026-06-10T00:00:00"),
      firstDueDate: vn("2026-07-10T00:00:00"),
      termMonths: 12,
      annualRateBp: 0,
      lastDueHandled: vn("2026-10-10T00:00:00"),
    },
  });
  loanA = a.id;
  // Khoản B: trả gốc cuối kỳ, lãi CỐ ĐỊNH 2tr/kỳ ngày 15; đã xử lý tới kỳ 15/08 ⇒ kỳ 15/09 QUÁ HẠN.
  await prisma.loan.create({
    data: {
      name: "Khoản B",
      kind: "BULLET",
      duNoMoSo: 50_000_000,
      startDate: vn("2026-06-15T00:00:00"),
      firstDueDate: vn("2026-07-15T00:00:00"),
      termMonths: 12,
      annualRateBp: 0,
      laiCoDinhMoiKy: 2_000_000,
      lastDueHandled: vn("2026-08-15T00:00:00"),
    },
  });
  // Khoản đã tất toán — không bao giờ sinh kỳ dự kiến.
  await prisma.loan.create({
    data: {
      name: "Khoản đã đóng",
      kind: "BULLET",
      duNoMoSo: 10_000_000,
      startDate: vn("2026-06-15T00:00:00"),
      firstDueDate: vn("2026-07-15T00:00:00"),
      termMonths: 12,
      laiCoDinhMoiKy: 9_000_000,
      closedAt: vn("2026-08-01T00:00:00"),
    },
  });

  await prisma.cashMovement.createMany({
    data: [
      { date: vn("2026-06-01T10:00:00"), kind: "CAPITAL_IN", amount: 100_000_000, description: "Mở sổ" },
      ...["2026-07-10", "2026-08-10", "2026-09-10"].map((d) => ({
        date: vn(`${d}T00:00:00`),
        kind: "LOAN_REPAY" as const,
        amount: 10_000_000,
        loanId: a.id,
        description: `Trả gốc Khoản A — kỳ ${d}`,
      })),
      // Duyệt TRƯỚC hạn: dòng trả gốc mang ngày TƯƠNG LAI.
      {
        date: vn("2026-10-10T00:00:00"),
        kind: "LOAN_REPAY",
        amount: 10_000_000,
        loanId: a.id,
        description: "Trả gốc Khoản A — kỳ 10/10/2026",
      },
      // Biên ngày VN: 23:59 hôm nay vào QUỸ HÔM NAY; 00:30 sáng mai (UTC vẫn là 24/09) vào DỰ BÁO.
      { date: vn("2026-09-24T23:59:00"), kind: "OTHER_IN", amount: 400_000, description: "Cuối ngày" },
      { date: vn("2026-09-25T00:30:00"), kind: "OTHER_IN", amount: 700_000, description: "Rạng sáng mai" },
    ],
  });

  const [, r5] = await Promise.all([
    prisma.recurringExpense.create({
      data: { categoryId: "fixed", amount: 3_000_000, dayOfMonth: 30, description: "Mặt bằng" },
    }),
    prisma.recurringExpense.create({
      data: { categoryId: "other", amount: 1_000_000, dayOfMonth: 5, description: "Phần mềm" },
    }),
    // Mẫu đã TẮT — không bao giờ vào dự báo.
    prisma.recurringExpense.create({
      data: { categoryId: "other", amount: 7_000_000, dayOfMonth: 28, description: "Đã tắt", active: false },
    }),
  ]);

  await prisma.expense.createMany({
    data: [
      { date: vn("2026-06-20T00:00:00"), categoryId: "other", amount: 10_000_000, description: "Chi trước cửa sổ" },
      // Định kỳ ngày 5 đã sinh dòng tháng 9 ⇒ trong lịch sử; lần kế là 05/10.
      {
        date: vn("2026-09-05T00:00:00"),
        categoryId: "other",
        amount: 1_000_000,
        description: "Phần mềm",
        source: "RECURRING",
        recurringId: r5.id,
      },
      // Lãi của kỳ khoản A duyệt TRƯỚC hạn — ngày tương lai, khoá `LOAN:` như đường duyệt kỳ thật.
      {
        date: vn("2026-10-10T00:00:00"),
        categoryId: "interest",
        amount: 1_000_000,
        description: "Lãi vay Khoản A — kỳ 10/10/2026",
        refId: `LOAN:${a.id}:2026-10-10`,
      },
    ],
  });
}

async function datNguongTho(value: string): Promise<void> {
  await prisma.setting.upsert({
    where: { key: KEY_QUY_TOI_THIEU },
    create: { key: KEY_QUY_TOI_THIEU, value },
    update: { value },
  });
}

beforeAll(async () => {
  await seedReference();
}, 60_000);

beforeEach(async () => {
  await truncateBusinessTables();
  await prisma.setting.deleteMany({ where: { key: KEY_QUY_TOI_THIEU } });
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(HOM_NAY);
});

afterEach(() => {
  vi.useRealTimers();
});

afterAll(async () => {
  await truncateBusinessTables();
  await prisma.setting.deleteMany({ where: { key: KEY_QUY_TOI_THIEU } });
  await prisma.$disconnect();
});

async function coSo() {
  const r = await docDuBaoQuy();
  if (r.trangThai !== "CO_SO") throw new Error(`mong CO_SO, nhận ${r.trangThai}`);
  return r;
}

describe("docDuBaoQuy — chưa mở sổ", () => {
  it("không có dòng ghi tay nào ⇒ CHUA_MO_SO, banner null", async () => {
    expect(await docDuBaoQuy()).toEqual({ trangThai: "CHUA_MO_SO" });
    expect(await docCanhBaoSapCan()).toBeNull();
  });
});

describe("docDuBaoQuy — đủ dữ liệu", () => {
  beforeEach(async () => {
    await seedFixture();
  });

  it("quỹ hôm nay = số to của thẻ = điểm cuối lịch sử (kể cả dòng 23:59 VN hôm nay)", async () => {
    const r = await coSo();
    const the = await tinhSoQuyThang({ from: vn("2026-09-01T00:00:00"), to: vn("2026-09-30T00:00:00") });
    expect(the.quyHomNay).toBe(QUY_HOM_NAY);
    expect(r.quyHomNay).toBe(QUY_HOM_NAY);
    expect(r.homNay).toBe("2026-09-24");
    expect(r.lichSu[r.lichSu.length - 1]).toEqual({ ngay: "2026-09-24", soDu: QUY_HOM_NAY, duBao: false });
  });

  it("lịch sử: đủ 90 điểm liền mạch 27/06 → 24/09, đầu cửa sổ mang số dư trước đó", async () => {
    const r = await coSo();
    expect(r.lichSu).toHaveLength(90);
    expect(r.lichSu[0]).toEqual({ ngay: "2026-06-27", soDu: 90_000_000, duBao: false });
    const soDu = (ngay: string) => r.lichSu.find((d) => d.ngay === ngay)?.soDu;
    expect(soDu("2026-07-09")).toBe(90_000_000);
    expect(soDu("2026-07-10")).toBe(80_000_000);
    expect(soDu("2026-09-10")).toBe(59_000_000);
    expect(soDu("2026-09-23")).toBe(59_000_000);
  });

  it("🔴 kỳ khoản A duyệt TRƯỚC hạn xuất hiện ĐÚNG MỘT LẦN (đã ghi), không có kỳ dự kiến trùng", async () => {
    const r = await coSo();
    const cuaA = r.khoanDuKien.filter((k) => k.moTa.includes("Khoản A"));
    expect(cuaA.map((k) => [k.ngay, k.loai, k.soTien])).toEqual([
      ["2026-10-10", "DA_GHI", -10_000_000],
      ["2026-10-10", "DA_GHI", -1_000_000],
    ]);
    expect(r.khoanDuKien.filter((k) => k.loai === "KY_TRA_NO" && k.moTa.includes("Khoản A"))).toEqual([]);
    // Khoản đã tất toán không sinh gì.
    expect(r.khoanDuKien.some((k) => k.moTa.includes("Khoản đã đóng"))).toBe(false);
    // Liên kết đúng khoản: dòng trả gốc tương lai thật sự gắn khoản A.
    expect(await prisma.cashMovement.count({ where: { loanId: loanA, date: { gt: HOM_NAY } } })).toBe(1);
  });

  it("toàn bộ khoản dự kiến + chuỗi dự báo khớp số tính tay", async () => {
    const r = await coSo();
    const tomTat = (k: KhoanDuKien) => [k.ngay, k.loai, k.soTien];
    expect(r.khoanDuKien.map(tomTat)).toEqual([
      ["2026-09-24", "KY_TRA_NO", -2_000_000], // kỳ 15/09 khoản B quá hạn ⇒ HÔM NAY
      ["2026-09-25", "DA_GHI", 700_000], // 00:30 VN ngày mai — không lọt vào quỹ hôm nay
      ["2026-09-30", "DINH_KY", -3_000_000],
      ["2026-10-05", "DINH_KY", -1_000_000],
      ["2026-10-10", "DA_GHI", -10_000_000],
      ["2026-10-10", "DA_GHI", -1_000_000],
      ["2026-10-15", "KY_TRA_NO", -2_000_000],
    ]);
    expect(r.khoanDuKien[0].moTa).toBe("Trả nợ Khoản B — kỳ 15/09/2026 (đã tới hạn, chưa ghi)");

    expect(r.duBao).toHaveLength(30);
    expect(r.duBao.every((d) => d.duBao)).toBe(true);
    const soDu = (ngay: string) => r.duBao.find((d) => d.ngay === ngay)?.soDu;
    expect(r.duBao[0]).toEqual({ ngay: "2026-09-25", soDu: 58_100_000, duBao: true });
    expect(soDu("2026-09-30")).toBe(55_100_000);
    expect(soDu("2026-10-05")).toBe(54_100_000);
    expect(soDu("2026-10-10")).toBe(43_100_000);
    expect(r.duBao[29]).toEqual({ ngay: "2026-10-24", soDu: 41_100_000, duBao: true });
    expect(r.thapNhat).toEqual({ ngay: "2026-10-15", soDu: 41_100_000 });
  });

  it("chưa đặt ngưỡng ⇒ 0, không chạm, banner null", async () => {
    const r = await coSo();
    expect(r.nguong).toBe(0);
    expect(r.nguongDaDat).toBe(false);
    expect(r.cham).toBeNull();
    expect(await docCanhBaoSapCan()).toBeNull();
  });

  it("ngưỡng 45tr từ Setting ⇒ chạm 10/10 kèm ĐÚNG hai dòng của kỳ duyệt trước hạn; banner cùng số", async () => {
    await datNguongTho("45000000");
    const r = await coSo();
    expect(r.nguong).toBe(45_000_000);
    expect(r.nguongDaDat).toBe(true);
    expect(r.cham?.ngay).toBe("2026-10-10");
    expect(r.cham?.soDu).toBe(43_100_000);
    expect(r.cham?.khoan.map((k) => [k.loai, k.soTien])).toEqual([
      ["DA_GHI", -10_000_000],
      ["DA_GHI", -1_000_000],
    ]);
    expect(await docCanhBaoSapCan()).toEqual({ ngay: "2026-10-10", soDu: 43_100_000, nguong: 45_000_000, nguongDaDat: true });
  });

  it("ngưỡng 58tr ⇒ chạm ngay điểm đầu vì kỳ quá hạn tính vào hôm nay", async () => {
    await datNguongTho("58500000");
    const r = await coSo();
    expect(r.cham?.ngay).toBe("2026-09-25");
    expect(r.cham?.soDu).toBe(58_100_000);
    expect(r.cham?.khoan.map((k) => [k.ngay, k.loai])).toEqual([
      ["2026-09-24", "KY_TRA_NO"],
      ["2026-09-25", "DA_GHI"],
    ]);
  });

  it("ô Setting hỏng (sửa tay) ⇒ coi như chưa đặt, không làm sập", async () => {
    await datNguongTho("năm triệu");
    expect(await docNguongQuy()).toEqual({ nguong: 0, nguongDaDat: false });
    const r = await coSo();
    expect(r.nguongDaDat).toBe(false);
  });
});

describe("docDuBaoQuy — chi phí định kỳ ĐẾN HẠN trong tháng mà chưa sinh dòng", () => {
  /**
   * Thêm vào fixture: "Điện" ngày 20, 600k — CHƯA sinh dòng tháng 9 (cũng chưa sinh tháng 8); "Nước"
   * ngày 10, 400k — ĐÃ sinh dòng 10/09 ⇒ quỹ hôm nay 59,4 − 0,4 = 59,0tr.
   * Điểm dự báo đầu: 59,0 − 2 (kỳ B quá hạn) − 0,6 (Điện đến hạn) + 0,7 (00:30 VN) = 57,1tr.
   */
  beforeEach(async () => {
    await seedFixture();
    const [, nuoc] = await Promise.all([
      prisma.recurringExpense.create({
        data: { categoryId: "other", amount: 600_000, dayOfMonth: 20, description: "Điện" },
      }),
      prisma.recurringExpense.create({
        data: { categoryId: "other", amount: 400_000, dayOfMonth: 10, description: "Nước" },
      }),
    ]);
    await prisma.expense.create({
      data: {
        date: vn("2026-09-10T00:00:00"),
        categoryId: "other",
        amount: 400_000,
        description: "Nước",
        source: "RECURRING",
        recurringId: nuoc.id,
      },
    });
  });

  it("🔴 chưa sinh ⇒ tính vào HÔM NAY; đã sinh ⇒ không; tháng trước ⇒ không đòi bù", async () => {
    const r = await coSo();
    expect(r.quyHomNay).toBe(59_000_000);
    const dien = r.khoanDuKien.filter((k) => k.moTa.includes("Điện"));
    expect(dien).toEqual([
      {
        ngay: "2026-09-24",
        soTien: -600_000,
        moTa: "Chi phí định kỳ — Điện — ngày 20/09/2026 (đến hạn, chưa ghi sổ)",
        loai: "DINH_KY",
      },
      { ngay: "2026-10-20", soTien: -600_000, moTa: "Chi phí định kỳ — Điện", loai: "DINH_KY" },
    ]);
    // "Nước" tháng 9 đã có dòng (trong quỹ hôm nay) ⇒ chỉ còn lần 10/10.
    expect(r.khoanDuKien.filter((k) => k.moTa.includes("Nước")).map((k) => k.ngay)).toEqual(["2026-10-10"]);
    expect(r.duBao[0]).toEqual({ ngay: "2026-09-25", soDu: 57_100_000, duBao: true });
  });

  it("banner cùng số: ngưỡng 57,5tr chạm ngay điểm đầu vì khoản đến hạn chưa ghi", async () => {
    await datNguongTho("57500000");
    expect(await docCanhBaoSapCan()).toEqual({ ngay: "2026-09-25", soDu: 57_100_000, nguong: 57_500_000, nguongDaDat: true });
    const r = await coSo();
    expect(r.cham?.khoan.filter((k) => k.loai === "DINH_KY").map((k) => k.soTien)).toEqual([-600_000]);
  });

  it("bộ sinh chạy TRƯỚC hay SAU lượt đọc thì chuỗi dự báo vẫn y hệt (không mất, không đếm đôi)", async () => {
    const truoc = await coSo();
    expect(await ensureRecurringExpenses(HOM_NAY)).toBe(1); // chỉ sinh "Điện" tháng 9
    const sau = await coSo();
    expect(sau.quyHomNay).toBe(58_400_000);
    expect(sau.khoanDuKien.some((k) => k.moTa.includes("đến hạn, chưa ghi sổ"))).toBe(false);
    expect(sau.duBao).toEqual(truoc.duBao);
  });
});

describe("datQuyToiThieu", () => {
  it("hợp lệ ⇒ ghi Setting, đọc lại đúng số; ghi lần hai là cập nhật", async () => {
    expect(await datQuyToiThieu({ soTien: 20_000_000 })).toEqual({ ok: true, data: undefined });
    expect(await docNguongQuy()).toEqual({ nguong: 20_000_000, nguongDaDat: true });
    expect(await datQuyToiThieu({ soTien: 0 })).toEqual({ ok: true, data: undefined });
    expect(await docNguongQuy()).toEqual({ nguong: 0, nguongDaDat: true });
  });

  it.each([
    ["âm", { soTien: -1 }],
    ["quá trần 2 tỷ", { soTien: 2_000_000_001 }],
    ["không nguyên", { soTien: 1.5 }],
    ["chuỗi", { soTien: "100000" }],
    ["thiếu", {}],
  ])("%s ⇒ lỗi ở ô soTien, Setting không đổi", async (_ten, input) => {
    await datNguongTho("123");
    const res = await datQuyToiThieu(input);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.field).toBe("soTien");
    expect(await docNguongQuy()).toEqual({ nguong: 123, nguongDaDat: true });
  });
});
