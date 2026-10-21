import { describe, expect, it } from "vitest";

import { chuanHoaSearchParams, chuoiDauTien } from "@/lib/chuan-hoa-search-params";

describe("chuoiDauTien", () => {
  it("giữ nguyên chuỗi và undefined", () => {
    expect(chuoiDauTien("a,b")).toBe("a,b");
    expect(chuoiDauTien("")).toBe("");
    expect(chuoiDauTien(undefined)).toBeUndefined();
  });

  it("mảng (tham số lặp trên URL) lấy phần tử đầu; mảng rỗng là undefined", () => {
    expect(chuoiDauTien(["x", "y"])).toBe("x");
    expect(chuoiDauTien([])).toBeUndefined();
  });
});

describe("chuanHoaSearchParams", () => {
  it("ép mọi khoá về chuỗi để `.split`/`.trim` không ném TypeError", () => {
    const sp = chuanHoaSearchParams<{ kenh?: string; trang_thai?: string; q?: string }>({
      kenh: ["shopee", "tiktok"],
      trang_thai: "huy_bom,hoan_hang",
      q: undefined,
    });
    expect(sp.kenh?.split(",")).toEqual(["shopee"]);
    expect(sp.trang_thai).toBe("huy_bom,hoan_hang");
    expect(sp.q).toBeUndefined();
  });

  it("`?q=a&q=b` (trang Sản phẩm/Tồn kho) ra chuỗi đầu tiên — `.trim()` không ném TypeError", () => {
    const sp = chuanHoaSearchParams<{ q?: string; loc?: string; trang?: string }>({ q: [" áo ", "quần"], loc: ["sap_het", "x"] });
    expect(sp.q?.trim()).toBe("áo");
    expect(sp.loc).toBe("sap_het");
  });

  it("khoá lạ ngoài kiểu khai báo cũng được ép (chuyển hướng giữ bộ lọc không nhận mảng)", () => {
    const sp = chuanHoaSearchParams<{ q?: string }>({ q: "áo", la: ["1", "2"] } as never) as Record<string, unknown>;
    expect(sp.la).toBe("1");
  });
});
