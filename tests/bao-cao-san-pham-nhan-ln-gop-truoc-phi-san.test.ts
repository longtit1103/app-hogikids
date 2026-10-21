import { describe, expect, it } from "vitest";

import { buildProductSheetRows } from "@/lib/reports/bao-cao-sheet-rows";
import type { ProductReportRow } from "@/lib/reports/product-report";

/**
 * Lãi gộp THEO SẢN PHẨM = doanh thu dòng hàng − COGS — CHƯA trừ voucher cả đơn lẫn phí sàn (hai
 * khoản ấy thuộc đơn, không thuộc từng sản phẩm). "LN gộp" ở bảng Lãi/Lỗ thì ĐÃ trừ cả hai. Cùng một
 * chữ cho hai con số khác nghĩa ⇒ Σ "LN gộp" các sản phẩm vượt "LN gộp" Lãi/Lỗ (phần lớn là phí sàn +
 * voucher của kỳ), và biên SP cao ảo cùng tỉ lệ. Số giữ nguyên; nhãn phải nói rõ "trước phí sàn".
 */

const DONG: ProductReportRow = {
  productId: "p1",
  name: "Váy lụa",
  imageUrl: null,
  soldQty: 2,
  revenue: 600_000,
  cogs: 200_000,
  grossProfit: 400_000,
  marginPct: 66.666,
  currentStock: 5,
  orderCount: 2,
  skus: [
    {
      variantId: "v1",
      sku: "SKU-1",
      label: "M",
      soldQty: 2,
      revenue: 600_000,
      currentStock: 5,
      cogs: 200_000,
      grossProfit: 400_000,
    },
  ],
};

describe("buildProductSheetRows — nhãn lãi gộp theo sản phẩm", () => {
  it("sheet Sản phẩm: cột lãi/biên ghi rõ TRƯỚC phí sàn & voucher, không dùng nhãn trần của bảng Lãi/Lỗ", () => {
    const [sp] = buildProductSheetRows([DONG]);
    const dong = sp.rows[0];

    expect(dong).toMatchObject({
      "LN gộp trước phí sàn & voucher": 400_000,
      "Biên % trước phí sàn & voucher": 66.7,
    });
    expect(Object.keys(dong)).not.toContain("LN gộp");
    expect(Object.keys(dong)).not.toContain("Biên %");
  });

  it("sheet SKU: cùng nhãn, số không đổi", () => {
    const [, sku] = buildProductSheetRows([DONG]);
    const dong = sku.rows[0];

    expect(dong).toMatchObject({ "LN gộp trước phí sàn & voucher": 400_000, COGS: 200_000 });
    expect(Object.keys(dong)).not.toContain("LN gộp");
  });
});
