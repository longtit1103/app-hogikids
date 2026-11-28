import { format } from "date-fns";

import { dungSheetXuatDonHang } from "@/lib/orders/cot-xuat-excel-don-hang";
import { docThamSoDonHang } from "@/lib/orders/doc-tham-so-don-hang";
import { getDonHangXuat } from "@/lib/queries/orders-xuat-don-hang";
import { quyenGiaVonCua } from "@/lib/queries/che-gia-von-types";
import { congRoute } from "@/lib/quyen/cong-route";
import { dungXlsxBuffer, ghiNhatKyXuat, phanHoiTaiFile, tuChoiNeuThieuQuyen } from "@/lib/reports/xuat-xlsx-server";

/**
 * GET /api/export/don-hang?<tham số như trang> — Excel đúng tập đơn đang lọc + đúng thứ tự sắp xếp của
 * `/don-hang`, không phân trang (trần `TRAN_DONG_XUAT_DON_HANG`).
 *
 * Quyền: `don-hang:xem` ∧ `xuat-du-lieu`. Thiếu `gia-von-loi-nhuan:xem` ⇒ file KHÔNG có cột Giá vốn/Lãi
 * đơn/Biên/Thiếu giá vốn, và `loc=lo|thieu_gv`, `sx=lai_*` bị bỏ y như trang (cùng `docThamSoDonHang`
 * ⇒ không suy được lãi qua tập đơn hay thứ tự dòng).
 */
export async function GET(req: Request): Promise<Response> {
  const c = await congRoute("don-hang:xem");
  if (!c.ok) return c.response;
  const nd = c.nguoiDung;
  const tuChoi = await tuChoiNeuThieuQuyen(nd, ["xuat-du-lieu"]);
  if (tuChoi) return tuChoi;

  // Lấy giá trị ĐẦU của mỗi khoá lặp — cùng nghĩa với cách trang chuẩn hoá `searchParams`, để file ra
  // đúng tập mà màn hình đang hiện.
  const thamSo: Record<string, string> = {};
  for (const [khoa, giaTri] of new URL(req.url).searchParams) {
    if (!Object.hasOwn(thamSo, khoa)) thamSo[khoa] = giaTri;
  }

  const now = new Date();
  const quyen = quyenGiaVonCua(nd);
  const boLoc = docThamSoDonHang(thamSo, quyen, now);
  const kq = await getDonHangXuat(boLoc, quyen, now);

  // Vượt trần ⇒ từ chối rõ ràng, không cắt câm (file thiếu đơn mà không báo sẽ làm sai số cộng).
  if (kq.vuotTran) {
    return Response.json(
      { error: "Quá nhiều đơn — thu hẹp kỳ hoặc bộ lọc", code: "QUA_NHIEU_DONG" },
      { status: 400 },
    );
  }

  const sheet = dungSheetXuatDonHang(kq);
  const buf = dungXlsxBuffer([sheet]);
  await ghiNhatKyXuat(nd, "don-hang", { soDong: sheet.rows.length });
  return phanHoiTaiFile(buf, `don-hang-${format(now, "yyyy-MM-dd")}.xlsx`, "xlsx");
}
