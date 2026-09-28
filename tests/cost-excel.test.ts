import * as XLSX from "xlsx";
import { describe, expect, it } from "vitest";

import { autoDetectCostColumns, normalizeCostRows, parseCostWorkbook } from "@/lib/import/cost-excel";

function makeXlsxBuffer(aoa: (string | number)[][]): ArrayBuffer {
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Sheet1");
  return XLSX.write(wb, { type: "array", bookType: "xlsx" }) as ArrayBuffer;
}

describe("parseCostWorkbook", () => {
  it("đọc headers (dòng 1) + rows theo header", () => {
    const buf = makeXlsxBuffer([
      ["Mã SKU", "Giá vốn", "Ngưỡng"],
      ["SB01", "45000", 5],
    ]);
    const { headers, rows } = parseCostWorkbook(buf);
    expect(headers).toEqual(["Mã SKU", "Giá vốn", "Ngưỡng"]);
    expect(rows).toHaveLength(1);
    expect(rows[0]["Mã SKU"]).toBe("SB01");
  });
});

describe("autoDetectCostColumns — khớp tên cột không phân biệt dấu/hoa-thường", () => {
  it("Mã SKU / Giá vốn / Ngưỡng", () => {
    expect(autoDetectCostColumns(["Mã SKU", "Giá vốn", "Ngưỡng"])).toEqual({
      sku: "Mã SKU",
      costPrice: "Giá vốn",
      lowStockThreshold: "Ngưỡng",
    });
  });
  it("cost / threshold (tiếng Anh) + thiếu cột ngưỡng", () => {
    const m = autoDetectCostColumns(["SKU", "Cost", "Tên"]);
    expect(m.sku).toBe("SKU");
    expect(m.costPrice).toBe("Cost");
    expect(m.lowStockThreshold).toBeUndefined();
  });
});

describe("normalizeCostRows", () => {
  const map = { sku: "sku", costPrice: "gia_von", lowStockThreshold: "nguong" };

  it('"45.000" / "45,000" → 45000; ô ngưỡng rỗng → null', () => {
    const r = normalizeCostRows(
      [
        { sku: "A", gia_von: "45.000", nguong: "" },
        { sku: "B", gia_von: "45,000", nguong: "" },
      ],
      map,
    );
    expect(r.valid).toEqual([
      { sku: "A", costPrice: 45000, lowStockThreshold: null },
      { sku: "B", costPrice: 45000, lowStockThreshold: null },
    ]);
    expect(r.errors).toHaveLength(0);
  });

  it("costPrice âm/chữ → error kèm rowIndex (header=1)", () => {
    const r = normalizeCostRows(
      [
        { sku: "A", gia_von: "-5000", nguong: "" },
        { sku: "B", gia_von: "abc", nguong: "" },
      ],
      map,
    );
    expect(r.valid).toHaveLength(0);
    expect(r.errors.map((e) => e.rowIndex)).toEqual([2, 3]);
  });

  it("ngưỡng có giá trị → parse; thiếu SKU → error", () => {
    const r = normalizeCostRows(
      [
        { sku: "A", gia_von: "1000", nguong: "5" },
        { sku: "  ", gia_von: "1000", nguong: "" },
      ],
      map,
    );
    expect(r.valid).toEqual([{ sku: "A", costPrice: 1000, lowStockThreshold: 5 }]);
    expect(r.errors[0].message).toContain("SKU");
  });

  it("sku lặp → giữ dòng CUỐI + duplicateSkus", () => {
    const r = normalizeCostRows(
      [
        { sku: "A", gia_von: "1000", nguong: "" },
        { sku: "A", gia_von: "2000", nguong: "" },
      ],
      map,
    );
    expect(r.valid).toEqual([{ sku: "A", costPrice: 2000, lowStockThreshold: null }]);
    expect(r.duplicateSkus).toEqual(["A"]);
  });
});
