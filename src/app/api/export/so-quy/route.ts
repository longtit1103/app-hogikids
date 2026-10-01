import { format } from "date-fns";

import { ensureRecurringExpensesForMonths } from "@/lib/expenses/ensure-recurring-expenses";
import { congRoute } from "@/lib/quyen/cong-route";
import { docKyThang, dungXlsxBuffer, ghiNhatKyXuat, phanHoiTaiFile, tuChoiNeuThieuQuyen } from "@/lib/reports/xuat-xlsx-server";
import { docSoQuyDongChay } from "@/lib/so-quy/dong-chay-so-quy-queries";
import { buildSoQuySheetRows } from "@/lib/so-quy/xuat-excel-so-quy";

/**
 * GET /api/export/so-quy?ky=yyyy-MM — Excel sổ quỹ (dòng chạy) của một tháng, dựng ở SERVER bằng đúng
 * `docSoQuyDongChay` + `buildSoQuySheetRows` của màn. Quyền (spec phân quyền §4.3):
 * `tai-chinh-so-quy:xem` ∧ `xuat-du-lieu`. Sổ quỹ không có cột giá vốn ⇒ không che gì thêm.
 */
export async function GET(req: Request): Promise<Response> {
  const c = await congRoute("tai-chinh-so-quy:xem");
  if (!c.ok) return c.response;
  const nd = c.nguoiDung;
  const tuChoi = await tuChoiNeuThieuQuyen(nd, ["xuat-du-lieu"]);
  if (tuChoi) return tuChoi;

  const kyRaw = new URL(req.url).searchParams.get("ky");
  const thang = docKyThang(kyRaw);
  if (!thang) return Response.json({ error: "Tham số ky phải dạng yyyy-MM" }, { status: 400 });

  // CÙNG thứ tự ensureRecurring → đọc với tab Sổ quỹ trên màn — lệch là "Cuối kỳ" file ≠ màn hình.
  await ensureRecurringExpensesForMonths([thang.from]);
  const dongChay = await docSoQuyDongChay(thang);
  if (dongChay.trangThai !== "CO_SO") return Response.json({ error: "Kỳ chưa có số" }, { status: 404 });

  const ky = format(thang.from, "yyyy-MM");
  const laThangHienTai = ky === format(new Date(), "yyyy-MM");
  const rows = buildSoQuySheetRows(dongChay, laThangHienTai);
  const buf = dungXlsxBuffer([{ name: "Sổ quỹ", rows }]);
  await ghiNhatKyXuat(nd, "so-quy", { ky, soDong: rows.length });
  return phanHoiTaiFile(buf, `hogikids-so-quy-${ky}.xlsx`, "xlsx");
}
