import { describe, expect, it } from "vitest";

import { khoanCauTrucTai } from "@/lib/no-phai-tra/khoan-cau-truc-tai-ngay";

const vn = (s: string) => new Date(`${s}+07:00`);

const thauChi = (over: Partial<Parameters<typeof khoanCauTrucTai>[1][number]> = {}) => ({
  id: "L1",
  kind: "OVERDRAFT",
  startDate: vn("2026-09-01T00:00:00"),
  closedAt: null as Date | null,
  duNoMoSo: 0,
  ...over,
});

const mv = (kind: string, amount: number, date: string, o: { loanId?: string | null; savingsId?: string | null } = {}) => ({
  loanId: o.loanId ?? null,
  savingsId: o.savingsId ?? null,
  kind,
  amount,
  date: vn(date),
});

describe("khoanCauTrucTai — dư nợ thấu chi", () => {
  const loans = [thauChi()];
  const movements = [
    mv("LOAN_IN", 10_000_000, "2026-09-05T09:00:00", { loanId: "L1" }),
    mv("LOAN_REPAY", 10_000_000, "2026-11-02T10:00:00", { loanId: "L1" }),
  ];

  it("còn 10tr cuối 31/10, về 0 sau khi trả ngày 02/11", () => {
    expect(khoanCauTrucTai(vn("2026-10-31T00:00:00"), loans, movements).duNoThauChi).toBe(10_000_000);
    expect(khoanCauTrucTai(vn("2026-11-02T00:00:00"), loans, movements).duNoThauChi).toBe(0);
  });

  it("cộng dư nợ mở sổ", () => {
    const r = khoanCauTrucTai(vn("2026-10-31T00:00:00"), [thauChi({ duNoMoSo: 3_000_000 })], movements.slice(0, 1));
    expect(r.duNoThauChi).toBe(13_000_000);
  });

  it("khoản đóng 01/11 vẫn tính tại 31/10, hết tính từ 01/11", () => {
    const dong = [thauChi({ closedAt: vn("2026-11-01T08:00:00") })];
    expect(khoanCauTrucTai(vn("2026-10-31T00:00:00"), dong, movements.slice(0, 1)).duNoThauChi).toBe(10_000_000);
    expect(khoanCauTrucTai(vn("2026-11-01T00:00:00"), dong, movements.slice(0, 1)).duNoThauChi).toBe(0);
  });

  it("khoản chưa bắt đầu hoặc không phải thấu chi ⇒ không tính", () => {
    const l = [thauChi({ startDate: vn("2026-12-01T00:00:00") }), thauChi({ id: "L2", kind: "BULLET" })];
    const m = [mv("LOAN_IN", 5_000_000, "2026-09-05T09:00:00", { loanId: "L2" })];
    expect(khoanCauTrucTai(vn("2026-10-31T00:00:00"), l, m).duNoThauChi).toBe(0);
  });

  it("thấu chi startDate SAU ngày xem ⇒ 0 dù có duNoMoSo; ĐÚNG ngày startDate ⇒ tính", () => {
    const l = [thauChi({ startDate: vn("2026-11-01T00:00:00"), duNoMoSo: 3_000_000 })];
    expect(khoanCauTrucTai(vn("2026-10-31T00:00:00"), l, []).duNoThauChi).toBe(0);
    expect(khoanCauTrucTai(vn("2026-11-01T00:00:00"), l, []).duNoThauChi).toBe(3_000_000);
  });

  it("dòng tiền chỉ cộng vào ĐÚNG khoản theo loanId", () => {
    const l = [thauChi(), thauChi({ id: "L2", kind: "BULLET" })];
    const m = [
      mv("LOAN_IN", 10_000_000, "2026-09-05T09:00:00", { loanId: "L1" }),
      mv("LOAN_IN", 5_000_000, "2026-09-06T09:00:00", { loanId: "L2" }),
    ];
    expect(khoanCauTrucTai(vn("2026-10-31T00:00:00"), l, m).duNoThauChi).toBe(10_000_000);
  });

  it("giao dịch 31/10 23:30 giờ VN tính vào 31/10", () => {
    const m = [mv("LOAN_IN", 4_000_000, "2026-10-31T23:30:00", { loanId: "L1" })];
    expect(khoanCauTrucTai(vn("2026-10-31T00:00:00"), loans, m).duNoThauChi).toBe(4_000_000);
    expect(khoanCauTrucTai(vn("2026-10-30T00:00:00"), loans, m).duNoThauChi).toBe(0);
  });
});

describe("khoanCauTrucTai — tiền đang gửi", () => {
  const movements = [
    mv("DEPOSIT_OUT", 5_000_000, "2026-10-20T10:00:00", { loanId: "L9" }),
    mv("DEPOSIT_IN", 5_000_000, "2026-11-05T10:00:00", { loanId: "L9" }),
  ];

  it("gửi 5tr 20/10, rút 05/11 ⇒ tại 31/10 = 5tr, tại 05/11 = 0", () => {
    expect(khoanCauTrucTai(vn("2026-10-31T00:00:00"), [], movements).tienDangGui).toBe(5_000_000);
    expect(khoanCauTrucTai(vn("2026-11-05T00:00:00"), [], movements).tienDangGui).toBe(0);
  });

  it("cộng cả sổ tiết kiệm sinh lãi", () => {
    const m = [
      ...movements,
      mv("SAVINGS_OUT", 20_000_000, "2026-10-01T09:00:00", { savingsId: "S1" }),
      mv("SAVINGS_IN", 8_000_000, "2026-10-25T09:00:00", { savingsId: "S1" }),
    ];
    expect(khoanCauTrucTai(vn("2026-10-31T00:00:00"), [], m).tienDangGui).toBe(17_000_000);
  });

  it("kẹp ≥ 0 khi dữ liệu rút nhiều hơn gửi", () => {
    const m = [mv("SAVINGS_IN", 1_000_000, "2026-10-01T09:00:00", { savingsId: "S1" })];
    expect(khoanCauTrucTai(vn("2026-10-31T00:00:00"), [], m).tienDangGui).toBe(0);
  });

  it("giao dịch 31/10 23:30 giờ VN tính vào 31/10", () => {
    const m = [mv("DEPOSIT_OUT", 2_000_000, "2026-10-31T23:30:00", { loanId: "L9" })];
    expect(khoanCauTrucTai(vn("2026-10-31T00:00:00"), [], m).tienDangGui).toBe(2_000_000);
    expect(khoanCauTrucTai(vn("2026-10-30T12:00:00"), [], m).tienDangGui).toBe(0);
  });
});
