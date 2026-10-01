/**
 * Ba khối chi tiết của Dashboard thuộc module KHÁC `tong-quan`: chỉ truy vấn khi người xem có quyền xem
 * module đó; thiếu quyền ⇒ KHÔNG query, trả `null` (trang không dựng thẻ). Khối tổng (KPI, biểu đồ
 * doanh thu/lợi nhuận, donut kênh) thuộc `tong-quan:xem` nên không đi qua đây.
 *
 * - top sản phẩm (doanh thu + số bán từng mã) ⇒ `bao-cao:xem` (cùng nguồn tab Sản phẩm ở /bao-cao)
 * - tồn thấp ⇒ `ton-kho:xem` (spec phân quyền §4.4)
 * - trạng thái đồng bộ (kèm thông điệp lỗi) ⇒ `cai-dat:xem`
 */
import { prisma } from "@/lib/prisma";
import type { QuyenGiaVon } from "@/lib/queries/che-gia-von-types";
import { getLowStockPreview } from "@/lib/queries/variants";
import { coQuyen, type NguoiDung } from "@/lib/quyen/nguoi-dung-phien";
import type { DateRange } from "@/lib/date-range";
import { computeProductReport } from "@/lib/reports/product-report";

import type { SyncKind } from "@/generated/prisma/client";

export const SYNC_KINDS_DASHBOARD: SyncKind[] = [
  "PANCAKE",
  "META_ADS",
  "TIKTOK_ADS",
  "TIKTOK_SHOP",
  "TIKTOK_SHOP_ANALYTICS",
];

export async function taiKhoiChiTietDashboard(
  nd: NguoiDung,
  range: DateRange,
  quyenGiaVon: QuyenGiaVon,
) {
  const [productReport, lowStock, syncLogs] = await Promise.all([
    coQuyen(nd, "bao-cao:xem") ? computeProductReport(range, undefined, quyenGiaVon) : null,
    coQuyen(nd, "ton-kho:xem") ? getLowStockPreview() : null,
    coQuyen(nd, "cai-dat:xem")
      ? Promise.all(
          SYNC_KINDS_DASHBOARD.map((kind) => prisma.syncLog.findFirst({ where: { kind }, orderBy: { startedAt: "desc" } })),
        )
      : null,
  ]);
  return { productReport, lowStock, syncLogs };
}
