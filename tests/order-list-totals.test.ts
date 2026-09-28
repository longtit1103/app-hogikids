import { describe, expect, it } from "vitest";

import { sumPnlPlatformFee } from "@/lib/orders/order-list-totals";

/**
 * Dải tổng "Phí sàn" ở `/don-hang` phải bằng ĐÚNG phí sàn THỰC vào P&L (khớp
 * cột từng dòng đơn hoàn/hủy VÀ dòng "Phí sàn" + "Phí sàn đơn hoàn/hủy" của
 * bảng P&L cùng kỳ) — KHÔNG phải Σ platformFeeEst thô như trước (finding review
 * PR #37: lệch 10× trên view drill đơn hoàn/hủy vì đơn RETURNED/CANCELLED có
 * platformFeeEst tạm cao hơn nhiều returnedFee thật).
 */
describe("sumPnlPlatformFee", () => {
  it("đơn hợp lệ (PENDING/SHIPPING/COMPLETED) → dùng platformFeeEst", () => {
    const groups = [
      { status: "COMPLETED" as const, _sum: { platformFeeEst: 7_000, returnedFee: 999_999 } },
      { status: "PENDING" as const, _sum: { platformFeeEst: 3_000, returnedFee: 999_999 } },
    ];
    expect(sumPnlPlatformFee(groups)).toBe(10_000);
  });

  it("đơn RETURNED/CANCELLED → dùng returnedFee, KHÔNG dùng platformFeeEst", () => {
    const groups = [
      { status: "RETURNED" as const, _sum: { platformFeeEst: 900_000, returnedFee: 26_000 } },
      { status: "CANCELLED" as const, _sum: { platformFeeEst: 700_000, returnedFee: 15_500 } },
    ];
    expect(sumPnlPlatformFee(groups)).toBe(41_500);
  });

  it("mixed — cộng đúng từng loại theo status của mỗi group", () => {
    const groups = [
      { status: "COMPLETED" as const, _sum: { platformFeeEst: 219_000, returnedFee: 777_777 } },
      { status: "CANCELLED" as const, _sum: { platformFeeEst: 700_000, returnedFee: 26_000 } },
    ];
    expect(sumPnlPlatformFee(groups)).toBe(219_000 + 26_000);
  });

  it("_sum null (không có đơn nào khớp group) → coi là 0", () => {
    const groups = [
      { status: "COMPLETED" as const, _sum: { platformFeeEst: null, returnedFee: null } },
      { status: "RETURNED" as const, _sum: { platformFeeEst: null, returnedFee: null } },
    ];
    expect(sumPnlPlatformFee(groups)).toBe(0);
  });

  it("danh sách rỗng (bộ lọc không khớp đơn nào) → 0", () => {
    expect(sumPnlPlatformFee([])).toBe(0);
  });
});
