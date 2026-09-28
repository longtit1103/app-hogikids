import { format } from "date-fns";
import * as XLSX from "xlsx";

import { getVariantsForExport } from "@/lib/queries/variants";
import { requireUser } from "@/lib/session";

/** GET /api/export/gia-von — file mẫu import: SKU hiện có + giá vốn/ngưỡng hiện tại. */
export async function GET(): Promise<Response> {
  await requireUser();

  const variants = await getVariantsForExport({});
  const rows = variants.map((v) => ({
    SKU: v.sku,
    "Tên sản phẩm": v.productName,
    "Giá vốn": v.costPrice,
    Ngưỡng: v.lowStockThreshold ?? "",
  }));

  const ws = XLSX.utils.json_to_sheet(rows, { header: ["SKU", "Tên sản phẩm", "Giá vốn", "Ngưỡng"] });
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Gia von");
  const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;

  const filename = `gia-von-${format(new Date(), "yyyy-MM-dd")}.xlsx`;
  return new Response(new Uint8Array(buf), {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "X-Content-Type-Options": "nosniff", // chặn browser sniff bytes thành type khác
      "Cache-Control": "no-store", // dữ liệu giá vốn — không để browser/CDN cache
    },
  });
}
