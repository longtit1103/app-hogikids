import { describe, expect, it } from "vitest";

import { UNMATCHED_PRODUCT_ID, type ProductReportRow } from "@/lib/reports/product-report";
import { xepHangLaiSanPham } from "@/lib/trang-chu/xep-hang-lai-san-pham";

/**
 * "Lãi nhiều – nên đẩy" (spec trang chủ §4.6): xếp theo `grossProfit` mức SẢN PHẨM CHA. Sản phẩm có
 * SKU đã bán mà giá vốn 0 (biên 100% ảo) và nhóm "SKU không khớp" phải bị loại, nếu không chúng chiếm
 * đầu bảng.
 */

type Sku = { soldQty: number; revenue: number; cogs: number };

function dong(productId: string, revenue: number, skus: Sku[], extra: Partial<ProductReportRow> = {}): ProductReportRow {
  const soldQty = skus.reduce((s, x) => s + x.soldQty, 0);
  const cogs = skus.reduce((s, x) => s + x.cogs, 0);
  const grossProfit = revenue - cogs;
  return {
    productId,
    name: `SP ${productId}`,
    imageUrl: null,
    soldQty,
    revenue,
    cogs,
    grossProfit,
    marginPct: revenue ? (grossProfit / revenue) * 100 : null,
    currentStock: 10,
    orderCount: 1,
    skus: skus.map((s, i) => ({
      variantId: `${productId}-v${i}`,
      sku: `${productId}-${i}`,
      label: `${i}`,
      soldQty: s.soldQty,
      revenue: s.revenue,
      cogs: s.cogs,
      grossProfit: s.revenue - s.cogs,
      currentStock: 5,
    })),
    ...extra,
  };
}

describe("xepHangLaiSanPham", () => {
  it("xếp theo lãi chứ không theo doanh thu: A doanh thu cao lãi thấp, B ngược lại ⇒ B trước", () => {
    const A = dong("A", 10_000_000, [{ soldQty: 10, revenue: 10_000_000, cogs: 9_000_000 }]); // lãi 1tr
    const B = dong("B", 4_000_000, [{ soldQty: 4, revenue: 4_000_000, cogs: 1_000_000 }]); // lãi 3tr
    const kq = xepHangLaiSanPham([A, B], new Set());
    expect(kq.top.map((d) => d.productId)).toEqual(["B", "A"]);
    expect(kq.top[0]).toEqual({
      productId: "B",
      ten: "SP B",
      loiNhuan: 3_000_000,
      soLuong: 4,
      laiMoiCai: 750_000,
      bienLai: 75,
      tonKho: 10,
      tonThap: false,
    });
    expect(kq.soThieuGiaVon).toBe(0);
  });

  it("sản phẩm thiếu giá vốn (biên 100%, lãi lớn nhất) và dòng 'sku-khong-khop' KHÔNG lên top, đếm đúng", () => {
    const thieu = dong("THIEU", 50_000_000, [
      { soldQty: 5, revenue: 30_000_000, cogs: 10_000_000 },
      { soldQty: 3, revenue: 20_000_000, cogs: 0 }, // một SKU đã bán mà giá vốn 0
    ]);
    const khongKhop = dong(UNMATCHED_PRODUCT_ID, 90_000_000, [{ soldQty: 9, revenue: 90_000_000, cogs: 0 }]);
    const tot = dong("TOT", 2_000_000, [{ soldQty: 2, revenue: 2_000_000, cogs: 1_000_000 }]);
    const kq = xepHangLaiSanPham([khongKhop, thieu, tot], new Set());
    expect(kq.top.map((d) => d.productId)).toEqual(["TOT"]);
    expect(kq.soThieuGiaVon).toBe(2);
  });

  it("SKU chưa bán (soldQty 0) giá vốn 0 KHÔNG làm sản phẩm bị loại", () => {
    const p = dong("P", 1_000_000, [
      { soldQty: 1, revenue: 1_000_000, cogs: 400_000 },
      { soldQty: 0, revenue: 0, cogs: 0 },
    ]);
    expect(xepHangLaiSanPham([p], new Set()).top.map((d) => d.productId)).toEqual(["P"]);
  });

  it("tonThap theo Set productId; laiMoiCai null khi soldQty 0; tie-break theo productId", () => {
    const x = dong("X", 1_000_000, [{ soldQty: 2, revenue: 1_000_000, cogs: 500_000 }]);
    const w = dong("W", 1_000_000, [{ soldQty: 2, revenue: 1_000_000, cogs: 500_000 }]);
    const rong = dong("Z", 100, [], { soldQty: 0, grossProfit: 100, marginPct: null });
    const kq = xepHangLaiSanPham([x, rong, w], new Set(["X"]));
    expect(kq.top.map((d) => d.productId)).toEqual(["W", "X", "Z"]);
    expect(kq.top.find((d) => d.productId === "X")?.tonThap).toBe(true);
    expect(kq.top.find((d) => d.productId === "W")?.tonThap).toBe(false);
    expect(kq.top.find((d) => d.productId === "Z")?.laiMoiCai).toBeNull();
    expect(kq.top.find((d) => d.productId === "Z")?.bienLai).toBeNull();
  });

  it("sản phẩm LỖ và lãi 0 KHÔNG lên top, và KHÔNG tính vào soThieuGiaVon (giá vốn đủ); lỗ bán nhiều nhất cũng vắng", () => {
    const lo = dong("LO", 1_000_000, [{ soldQty: 100, revenue: 1_000_000, cogs: 8_000_000 }]); // lãi −7tr
    const hoa = dong("HOA", 1_000_000, [{ soldQty: 5, revenue: 1_000_000, cogs: 1_000_000 }]); // lãi 0
    const tot = dong("TOT", 2_000_000, [{ soldQty: 2, revenue: 2_000_000, cogs: 1_000_000 }]);
    const thieu = dong("THIEU", 5_000_000, [{ soldQty: 3, revenue: 5_000_000, cogs: 0 }]);
    const kq = xepHangLaiSanPham([lo, hoa, tot, thieu], new Set());
    expect(kq.top.map((d) => d.productId)).toEqual(["TOT"]);
    expect(kq.top.every((d) => d.loiNhuan > 0 && (d.laiMoiCai ?? 1) > 0)).toBe(true);
    expect(kq.soThieuGiaVon).toBe(1); // chỉ THIEU
  });

  it("cắt đúng 5 (mặc định) và theo gioiHan truyền vào", () => {
    const rows = Array.from({ length: 8 }, (_, i) =>
      dong(`P${i}`, 1_000_000, [{ soldQty: 1, revenue: 1_000_000, cogs: 100_000 * (i + 1) }])
    );
    const kq = xepHangLaiSanPham(rows, new Set());
    expect(kq.top).toHaveLength(5);
    expect(kq.top.map((d) => d.productId)).toEqual(["P0", "P1", "P2", "P3", "P4"]);
    expect(xepHangLaiSanPham(rows, new Set(), 3).top).toHaveLength(3);
  });

  it("laiMoiCai làm tròn tới đồng", () => {
    const p = dong("P", 1_000_000, [{ soldQty: 3, revenue: 1_000_000, cogs: 1 }]);
    expect(xepHangLaiSanPham([p], new Set()).top[0]?.laiMoiCai).toBe(Math.round(999_999 / 3));
  });
});
