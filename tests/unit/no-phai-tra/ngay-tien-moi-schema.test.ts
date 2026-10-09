import { addDays, endOfDay, startOfDay } from "date-fns";
import { describe, expect, it } from "vitest";

import { ngayTienMoiSchema } from "@/lib/no-phai-tra/ngay-tien-moi-schema";

/**
 * Ngày của dữ liệu tiền MỚI (CARD_PAY / SUPPLIER_* / Expense.cardId / chốt sao kê) = luật ngày ghi tay
 * chung (không tương lai, không năm rác) + KHÔNG trước mốc M: tiền trước M đã nằm trong số mở đầu, ghi
 * lùi là trừ hai lần và đổi quỹ tháng cũ.
 */
const M = new Date("2026-10-01T00:00:00+07:00");
const loi = (v: unknown) => {
  const r = ngayTienMoiSchema(M).safeParse(v);
  return r.success ? null : r.error.issues[0].message;
};

describe("ngayTienMoiSchema(M)", () => {
  it("ngày tương lai ⇒ 'Không cho ngày tương lai'", () => {
    expect(loi(addDays(endOfDay(new Date()), 1))).toBe("Không cho ngày tương lai");
  });

  it("M − 1 ngày ⇒ 'Trước ngày bật theo dõi nợ (01/10/2026)'", () => {
    expect(loi(new Date("2026-09-30T00:00:00+07:00"))).toBe("Trước ngày bật theo dõi nợ (01/10/2026)");
    // Sát biên: 23:59:59 ngày M−1 vẫn là trước M.
    expect(loi(new Date("2026-09-30T23:59:59+07:00"))).toBe("Trước ngày bật theo dõi nợ (01/10/2026)");
  });

  it("đúng M và hôm nay ⇒ hợp lệ, trả về Date", () => {
    expect(loi(M)).toBeNull();
    expect(loi(startOfDay(new Date()))).toBeNull();
    expect(ngayTienMoiSchema(M).parse("2026-10-01")).toBeInstanceOf(Date);
  });

  it("Invalid Date / null / 0 ⇒ 'Ngày không hợp lệ'", () => {
    expect(loi(new Date("khong-phai-ngay"))).toBe("Ngày không hợp lệ");
    expect(loi(null)).toBe("Ngày không hợp lệ");
    expect(loi(0)).toBe("Ngày không hợp lệ");
  });
});
