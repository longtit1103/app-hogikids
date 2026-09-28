import { format } from "date-fns";

import { getVariantsForExport } from "@/lib/queries/variants";
import { requireUser } from "@/lib/session";

/**
 * Escape CSV: chống formula injection (Excel/Sheets thực thi ô bắt đầu = + - @ tab/CR)
 * bằng cách prefix dấu '; bọc "" khi chứa phẩy/ngoặc/xuống dòng; nhân đôi " bên trong.
 */
function csvField(v: string | number): string {
  let s = String(v);
  if (typeof v === "string" && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

/** GET /api/export/ton-kho?q=&loc= — CSV tồn kho theo filter hiện tại (không phân trang). */
export async function GET(req: Request): Promise<Response> {
  await requireUser();

  const url = new URL(req.url);
  const q = url.searchParams.get("q") ?? undefined;
  const lowOnly = url.searchParams.get("loc") === "sap_het";

  const rows = await getVariantsForExport({ q, lowOnly });
  const header = ["sku", "ten_san_pham", "bien_the", "ton", "nguong", "gia_von", "gia_tri_von"];
  const lines = [
    header.join(","),
    ...rows.map((v) =>
      [
        csvField(v.sku),
        csvField(v.productName),
        csvField(v.label),
        csvField(v.stock),
        csvField(v.effectiveThreshold),
        csvField(v.costPrice),
        csvField(v.stockValue),
      ].join(","),
    ),
  ];
  const csv = "﻿" + lines.join("\n"); // BOM để Excel nhận UTF-8

  const filename = `ton-kho-${format(new Date(), "yyyy-MM-dd")}.csv`;
  return new Response(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "X-Content-Type-Options": "nosniff", // chặn browser sniff bytes thành type khác
      "Cache-Control": "no-store", // dữ liệu tồn kho/giá vốn — không để browser/CDN cache
    },
  });
}
