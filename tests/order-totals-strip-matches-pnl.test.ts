import { endOfDay, startOfDay } from "date-fns";
import { describe, expect, it } from "vitest";

import { isExactlyPnlValid, isFullCalendarMonth } from "@/components/orders/order-totals-strip";

/**
 * Caption "khớp bảng Lỗ lãi" chỉ được đúng khi kỳ là TRỌN 1 tháng dương lịch —
 * P&L không có kỳ nửa tháng để đối chiếu. Bấm preset "7 ngày"/"Hôm nay" ở bộ
 * lọc Đơn hàng (giữ nguyên trạng thái hợp lệ từ lượt drill trước) là đường
 * chạm thật qua UI, không chỉ sửa URL tay.
 */
describe("isFullCalendarMonth", () => {
  it("nhận trọn 1 tháng (đầu tháng 00:00:00.000 → cuối tháng 23:59:59.999)", () => {
    expect(isFullCalendarMonth({ from: new Date(2026, 6, 1, 0, 0, 0, 0), to: new Date(2026, 6, 31, 23, 59, 59, 999) })).toBe(
      true,
    );
  });

  it("từ chối khoảng lẻ trong tháng (vd 01/06–15/06, đúng dạng preset '7 ngày' sinh ra)", () => {
    const from = startOfDay(new Date(2026, 5, 9));
    const to = endOfDay(new Date(2026, 5, 15));
    expect(isFullCalendarMonth({ from, to })).toBe(false);
  });

  it("từ chối khi to lệch 1 ngày so với cuối tháng (không tới endOfMonth)", () => {
    expect(isFullCalendarMonth({ from: new Date(2026, 6, 1, 0, 0, 0, 0), to: new Date(2026, 6, 30, 23, 59, 59, 999) })).toBe(
      false,
    );
  });

  it("nhận đúng tháng 2 nhuận (2026 không nhuận → 28 ngày)", () => {
    expect(isFullCalendarMonth({ from: new Date(2026, 1, 1, 0, 0, 0, 0), to: new Date(2026, 1, 28, 23, 59, 59, 999) })).toBe(
      true,
    );
  });
});

describe("isExactlyPnlValid", () => {
  it("nhận đúng 3 trạng thái hợp lệ (thứ tự bất kỳ)", () => {
    expect(isExactlyPnlValid(["COMPLETED", "PENDING", "SHIPPING"])).toBe(true);
  });

  it("từ chối khi thiếu 1 trạng thái hợp lệ", () => {
    expect(isExactlyPnlValid(["PENDING", "SHIPPING"])).toBe(false);
  });

  it("từ chối khi lẫn trạng thái bị P&L loại trừ", () => {
    expect(isExactlyPnlValid(["PENDING", "SHIPPING", "COMPLETED", "RETURNED"])).toBe(false);
  });

  it("từ chối danh sách rỗng (= tất cả trạng thái, không lọc)", () => {
    expect(isExactlyPnlValid([])).toBe(false);
  });
});
