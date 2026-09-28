import { Prisma } from "@prisma/client";
import { describe, expect, it } from "vitest";

import type { CashMovement, Expense, Loan, SoTietKiem, ThuNhap } from "@prisma/client";

import {
  BANG_THUNG_RAC,
  doiNguocBanGhi,
  dungAnhBanGhi,
  TRUONG_CHUP,
  TRUONG_NGAY,
} from "@/lib/thung-rac/chup-anh-ban-ghi";

/**
 * Nhãn thùng rác là thứ DUY NHẤT chủ shop đọc để nhận ra mình vừa xoá cái gì — bản ghi gốc đã biến
 * mất, danh mục/khoản vay có thể cũng đã bị xoá theo. Suite này chốt nhãn của cả 5 bảng, và chốt
 * bằng MÁY rằng bảng cột được chụp không lạc hậu so với schema Prisma.
 */

const NGAY = new Date(2026, 8, 4); // 04/09/2026 giờ VN (tests/setup.ts đã ghim TZ)

function expense(o: Partial<Expense> = {}): Expense {
  return {
    id: "exp-1",
    date: NGAY,
    categoryId: "purchase",
    adsSource: null,
    description: "",
    channelId: null,
    amount: 28_999_920,
    source: "MANUAL",
    refId: null,
    recurringId: null,
    createdAt: NGAY,
    ...o,
  } as Expense;
}

function cashMovement(o: Partial<CashMovement> = {}): CashMovement {
  return {
    id: "cm-1",
    date: new Date(2026, 4, 12), // 12/05/2026
    kind: "LOAN_IN",
    amount: 200_000_000,
    description: "",
    loanId: "loan-1",
    savingsId: null,
    createdAt: NGAY,
    ...o,
  } as CashMovement;
}

function thuNhap(o: Partial<ThuNhap> = {}): ThuNhap {
  return {
    id: "tn-1",
    date: NGAY,
    kind: "LAI_TIET_KIEM",
    amount: 5_200_000,
    description: "",
    savingsId: "so-1",
    refId: "TIETKIEM:so-1",
    createdAt: NGAY,
    ...o,
  } as ThuNhap;
}

function loan(o: Partial<Loan> = {}): Loan {
  return {
    id: "loan-1",
    name: "Vietcombank",
    lender: "",
    duNoMoSo: 0,
    startDate: new Date(2026, 4, 12),
    annualRateBp: 1050,
    termMonths: 12,
    firstDueDate: null,
    lastDueHandled: null,
    closedAt: null,
    note: "",
    createdAt: NGAY,
    kind: "TERM",
    laiCoDinhMoiKy: null,
    tienGuiBatBuocMoiKy: 0,
    ...o,
  } as Loan;
}

function soTietKiem(o: Partial<SoTietKiem> = {}): SoTietKiem {
  return {
    id: "so-1",
    name: "ACB 6 tháng",
    bank: "ACB",
    principal: 100_000_000,
    startDate: new Date(2026, 2, 1), // 01/03/2026
    termMonths: 6,
    maturityDate: new Date(2026, 8, 1),
    annualRateBp: 520,
    loanId: null,
    closedAt: null,
    note: "",
    createdAt: NGAY,
    ...o,
  } as SoTietKiem;
}

describe("nhãn + số tiền + ngày của từng loại bản ghi", () => {
  it("Expense: tên danh mục — số tiền — ngày", () => {
    const anh = dungAnhBanGhi({ bang: "Expense", banGhi: expense(), tenDanhMuc: "Nhập hàng" });

    expect(anh.nhan).toBe("Nhập hàng — 28.999.920 ₫ — 04/09/2026");
    expect(anh.soTien).toBe(28_999_920);
    expect(anh.ngay).toEqual(NGAY);
  });

  it("Expense: mô tả nối vào cuối nhãn khi có", () => {
    const anh = dungAnhBanGhi({
      bang: "Expense",
      banGhi: expense({ description: "Lô áo thu đông" }),
      tenDanhMuc: "Nhập hàng",
    });

    expect(anh.nhan).toBe("Nhập hàng — 28.999.920 ₫ — 04/09/2026 · Lô áo thu đông");
  });

  it("Expense: nhánh tắt lặp hàng tháng nói thẳng là khôi phục KHÔNG bật lại", () => {
    const anh = dungAnhBanGhi({
      bang: "Expense",
      banGhi: expense(),
      tenDanhMuc: "Mặt bằng-cố định",
      ghiChu: { recurringDaTat: "rec-1" },
    });

    expect(anh.nhan).toContain("đã tắt lặp hàng tháng (khôi phục KHÔNG bật lại)");
    expect(anh.anh.ghiChu.recurringDaTat).toBe("rec-1");
  });

  it("CashMovement: nhãn loại tiếng Việt dùng CHUNG với form ghi tay", () => {
    const anh = dungAnhBanGhi({ bang: "CashMovement", banGhi: cashMovement() });

    expect(anh.nhan).toBe("Vay vốn — 200.000.000 ₫ — 12/05/2026");
    expect(anh.soTien).toBe(200_000_000);
  });

  it("ThuNhap: nhãn theo loại thu nhập", () => {
    const anh = dungAnhBanGhi({ bang: "ThuNhap", banGhi: thuNhap() });

    expect(anh.nhan).toBe("Lãi tiết kiệm — 5.200.000 ₫ — 04/09/2026");
    expect(anh.soTien).toBe(5_200_000);
  });

  it("Loan: số tiền lấy từ dòng giải ngân, ngày là ngày bắt đầu", () => {
    const anh = dungAnhBanGhi({
      bang: "Loan",
      banGhi: loan(),
      cashMovements: [cashMovement()],
      ghiChu: { soTietKiemIds: ["so-1"] },
    });

    expect(anh.nhan).toBe(
      "Khoản vay Vietcombank — 200.000.000 ₫ — 12/05/2026 · kèm 1 dòng tiền · kèm liên kết 1 sổ tiết kiệm"
    );
    expect(anh.soTien).toBe(200_000_000);
    expect(anh.anh.cashMovements).toHaveLength(1);
  });

  it("Loan mang sang: số tiền là dư nợ mở sổ (không có dòng giải ngân nào để cộng)", () => {
    const anh = dungAnhBanGhi({
      bang: "Loan",
      banGhi: loan({ duNoMoSo: 150_000_000 }),
      cashMovements: [],
    });

    expect(anh.soTien).toBe(150_000_000);
    expect(anh.nhan).toBe("Khoản vay Vietcombank — 150.000.000 ₫ — 12/05/2026");
  });

  it("SoTietKiem: số tiền là gốc gửi, kèm số dòng con bị xoá theo", () => {
    const anh = dungAnhBanGhi({
      bang: "SoTietKiem",
      banGhi: soTietKiem(),
      cashMovements: [cashMovement({ kind: "SAVINGS_OUT", loanId: null, savingsId: "so-1" })],
      thuNhap: [thuNhap()],
    });

    expect(anh.nhan).toBe(
      "Sổ tiết kiệm ACB 6 tháng — 100.000.000 ₫ — 01/03/2026 · kèm 1 dòng tiền · kèm 1 dòng lãi"
    );
    expect(anh.soTien).toBe(100_000_000);
  });
});

describe("ảnh chụp dựng lại được nguyên trạng", () => {
  it("chỉ giữ cột đã khai — object quan hệ đi kèm `include` KHÔNG lọt vào ảnh", () => {
    const keml = { ...expense(), category: { id: "purchase", name: "Nhập hàng" } };

    const anh = dungAnhBanGhi({ bang: "Expense", banGhi: keml, tenDanhMuc: "Nhập hàng" });

    expect(Object.keys(anh.anh.chinh).sort()).toEqual([...TRUONG_CHUP.Expense].sort());
  });

  it("Date → ISO rồi đổi ngược lại đúng từng mốc thời gian", () => {
    const goc = loan({ firstDueDate: new Date(2026, 5, 12), closedAt: null });

    const anh = dungAnhBanGhi({ bang: "Loan", banGhi: goc, cashMovements: [] });
    // Trong JSONB phải là chuỗi, không phải Date — nếu không Prisma ghi được nhưng đọc lại là string.
    expect(typeof anh.anh.chinh.startDate).toBe("string");

    const veLai = doiNguocBanGhi("Loan", anh.anh.chinh);
    expect(veLai.startDate).toEqual(goc.startDate);
    expect(veLai.firstDueDate).toEqual(goc.firstDueDate);
    expect(veLai.closedAt).toBeNull();
    expect(veLai.name).toBe("Vietcombank");
  });
});

/**
 * LƯỚI FAIL-CLOSED: thêm một cột vào 5 bảng tiền mà quên khai ở `TRUONG_CHUP` thì ảnh chụp mất cột
 * đó, và khôi phục trả về một bản ghi KHÁC bản gốc — lệch im lặng, không test số nào khác đỏ.
 * Đối chiếu với schema Prisma bằng máy thay vì bằng trí nhớ.
 */
describe("bảng cột được chụp phải khớp schema Prisma", () => {
  it.each(BANG_THUNG_RAC)("%s: chụp đủ mọi cột vô hướng", (bang) => {
    const model = Prisma.dmmf.datamodel.models.find((m) => m.name === bang);
    const cotThat = (model?.fields ?? [])
      .filter((f) => f.kind !== "object")
      .map((f) => f.name);

    expect(
      [...TRUONG_CHUP[bang]].sort(),
      `Cột của ${bang} đã đổi — cập nhật TRUONG_CHUP (và TRUONG_NGAY nếu là cột ngày).`
    ).toEqual(cotThat.sort());
  });

  it.each(BANG_THUNG_RAC)("%s: khai đủ mọi cột kiểu DateTime", (bang) => {
    const model = Prisma.dmmf.datamodel.models.find((m) => m.name === bang);
    const cotNgay = (model?.fields ?? [])
      .filter((f) => f.type === "DateTime")
      .map((f) => f.name);

    expect([...TRUONG_NGAY[bang]].sort()).toEqual(cotNgay.sort());
  });
});
