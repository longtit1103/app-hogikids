/**
 * Hai khối chi tiết của trang chủ thuộc module KHÁC `tong-quan`: chỉ truy vấn khi người xem có quyền xem
 * module đó; thiếu quyền ⇒ KHÔNG query, trả `null` (trang không dựng thẻ). Khối tổng (thẻ số, biểu đồ,
 * tiền đi đâu, theo kênh) thuộc `tong-quan:xem` nên không đi qua đây.
 *
 * - top sản phẩm (doanh thu + số bán từng mã) ⇒ `bao-cao:xem` (cùng nguồn tab Sản phẩm ở /bao-cao)
 * - tồn thấp ⇒ `ton-kho:xem` (spec phân quyền §4.4)
 *
 * Trạng thái đồng bộ KHÔNG còn ở trang chủ (spec trang chủ §2 — chỉ ở `/cai-dat`).
 */
import type { QuyenGiaVon } from "@/lib/queries/che-gia-von-types";
import { getLowStockPreview } from "@/lib/queries/variants";
import { SO_DONG_KHOI_DUOI } from "@/lib/trang-chu/kieu-du-lieu-trang-chu";
import { coQuyen, type NguoiDung } from "@/lib/quyen/nguoi-dung-phien";
import type { DateRange } from "@/lib/date-range";
import { computeProductReport } from "@/lib/reports/product-report";

export async function taiKhoiChiTietDashboard(
  nd: NguoiDung,
  range: DateRange,
  quyenGiaVon: QuyenGiaVon,
) {
  const [productReport, lowStock] = await Promise.all([
    coQuyen(nd, "bao-cao:xem") ? computeProductReport(range, undefined, quyenGiaVon) : null,
    coQuyen(nd, "ton-kho:xem") ? getLowStockPreview(SO_DONG_KHOI_DUOI) : null,
  ]);
  return { productReport, lowStock };
}
