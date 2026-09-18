import { describe, expect, it } from "vitest";

import {
  daoHanTatToanText,
  dongChenhLechText,
  laiColumnLines,
  tongBangSoTietKiem,
} from "@/components/finance/so-tiet-kiem-table";
import type { SoTietKiemRow } from "@/lib/tiet-kiem/so-tiet-kiem-queries";

/**
 * Cột bảng ĐỔI NGHĨA theo trạng thái sổ (spec mục 11) — 4 hàm này là nơi DUY NHẤT quyết định chữ in
 * ra, tách khỏi JSX để kiểm bằng số LITERAL, không suy lại bằng chính công thức đang kiểm.
 */
function row(overrides: Partial<SoTietKiemRow> = {}): SoTietKiemRow {
  return {
    id: "so1",
    name: "Sổ 6 tháng VCB",
    bank: "Vietcombank",
    principal: 200_000_000,
    startDate: new Date(2026, 8, 5),
    termMonths: 6,
    maturityDate: new Date(2027, 2, 5),
    annualRateBp: 520,
    closedAt: null,
    note: "",
    // CỐ Ý khác `principal`: để 2 số bằng nhau thì ca "Đang gửi Σ" không phân biệt được hàm đọc
    // `r.dangGui` (đúng) hay `r.principal` (sai) — lưới thành rỗng, đúng lỗi review 17/09 bắt được.
    dangGui: 150_000_000,
    laiDuKien: 5_157_260,
    laiDonToiNay: 2_500_000,
    laiThucNhan: null,
    rutTruocHan: false,
    loan: null,
    chenhLech: null,
    coDongGhiTay: false,
    soDongGui: 1,
    ...overrides,
  };
}

describe("daoHanTatToanText", () => {
  it("đang gửi, còn hạn → 'đáo hạn dd/MM · còn N ngày'", () => {
    expect(daoHanTatToanText(row(), new Date(2027, 1, 20))).toEqual({
      text: "đáo hạn 05/03 · còn 13 ngày",
      rutTruocHan: false,
    });
  });

  it("đang gửi, quá hạn chưa tất toán → 'quá hạn N ngày'", () => {
    expect(daoHanTatToanText(row(), new Date(2027, 2, 10))).toEqual({
      text: "đáo hạn 05/03 · quá hạn 5 ngày",
      rutTruocHan: false,
    });
  });

  it("đã tất toán ĐÚNG hạn → 'tất toán dd/MM', KHÔNG badge", () => {
    expect(
      daoHanTatToanText(row({ closedAt: new Date(2027, 2, 5), rutTruocHan: false }), new Date(2027, 2, 6))
    ).toEqual({ text: "tất toán 05/03", rutTruocHan: false });
  });

  it("đã tất toán TRƯỚC hạn → badge rutTruocHan true, đọc THẲNG field đã tính sẵn", () => {
    expect(
      daoHanTatToanText(row({ closedAt: new Date(2026, 11, 5), rutTruocHan: true }), new Date(2026, 11, 6))
    ).toEqual({ text: "tất toán 05/12", rutTruocHan: true });
  });
});

describe("laiColumnLines", () => {
  it("đang gửi → dòng 1 'dự kiến', dòng 2 'dồn tới nay'", () => {
    expect(laiColumnLines(row())).toEqual({
      dong1: "dự kiến 5.157.260 ₫",
      dong2: "dồn tới nay ≈ 2.500.000 ₫",
    });
  });

  it("đã tất toán, lãi > 0 → CHỈ dòng 1 'thực nhận', không dòng 2", () => {
    expect(
      laiColumnLines(row({ closedAt: new Date(2027, 2, 5), laiThucNhan: 5_157_260 }))
    ).toEqual({ dong1: "thực nhận 5.157.260 ₫", dong2: null });
  });

  it("đã tất toán, lãi = 0 → 'thực nhận 0 ₫' (KHÔNG rơi về nhánh 'dự kiến')", () => {
    expect(
      laiColumnLines(row({ closedAt: new Date(2027, 2, 5), laiThucNhan: 0 }))
    ).toEqual({ dong1: "thực nhận 0 ₫", dong2: null });
  });
});

describe("dongChenhLechText", () => {
  it("không gắn khoản vay ⇒ null", () => {
    expect(dongChenhLechText(row())).toBeNull();
  });

  it("có khoản vay, chênh DƯƠNG (gửi lãi hơn vay) → dấu +, suy ngược lãi vay đúng công thức §6.3", () => {
    const s = row({
      annualRateBp: 520,
      loan: { id: "l1", name: "Vay Techcombank" },
      chenhLech: { chenhBp: 80, chenhMoiNam: 1_600_000, quyDoi: false },
    });
    // laiVay = annualRateBp(520) - chenhBp(80) = 440 → 4,4%/năm
    expect(dongChenhLechText(s)).toBe(
      "Từ khoản vay Vay Techcombank (4,4%/năm) → chênh +0,8%/năm ≈ +1.600.000 ₫ (ước tính)"
    );
  });

  it("chênh ÂM (vay đắt hơn gửi), có quy đổi → dấu −, ghi thêm ', quy đổi'", () => {
    const s = row({
      annualRateBp: 1000,
      loan: { id: "l2", name: "Vay trả gốc cuối kỳ" },
      chenhLech: { chenhBp: -50, chenhMoiNam: -1_000_000, quyDoi: true },
    });
    // laiVay = 1000 - (-50) = 1050 → 10,5%/năm
    expect(dongChenhLechText(s)).toBe(
      "Từ khoản vay Vay trả gốc cuối kỳ (10,5%/năm, quy đổi) → chênh −0,5%/năm ≈ −1.000.000 ₫ (ước tính)"
    );
  });
});

describe("tongBangSoTietKiem", () => {
  it("cộng đúng Σ đang gửi, Σ lãi dự kiến (CHỈ sổ đang gửi) và Σ lãi đã nhận (CHỈ sổ đã tất toán)", () => {
    const rows = [
      // `dangGui` (150tr) KHÁC `principal` (200tr) — sổ đã nhận lại một phần bằng dòng ghi tay.
      // Đây là chỗ duy nhất phân biệt được hàm đọc đúng field hay không.
      row({
        id: "a",
        closedAt: null,
        principal: 200_000_000,
        dangGui: 150_000_000,
        laiDuKien: 5_157_260,
      }),
      row({
        id: "b",
        closedAt: new Date(2026, 10, 1),
        principal: 60_000_000,
        laiDuKien: 999_999, // KHÔNG được cộng — sổ này đã tất toán
        laiThucNhan: 3_000_000,
      }),
    ];
    expect(tongBangSoTietKiem(rows)).toEqual({
      dangGui: 150_000_000, // tiền THẬT còn ở ngân hàng, không phải số khai trên sổ
      laiDuKienSum: 5_157_260,
      laiNhanSum: 3_000_000,
    });
  });

  it("mảng rỗng → cả ba số 0", () => {
    expect(tongBangSoTietKiem([])).toEqual({ dangGui: 0, laiDuKienSum: 0, laiNhanSum: 0 });
  });
});
