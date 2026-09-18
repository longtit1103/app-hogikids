import { describe, expect, it } from "vitest";

import { hrefTabMarketing, isMarketingTab } from "@/components/marketing/marketing-tab-nav";

/**
 * Chuyển tab PHẢI giữ kỳ đang xem (spec §4.1) — khuôn `tabHref` của `/tai-chinh`.
 * Mất kỳ khi đổi tab = chủ shop đang soi tháng 7 bấm sang "Nội dung" thì nhảy về tháng này
 * mà không có dấu hiệu gì.
 */
describe("hrefTabMarketing", () => {
  it("tab mặc định không ghi ?tab=", () => {
    expect(hrefTabMarketing("tong-quan", {})).toBe("/marketing");
  });

  it("giữ khoảng tuỳ chọn tu/den", () => {
    expect(hrefTabMarketing("noi-dung", { tu: "2026-07-01", den: "2026-07-31" })).toBe(
      "/marketing?tab=noi-dung&tu=2026-07-01&den=2026-07-31"
    );
  });

  it("giữ preset khi không có tu/den", () => {
    expect(hrefTabMarketing("quang-cao", { range: "last_month" })).toBe("/marketing?tab=quang-cao&range=last_month");
  });

  it("tu/den thắng preset (khớp thứ tự ưu tiên của resolveRangeFromParams)", () => {
    expect(hrefTabMarketing("creator", { tu: "2026-07-01", den: "2026-07-31", range: "7d" })).toBe(
      "/marketing?tab=creator&tu=2026-07-01&den=2026-07-31"
    );
  });

  it("tu thiếu den ⇒ KHÔNG ghi nửa khoảng (nửa khoảng làm resolveRangeFromParams rơi về mặc định câm)", () => {
    expect(hrefTabMarketing("san-pham", { tu: "2026-07-01" })).toBe("/marketing?tab=san-pham");
  });

  it("isMarketingTab chỉ nhận đúng 5 slug", () => {
    for (const t of ["tong-quan", "noi-dung", "creator", "quang-cao", "san-pham"]) expect(isMarketingTab(t)).toBe(true);
    for (const t of [undefined, "", "pnl", "TONG-QUAN"]) expect(isMarketingTab(t as string | undefined)).toBe(false);
  });
});
