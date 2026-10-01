import { format, startOfMonth, subMonths, endOfMonth } from "date-fns";

import { parseDateRange } from "@/lib/date-range";
import { ensureRecurringExpensesForMonths } from "@/lib/expenses/ensure-recurring-expenses";
import { quyenGiaVonCua } from "@/lib/queries/che-gia-von-types";
import type { Quyen } from "@/lib/quyen/danh-muc-quyen";
import { congRoute } from "@/lib/quyen/cong-route";
import { buildPnlSheetRows, buildProductSheets, buildTrendSheets } from "@/lib/reports/bao-cao-sheet-rows";
import type { ExportSheet } from "@/lib/reports/export-excel";
import { computeMonthlyTrend } from "@/lib/reports/monthly-trend";
import { calcPnl } from "@/lib/reports/pnl";
import { computeBackfilledPlatformFee, computePlatformFeeComponents } from "@/lib/reports/platform-fee-breakdown";
import { computeProductReport } from "@/lib/reports/product-report";
import { computeVoucherBreakdown } from "@/lib/reports/voucher-breakdown";
import {
  docKyThang,
  dungXlsxBuffer,
  ghiNhatKyXuat,
  phanHoiTaiFile,
  tuChoiNeuThieuQuyen,
} from "@/lib/reports/xuat-xlsx-server";

type TabXuat = "pnl" | "san-pham" | "xu-huong";

function laTabXuat(v: string | null): v is TabXuat {
  return v === "pnl" || v === "san-pham" || v === "xu-huong";
}

/**
 * Quyền PHẢI CÓ ĐỦ theo từng tab (spec phân quyền §4.3, chốt 01/10). Lãi/Lỗ thuộc module Lãi/Lỗ (tab
 * `/tai-chinh`), KHÔNG thuộc Báo cáo ⇒ `pnl` đòi `tai-chinh-loi-lo:xem` ∧ giá vốn (P&L bản chất là lợi
 * nhuận) ∧ xuất, không đòi `bao-cao:xem`. Sản phẩm / Xu hướng là của trang Báo cáo ⇒ `bao-cao:xem` ∧ xuất.
 */
function quyenCanDu(tab: TabXuat): Quyen[] {
  return tab === "pnl"
    ? ["tai-chinh-loi-lo:xem", "gia-von-loi-nhuan:xem", "xuat-du-lieu"]
    : ["bao-cao:xem", "xuat-du-lieu"];
}

const loi400 = (error: string) => Response.json({ error }, { status: 400 });

/**
 * GET /api/export/bao-cao?tab=pnl&ky=yyyy-MM | tab=san-pham&tu=&den=[&kenh=] | tab=xu-huong
 *
 * File Excel dựng ở SERVER bằng đúng các hàm tính của màn hình (`calcPnl`, `computeProductReport`,
 * `computeMonthlyTrend` — không công thức tiền mới). Tab Sản phẩm / Xu hướng dùng DTO che khi người
 * xem thiếu `gia-von-loi-nhuan:xem` (file không có cột COGS/lãi/biên); tab Lãi/Lỗ đòi đủ quyền.
 */
export async function GET(req: Request): Promise<Response> {
  // Cổng thô = có ÍT NHẤT MỘT trong hai module sở hữu các tab xuất (Báo cáo | Lãi/Lỗ) — phải là câu lệnh
  // đầu (lưới AST) nên chưa biết `tab`. Quyền ĐỦ theo từng tab kiểm ngay sau ở `quyenCanDu(tab)`.
  const c = await congRoute(["bao-cao:xem", "tai-chinh-loi-lo:xem"]);
  if (!c.ok) return c.response;
  const nd = c.nguoiDung;

  const url = new URL(req.url);
  const tab = url.searchParams.get("tab");
  if (!laTabXuat(tab)) return loi400("Tham số tab không hợp lệ (pnl | san-pham | xu-huong)");
  const tuChoi = await tuChoiNeuThieuQuyen(nd, quyenCanDu(tab));
  if (tuChoi) return tuChoi;
  const quyen = quyenGiaVonCua(nd);

  let sheets: ExportSheet[];
  let ky: string;

  if (tab === "pnl") {
    const thang = docKyThang(url.searchParams.get("ky"));
    if (!thang) return loi400("Tham số ky phải dạng yyyy-MM");
    const prevStart = startOfMonth(subMonths(thang.from, 1));
    const thangTruoc = { from: prevStart, to: endOfMonth(prevStart) };
    // Cùng thứ tự màn Lãi/Lỗ: backfill chi phí định kỳ 2 tháng TRƯỚC khi tính — thiếu là LN cao ảo.
    await ensureRecurringExpensesForMonths([thang.from, thangTruoc.from]);
    const [monthPnl, prevMonthPnl, fee, prevFee, voucher, prevVoucher, backfilled, prevBackfilled] = await Promise.all([
      calcPnl(thang),
      calcPnl(thangTruoc),
      computePlatformFeeComponents(thang),
      computePlatformFeeComponents(thangTruoc),
      computeVoucherBreakdown(thang),
      computeVoucherBreakdown(thangTruoc),
      computeBackfilledPlatformFee(thang),
      computeBackfilledPlatformFee(thangTruoc),
    ]);
    sheets = buildPnlSheetRows(monthPnl, prevMonthPnl, fee, prevFee, voucher, prevVoucher, backfilled, prevBackfilled);
    ky = format(thang.from, "yyyy-MM");
  } else if (tab === "san-pham") {
    const range = parseDateRange({ tu: url.searchParams.get("tu") ?? undefined, den: url.searchParams.get("den") ?? undefined });
    if (!range) return loi400("Tham số tu/den phải dạng yyyy-MM-dd");
    const channelId = url.searchParams.get("kenh") || undefined;
    sheets = buildProductSheets(await computeProductReport(range, { channelId }, quyen));
    ky = `${format(range.from, "yyMMdd")}-${format(range.to, "yyMMdd")}`;
  } else {
    const now = new Date();
    // Khớp cách `computeMonthlyTrend(12)` dựng danh sách tháng — backfill đủ 12 tháng trước khi tính.
    await ensureRecurringExpensesForMonths(Array.from({ length: 12 }, (_, i) => startOfMonth(subMonths(now, i))));
    sheets = buildTrendSheets(await computeMonthlyTrend(12, quyen));
    ky = format(now, "yyyy-MM");
  }

  const buf = dungXlsxBuffer(sheets);
  await ghiNhatKyXuat(nd, `bao-cao:${tab}`, { ky });
  return phanHoiTaiFile(buf, `hogikids-${tab}-${ky}.xlsx`, "xlsx");
}
