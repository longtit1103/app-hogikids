import { describe, expect, it } from "vitest";

import {
  CASH_MOVEMENT_KIND_META,
  CASH_MOVEMENT_KINDS,
  isCashMovementKind,
  isInflow,
  signedAmount,
} from "@/lib/cash-movements/cash-movement-kinds";

/**
 * Test THUẦN (không DB) cho định nghĩa 10 loại "khoản tiền khác". Khoá 3 điều: đủ 10 loại có nhãn/gợi
 * ý; đúng 6 VÀO + 4 RA theo đúng thứ tự hiển thị; dấu của `signedAmount` — sai dấu là Số dư dòng tiền
 * cộng nhầm tiền trả nợ thành tiền vào.
 */
describe("cash-movement-kinds", () => {
  it("đúng 10 loại, mỗi loại có nhãn + gợi ý không rỗng", () => {
    expect(CASH_MOVEMENT_KINDS).toHaveLength(10);
    for (const k of CASH_MOVEMENT_KINDS) {
      expect(CASH_MOVEMENT_KIND_META[k].label.length).toBeGreaterThan(0);
      expect(CASH_MOVEMENT_KIND_META[k].hint.length).toBeGreaterThan(0);
    }
  });

  it("6 loại VÀO rồi 4 loại RA — đúng danh sách và đúng thứ tự hiển thị", () => {
    expect(CASH_MOVEMENT_KINDS.filter(isInflow)).toEqual([
      "LOAN_IN", "CAPITAL_IN", "DIRECT_SALE", "OTHER_IN", "DEPOSIT_IN", "SAVINGS_IN",
    ]);
    expect(CASH_MOVEMENT_KINDS.filter((k) => !isInflow(k))).toEqual([
      "LOAN_REPAY", "CAPITAL_OUT", "DEPOSIT_OUT", "SAVINGS_OUT",
    ]);
    expect(CASH_MOVEMENT_KINDS.map((k) => CASH_MOVEMENT_KIND_META[k].direction)).toEqual([
      "IN", "IN", "IN", "IN", "IN", "IN", "OUT", "OUT", "OUT", "OUT",
    ]);
  });

  it("signedAmount: vào giữ dương, ra thành âm", () => {
    expect(signedAmount("LOAN_IN", 100_000_000)).toBe(100_000_000);
    expect(signedAmount("DIRECT_SALE", 250_000)).toBe(250_000);
    expect(signedAmount("SAVINGS_IN", 200_000_000)).toBe(200_000_000);
    expect(signedAmount("LOAN_REPAY", 5_000_000)).toBe(-5_000_000);
    expect(signedAmount("CAPITAL_OUT", 1)).toBe(-1);
    expect(signedAmount("SAVINGS_OUT", 200_000_000)).toBe(-200_000_000);
  });

  it("gợi ý 'Bán trực tiếp' phải nhắc đường Pancake POS (quyết định Q1: KHÔNG vào P&L)", () => {
    expect(CASH_MOVEMENT_KIND_META.DIRECT_SALE.hint).toMatch(/Pancake/);
  });

  // Hai loại GỐC VAY bắt buộc `loanId` (zod + CHECK ở DB). Gợi ý phải nói ra điều đó, nếu không
  // chủ shop bấm Lưu rồi mới gặp lỗi ở một ô mình không biết là có.
  it("gợi ý mọi loại gắn khoản vay nhắc phải chọn khoản vay", () => {
    expect(CASH_MOVEMENT_KIND_META.LOAN_IN.hint).toMatch(/chọn khoản vay/i);
    expect(CASH_MOVEMENT_KIND_META.LOAN_REPAY.hint).toMatch(/chọn khoản vay/i);
    // Tiền gửi tiết kiệm bắt buộc cũng bị CHECK `CashMovement_loan_bat_buoc` đòi `loanId`.
    expect(CASH_MOVEMENT_KIND_META.DEPOSIT_OUT.hint).toMatch(/chọn khoản vay/i);
    expect(CASH_MOVEMENT_KIND_META.DEPOSIT_IN.hint).toMatch(/chọn khoản vay/i);
  });

  // Nhãn PHẢI khác hẳn cặp DEPOSIT_* (tiền gửi BẮT BUỘC theo hợp đồng vay, không sinh lãi, gắn
  // loanId). Đọc nhầm hai cặp là chủ shop ghi tiền vào sai trục dư nợ.
  it("gợi ý loại gắn SỔ TIẾT KIỆM nhắc phải chọn sổ, nhãn tách bạch cặp tiền gửi bắt buộc", () => {
    expect(CASH_MOVEMENT_KIND_META.SAVINGS_OUT.label).toBe("Gửi tiết kiệm sinh lãi");
    expect(CASH_MOVEMENT_KIND_META.SAVINGS_IN.label).toBe("Nhận lại gốc tiết kiệm");
    expect(CASH_MOVEMENT_KIND_META.SAVINGS_OUT.hint).toMatch(/chọn sổ tiết kiệm/i);
    expect(CASH_MOVEMENT_KIND_META.SAVINGS_IN.hint).toMatch(/chọn sổ tiết kiệm/i);
    // Dòng nhận lại mang ĐÚNG PHẦN GỐC — gợi ý phải nói ra, kẻo chủ shop gõ cả gốc lẫn lãi.
    expect(CASH_MOVEMENT_KIND_META.SAVINGS_IN.hint).toMatch(/gốc/i);
  });

  it("'Góp vốn / nhập quỹ' nhắc luôn số dư sẵn có lúc mở sổ quỹ", () => {
    expect(CASH_MOVEMENT_KIND_META.CAPITAL_IN.label).toBe("Góp vốn / nhập quỹ");
    expect(CASH_MOVEMENT_KIND_META.CAPITAL_IN.hint).toMatch(/mở sổ quỹ/);
  });

  it("isCashMovementKind lọc giá trị lạ (sai hoa/thường cũng loại)", () => {
    expect(isCashMovementKind("LOAN_IN")).toBe(true);
    expect(isCashMovementKind("loan_in")).toBe(false);
    expect(isCashMovementKind("")).toBe(false);
    expect(isCashMovementKind(42)).toBe(false);
    expect(isCashMovementKind(null)).toBe(false);
  });
});
