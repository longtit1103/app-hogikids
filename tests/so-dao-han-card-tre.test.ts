import { describe, expect, it } from "vitest";

import { laDaoHanTre } from "@/components/finance/so-dao-han-card";

/** Ngưỡng "trễ" = 7 ngày sau đáo hạn chưa tất toán (khuôn `khoan-vay-table.tsx`'s `NGAY_COI_LA_TRE`). */
describe("laDaoHanTre", () => {
  it("đúng ngày đáo hạn → chưa trễ", () => {
    expect(laDaoHanTre(new Date(2027, 2, 5), new Date(2027, 2, 5))).toBe(false);
  });

  it("trễ đúng 7 ngày → CHƯA tính là trễ (ngưỡng là '> 7', không phải '>= 7')", () => {
    expect(laDaoHanTre(new Date(2027, 2, 5), new Date(2027, 2, 12))).toBe(false);
  });

  it("trễ 8 ngày → trễ", () => {
    expect(laDaoHanTre(new Date(2027, 2, 5), new Date(2027, 2, 13))).toBe(true);
  });
});
