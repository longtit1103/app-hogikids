import { format } from "date-fns";

import { quyenGiaVonCua } from "@/lib/queries/che-gia-von-types";
import { getVariantsForExport, type VariantRowChe } from "@/lib/queries/variants";
import { congRoute } from "@/lib/quyen/cong-route";
import { ghiNhatKyXuat, phanHoiTaiFile, tuChoiNeuThieuQuyen } from "@/lib/reports/xuat-xlsx-server";

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

const HEADER_CHUNG = ["sku", "ten_san_pham", "bien_the", "ton", "nguong"];
const HEADER_GIA_VON = ["gia_von", "gia_tri_von"];

function cotChung(v: VariantRowChe): (string | number)[] {
  return [v.sku, v.productName, v.label, v.stock, v.effectiveThreshold];
}

/**
 * GET /api/export/ton-kho?q=&loc= — CSV tồn kho theo filter hiện tại (không phân trang).
 * Quyền (spec phân quyền §4.3): `ton-kho:xem` ∧ `xuat-du-lieu`; thiếu `gia-von-loi-nhuan:xem` ⇒ file
 * KHÔNG có cột `gia_von`/`gia_tri_von` (query che không select giá vốn — không phải xoá cột sau).
 */
export async function GET(req: Request): Promise<Response> {
  const c = await congRoute("ton-kho:xem");
  if (!c.ok) return c.response;
  const nd = c.nguoiDung;
  const tuChoi = await tuChoiNeuThieuQuyen(nd, ["xuat-du-lieu"]);
  if (tuChoi) return tuChoi;

  const url = new URL(req.url);
  const q = url.searchParams.get("q") ?? undefined;
  const lowOnly = url.searchParams.get("loc") === "sap_het";

  const kq = await getVariantsForExport({ q, lowOnly }, quyenGiaVonCua(nd));
  const header = kq.coQuyenGiaVon ? [...HEADER_CHUNG, ...HEADER_GIA_VON] : HEADER_CHUNG;
  const dong = kq.coQuyenGiaVon
    ? kq.rows.map((v) => [...cotChung(v), v.costPrice, v.stockValue])
    : kq.rows.map(cotChung);
  const csv = "﻿" + [header.join(","), ...dong.map((d) => d.map(csvField).join(","))].join("\n"); // BOM để Excel nhận UTF-8

  await ghiNhatKyXuat(nd, "ton-kho", { soDong: dong.length });
  return phanHoiTaiFile(csv, `ton-kho-${format(new Date(), "yyyy-MM-dd")}.csv`, "csv");
}
