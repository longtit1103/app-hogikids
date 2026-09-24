import * as XLSX from "xlsx";

import { kiemTranSoDong, parseVnInt, TRAN_DOC_SHEET } from "./xlsx-shared";

/** 1 dòng giá vốn đã chuẩn hoá để import. `lowStockThreshold=null` → giữ nguyên ngưỡng hiện tại. */
export type CostImportRow = { sku: string; costPrice: number; lowStockThreshold: number | null };

/** Ánh xạ tên cột trong file → field. `lowStockThreshold=null` = không map cột ngưỡng. */
export type CostColumnMap = { sku: string; costPrice: string; lowStockThreshold: string | null };

/** Bỏ dấu tiếng Việt + hạ chữ thường + trim (để so tên cột không phân biệt dấu/hoa-thường). */
const norm = (s: string) =>
  s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/đ/gi, "d")
    .toLowerCase()
    .trim();

/** Đọc workbook (sheet đầu) → headers (dòng 1) + rows (object theo header). Dùng client (dynamic import) + test node. */
export function parseCostWorkbook(buf: ArrayBuffer): { headers: string[]; rows: Record<string, string | number>[] } {
  // Cùng trần với `readSheetRows` — file này KHÔNG đi qua đó (nó cần `sheet_to_json` hai dạng khác
  // nhau) nên phải tự áp, kẻo đường nhập giá vốn thành đường duy nhất không có trần. Chạy phía
  // trình duyệt nên bán kính thiệt hại nhỏ hơn, nhưng vẫn treo máy chủ shop.
  const wb = XLSX.read(buf, { type: "array", sheetRows: TRAN_DOC_SHEET });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  if (!sheet) return { headers: [], rows: [] };
  kiemTranSoDong(sheet);
  const aoa = XLSX.utils.sheet_to_json<(string | number)[]>(sheet, { header: 1, defval: "" });
  const headers = (aoa[0] ?? []).map((h) => String(h).trim()).filter((h) => h !== "");
  const rows = XLSX.utils.sheet_to_json<Record<string, string | number>>(sheet, { defval: "" });
  return { headers, rows };
}

/** Đoán cột: "sku|mã sku"→sku; "giá vốn|cost"→costPrice; "ngưỡng|threshold"→lowStockThreshold. Mỗi header map tối đa 1 field. */
export function autoDetectCostColumns(headers: string[]): Partial<CostColumnMap> {
  const out: Partial<CostColumnMap> = {};
  for (const h of headers) {
    const n = norm(h);
    if (!out.sku && n.includes("sku")) out.sku = h;
    else if (!out.costPrice && (n.includes("gia von") || n.includes("cost"))) out.costPrice = h;
    else if (!out.lowStockThreshold && (n.includes("nguong") || n.includes("threshold"))) out.lowStockThreshold = h;
  }
  return out;
}

/**
 * Chuẩn hoá rows theo map. sku trim ≠ rỗng; costPrice int ≥ 0 (sai → error kèm rowIndex = dòng trong file, header=1);
 * ô ngưỡng rỗng hoặc không map → null (giữ nguyên ngưỡng); sku lặp trong file → GIỮ DÒNG CUỐI + đưa vào duplicateSkus.
 */
export function normalizeCostRows(
  rows: Record<string, string | number>[],
  map: CostColumnMap,
): { valid: CostImportRow[]; errors: { rowIndex: number; message: string }[]; duplicateSkus: string[] } {
  const errors: { rowIndex: number; message: string }[] = [];
  const bySku = new Map<string, CostImportRow>();
  const seen = new Set<string>();
  const dup = new Set<string>();

  rows.forEach((row, i) => {
    const rowIndex = i + 2; // dòng 1 = header
    const sku = String(row[map.sku] ?? "").trim();
    if (!sku) {
      errors.push({ rowIndex, message: "Thiếu SKU" });
      return;
    }
    const costPrice = parseVnInt(row[map.costPrice]);
    if (costPrice === null || costPrice < 0) {
      errors.push({ rowIndex, message: `Giá vốn không hợp lệ: "${row[map.costPrice] ?? ""}"` });
      return;
    }
    let lowStockThreshold: number | null = null;
    if (map.lowStockThreshold !== null) {
      const cell = row[map.lowStockThreshold];
      if (String(cell ?? "").trim() !== "") {
        const t = parseVnInt(cell);
        if (t === null || t < 0) {
          errors.push({ rowIndex, message: `Ngưỡng không hợp lệ: "${cell}"` });
          return;
        }
        lowStockThreshold = t;
      }
    }
    if (seen.has(sku)) dup.add(sku);
    seen.add(sku);
    bySku.set(sku, { sku, costPrice, lowStockThreshold }); // last wins
  });

  return { valid: [...bySku.values()], errors, duplicateSkus: [...dup] };
}
