import { format } from "date-fns";

import { quyenGiaVonCua } from "@/lib/queries/che-gia-von-types";
import { getVariantsForExport } from "@/lib/queries/variants";
import { congRoute } from "@/lib/quyen/cong-route";
import { dungXlsxBuffer, ghiNhatKyXuat, phanHoiTaiFile, tuChoiNeuThieuQuyen } from "@/lib/reports/xuat-xlsx-server";

const HEADER = ["SKU", "Tên sản phẩm", "Giá vốn", "Ngưỡng"];

/**
 * GET /api/export/gia-von — file mẫu import: SKU hiện có + giá vốn/ngưỡng hiện tại.
 * Quyền (spec phân quyền §4.3): `san-pham:xem` ∧ `gia-von-loi-nhuan:xem` ∧ `xuat-du-lieu` — file này
 * vô nghĩa khi che giá vốn nên thiếu quyền giá vốn là 403, không phải file thiếu cột.
 */
export async function GET(): Promise<Response> {
  const c = await congRoute("san-pham:xem");
  if (!c.ok) return c.response;
  const nd = c.nguoiDung;
  const tuChoi = await tuChoiNeuThieuQuyen(nd, ["gia-von-loi-nhuan:xem", "xuat-du-lieu"]);
  if (tuChoi) return tuChoi;

  const kq = await getVariantsForExport({}, quyenGiaVonCua(nd));
  // Đã kiểm quyền giá vốn ngay trên — nhánh che ở đây là bất khả; vẫn narrow thay vì ép kiểu.
  if (!kq.coQuyenGiaVon) return Response.json({ error: "Thiếu quyền xem giá vốn" }, { status: 403 });

  const rows = kq.rows.map((v) => ({
    SKU: v.sku,
    "Tên sản phẩm": v.productName,
    "Giá vốn": v.costPrice,
    Ngưỡng: v.lowStockThreshold ?? "",
  }));
  const buf = dungXlsxBuffer([{ name: "Gia von", rows, header: HEADER }]);
  await ghiNhatKyXuat(nd, "gia-von", { soDong: rows.length });
  return phanHoiTaiFile(buf, `gia-von-${format(new Date(), "yyyy-MM-dd")}.xlsx`, "xlsx");
}
