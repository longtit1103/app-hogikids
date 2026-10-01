import { describe, expect, it } from "vitest";

import {
  NAV_ITEMS,
  getPageTitle,
  hrefDuocPhep,
  locNavTheoHref,
  tabChinhTheoHref,
} from "@/components/shell/nav-config";
import type { Quyen } from "@/lib/quyen/danh-muc-quyen";

const staff = (...q: Quyen[]) => ({ role: "STAFF" as const, quyen: new Set<Quyen>(q) });

describe("hrefDuocPhep", () => {
  it("mẫu Kho ⇒ đúng đơn hàng, sản phẩm, tồn kho", () => {
    expect(hrefDuocPhep(staff("don-hang:xem", "san-pham:xem", "ton-kho:xem"))).toEqual([
      "/don-hang",
      "/san-pham",
      "/ton-kho",
    ]);
  });
  it("chủ shop ⇒ đủ 8 mục + cài đặt + quản trị", () => {
    const h = hrefDuocPhep({ role: "OWNER", quyen: new Set() });
    expect(h).toHaveLength(10);
    expect(h).toContain("/cai-dat");
    expect(h.at(-1)).toBe("/quan-tri");
  });
  it("chỉ sổ quỹ ⇒ có /tai-chinh, không có quản trị", () => {
    expect(hrefDuocPhep(staff("tai-chinh-so-quy:xem"))).toEqual(["/tai-chinh"]);
  });
  it("chỉ chi-phi:xem cũng vào được /tai-chinh", () => {
    expect(hrefDuocPhep(staff("chi-phi:xem"))).toContain("/tai-chinh");
  });
  it("STAFF không bao giờ thấy /quan-tri", () => {
    expect(hrefDuocPhep(staff("cai-dat:xem", "cai-dat:sua"))).not.toContain("/quan-tri");
  });
  it("không quyền ⇒ rỗng", () => {
    expect(hrefDuocPhep(staff())).toEqual([]);
  });
});

describe("locNavTheoHref / tabChinhTheoHref", () => {
  it("giữ thứ tự gốc và icon", () => {
    const r = locNavTheoHref(NAV_ITEMS, ["/ton-kho", "/don-hang"]);
    expect(r.map((i) => i.href)).toEqual(["/don-hang", "/ton-kho"]);
    expect(r[0]?.icon).toBe(NAV_ITEMS.find((i) => i.href === "/don-hang")?.icon);
  });
  it("tab dưới: bỏ Dashboard khi không có quyền ⇒ tab đầu là mục còn lại", () => {
    expect(tabChinhTheoHref(["/don-hang", "/ton-kho", "/san-pham"]).map((i) => i.href)).toEqual([
      "/don-hang",
      "/ton-kho",
    ]);
  });
  it("tab dưới rỗng khi không href nào", () => {
    expect(tabChinhTheoHref([])).toEqual([]);
  });
});

describe("getPageTitle", () => {
  it("giữ hành vi, thêm Quản trị", () => {
    expect(getPageTitle("/")).toBe("Dashboard");
    expect(getPageTitle("/tai-chinh/thung-rac")).toBe("Tài chính");
    expect(getPageTitle("/quan-tri/tai-khoan")).toBe("Quản trị");
    expect(getPageTitle("/xyz")).toBe("HogiKids");
  });
});
