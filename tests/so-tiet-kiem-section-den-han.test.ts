import { describe, expect, it } from "vitest";

import { sosDenHan } from "@/components/finance/so-tiet-kiem-section";
import type { SoTietKiemRow } from "@/lib/tiet-kiem/so-tiet-kiem-queries";

/**
 * Khối "đến hạn" (`SoDaoHanCard`) chỉ hiện sổ CHƯA tất toán và ĐÃ tới `maturityDate` — lọc thẳng từ
 * danh sách đã đọc ở page.tsx, KHÔNG gọi `demSoDenHan()` thêm.
 */
function row(overrides: Partial<SoTietKiemRow> = {}): SoTietKiemRow {
  return {
    id: "so1",
    name: "Sổ",
    bank: "VCB",
    principal: 200_000_000,
    startDate: new Date(2026, 8, 5),
    termMonths: 6,
    maturityDate: new Date(2027, 2, 5),
    annualRateBp: 520,
    closedAt: null,
    note: "",
    dangGui: 200_000_000,
    laiDuKien: 5_157_260,
    laiDonToiNay: 0,
    laiThucNhan: null,
    rutTruocHan: false,
    loan: null,
    chenhLech: null,
    coDongGhiTay: false,
    soDongGui: 1,
    ...overrides,
  };
}

describe("sosDenHan", () => {
  it("maturityDate ĐÚNG hôm nay → có trong danh sách đến hạn", () => {
    const rows = [row({ id: "a", maturityDate: new Date(2027, 2, 5) })];
    expect(sosDenHan(rows, new Date(2027, 2, 5)).map((r) => r.id)).toEqual(["a"]);
  });

  it("maturityDate NGÀY MAI → chưa đến hạn", () => {
    const rows = [row({ id: "a", maturityDate: new Date(2027, 2, 6) })];
    expect(sosDenHan(rows, new Date(2027, 2, 5))).toEqual([]);
  });

  it("maturityDate ĐÃ QUA (quá hạn chưa tất toán) → vẫn tính là đến hạn", () => {
    const rows = [row({ id: "a", maturityDate: new Date(2027, 2, 4) })];
    expect(sosDenHan(rows, new Date(2027, 2, 5)).map((r) => r.id)).toEqual(["a"]);
  });

  it("đã tất toán → KHÔNG vào danh sách dù maturityDate đã qua", () => {
    const rows = [row({ id: "a", maturityDate: new Date(2027, 2, 4), closedAt: new Date(2027, 2, 4) })];
    expect(sosDenHan(rows, new Date(2027, 2, 5))).toEqual([]);
  });
});
