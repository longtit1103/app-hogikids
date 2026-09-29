import { describe, expect, it } from "vitest";

import { NAV_ITEMS, TAB_CHINH_HREFS, TAB_CHINH_ITEMS, laTrangTabChinh } from "@/components/shell/nav-config";

describe("4 tab chính của thanh tab dưới", () => {
  it("đúng thứ tự chủ shop chốt, lấy từ NAV_ITEMS", () => {
    expect(TAB_CHINH_ITEMS.map((i) => i.label)).toEqual(["Dashboard", "Tài chính", "Đơn hàng", "Tồn kho"]);
    for (const h of TAB_CHINH_HREFS) expect(NAV_ITEMS.some((i) => i.href === h)).toBe(true);
  });
  it("laTrangTabChinh: trang con thuộc tab chính vẫn là tab chính", () => {
    expect(laTrangTabChinh("/")).toBe(true);
    expect(laTrangTabChinh("/tai-chinh/thung-rac")).toBe(true);
    expect(laTrangTabChinh("/don-hang")).toBe(true);
  });
  it("laTrangTabChinh: Sản phẩm/Kênh/Marketing/Báo cáo/Cài đặt ⇒ thuộc 'Thêm'", () => {
    for (const p of ["/san-pham", "/san-pham/dong-bo-gia-von", "/kenh/abc", "/marketing", "/bao-cao", "/cai-dat"]) {
      expect(laTrangTabChinh(p), p).toBe(false);
    }
  });
});
