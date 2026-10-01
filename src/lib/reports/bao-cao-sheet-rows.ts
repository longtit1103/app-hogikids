import type { ExportSheet } from "@/lib/reports/export-excel";
import type { MonthlyTrend, MonthlyTrendRow, MonthlyTrendRowChe } from "@/lib/reports/monthly-trend";
import type { PnlBreakdown } from "@/lib/reports/pnl";
import { buildPnlLineItems, displayValue } from "@/lib/reports/pnl-line-items";
import { pnlPercentBase } from "@/lib/reports/pnl-percent-base";
import type { PlatformFeeComponent } from "@/lib/reports/platform-fee-breakdown";
import type { ProductReport, ProductReportRow, ProductReportRowChe } from "@/lib/reports/product-report";
import { monthLabel } from "@/lib/reports/trend-format";
import type { VoucherBreakdown } from "@/lib/reports/voucher-breakdown";

/**
 * Dòng sheet Excel cho các file xuất BÁO CÁO — module THUẦN, chạy ở route server
 * (`/api/export/bao-cao`). Trước đây nằm trong component client và file được dựng trong trình duyệt;
 * spec phân quyền §4.3 chuyển 100 % xuất file lên server để cổng quyền + che giá vốn áp được cho
 * file y như cho màn hình. Hai biến thể `…Che` không có cột COGS/lãi/biên (người thiếu
 * `gia-von-loi-nhuan:xem`) — dựng từ DTO che, không phải xoá cột của bản đầy đủ.
 */

// ─── Sản phẩm ─────────────────────────────────────────────────────────────────────────────────────

/**
 * Sheet dùng CHUNG shape với bảng trên màn (2 sheet: "Sản phẩm" mức SP, "SKU" mức biến thể) — luôn
 * xuất TOÀN BỘ `rows` theo range toàn cục hiện tại (không theo sub-tab/tìm kiếm đang lọc trên màn —
 * khớp "Xuất Excel theo TAB đang mở", không phải theo bộ lọc con nhất thời).
 */
export function buildProductSheetRows(rows: ProductReportRow[]): ExportSheet[] {
  const productRows = rows.map((r) => ({
    "Sản phẩm": r.name,
    "SL bán": r.soldQty,
    "Doanh thu": r.revenue,
    COGS: r.cogs,
    "LN gộp": r.grossProfit,
    "Biên %": r.marginPct === null ? "" : Math.round(r.marginPct * 10) / 10,
    Tồn: r.currentStock,
  }));
  const skuRows = rows.flatMap((r) =>
    r.skus.map((s) => ({
      "Sản phẩm": r.name,
      SKU: s.sku,
      "Biến thể": s.label,
      "SL bán": s.soldQty,
      "Doanh thu": s.revenue,
      COGS: s.cogs,
      "LN gộp": s.grossProfit,
      Tồn: s.currentStock,
    }))
  );
  return [
    { name: "Sản phẩm", rows: productRows },
    { name: "SKU", rows: skuRows },
  ];
}

/** Như trên, không cột COGS/LN gộp/Biên. */
export function buildProductSheetRowsChe(rows: ProductReportRowChe[]): ExportSheet[] {
  const productRows = rows.map((r) => ({
    "Sản phẩm": r.name,
    "SL bán": r.soldQty,
    "Doanh thu": r.revenue,
    Tồn: r.currentStock,
  }));
  const skuRows = rows.flatMap((r) =>
    r.skus.map((s) => ({
      "Sản phẩm": r.name,
      SKU: s.sku,
      "Biến thể": s.label,
      "SL bán": s.soldQty,
      "Doanh thu": s.revenue,
      Tồn: s.currentStock,
    }))
  );
  return [
    { name: "Sản phẩm", rows: productRows },
    { name: "SKU", rows: skuRows },
  ];
}

export function buildProductSheets(bang: ProductReport): ExportSheet[] {
  return bang.coQuyenGiaVon ? buildProductSheetRows(bang.rows) : buildProductSheetRowsChe(bang.rows);
}

// ─── Xu hướng ─────────────────────────────────────────────────────────────────────────────────────

/** Luôn xuất đủ 12 tháng (nhiều hơn cửa sổ 6 tháng mặc định trên màn, không ít hơn). */
export function buildTrendSheetRows(rows: MonthlyTrendRow[]) {
  return rows.map((r) => ({
    Tháng: monthLabel(r.month),
    "Doanh thu": r.revenue,
    "DT thuần": r.netRevenue,
    "LN ròng": r.netProfit,
    "Thu nhập tài chính": r.financialIncome,
    "Biên ròng %": r.marginPct === null ? "" : Math.round(r.marginPct * 10) / 10,
    "Số đơn": r.orderCount,
    "Hoàn/bom %": Math.round(r.returnBomRatePct * 10) / 10,
  }));
}

/** Như trên, không cột LN ròng/Thu nhập tài chính/Biên. */
export function buildTrendSheetRowsChe(rows: MonthlyTrendRowChe[]) {
  return rows.map((r) => ({
    Tháng: monthLabel(r.month),
    "Doanh thu": r.revenue,
    "DT thuần": r.netRevenue,
    "Số đơn": r.orderCount,
    "Hoàn/bom %": Math.round(r.returnBomRatePct * 10) / 10,
  }));
}

export function buildTrendSheets(trend: MonthlyTrend): ExportSheet[] {
  const rows = trend.coQuyenGiaVon ? buildTrendSheetRows(trend.rows) : buildTrendSheetRowsChe(trend.rows);
  return [{ name: "Xu hướng", rows }];
}

// ─── Lãi/Lỗ (chỉ người có `tai-chinh-loi-lo:xem` ∧ giá vốn — route kiểm) ─────────────────────────

/**
 * Bảng P&L → dòng sheet Excel, dùng LẠI `buildPnlLineItems` cho thứ tự + nhãn dòng — không viết lại
 * danh sách khoản mục lần 2 (đúng chỗ dễ lệch số nếu 2 nơi tự khai báo độc lập).
 */
export function buildPnlSheetRows(
  monthPnl: PnlBreakdown,
  prevMonthPnl: PnlBreakdown,
  feeComponents: PlatformFeeComponent[] = [],
  prevFeeComponents: PlatformFeeComponent[] = [],
  voucher?: VoucherBreakdown,
  prevVoucher?: VoucherBreakdown,
  backfilledFee = 0,
  prevBackfilledFee = 0
): ExportSheet[] {
  // Excel xuất ĐẦY ĐỦ dòng con (kể cả dòng đang thu gọn trên màn) — file để đối
  // chiếu ngoài app, không phải ảnh chụp màn hình.
  const items = buildPnlLineItems(monthPnl, feeComponents, voucher, backfilledFee);
  const prevById = new Map(
    buildPnlLineItems(prevMonthPnl, prevFeeComponents, prevVoucher, prevBackfilledFee).map((i) => [i.id, i])
  );

  const pctBase = pnlPercentBase(monthPnl);
  const rows = items.map((item) => {
    const amount = displayValue(item);
    const pct = pctBase ? (amount / pctBase) * 100 : null;
    const prevItem = prevById.get(item.id);
    const prevAmount = prevItem ? displayValue(prevItem) : 0;
    const deltaPct = prevAmount !== 0 ? ((amount - prevAmount) / Math.abs(prevAmount)) * 100 : null;
    return {
      "Khoản mục": `${"  ".repeat(item.depth ?? 0)}${item.label}`,
      "Số tiền (VND)": amount,
      "% Doanh thu": pct === null ? "" : Math.round(pct * 10) / 10,
      "So tháng trước (%)": deltaPct === null ? "" : Math.round(deltaPct * 10) / 10,
      // File đi ra ngoài app: không có tooltip, không có chú thích in thẳng như màn/PDF — mất cột
      // này là mất luôn ngữ nghĩa dòng `aside` ("Sàn trợ giá thêm" KHÔNG cộng vào Doanh thu, SUM
      // các dòng con là thừa đúng khoản sàn chịu) và caveat "Đơn bù — phí ước tính".
      "Ghi chú": item.note ?? item.hint ?? "",
    };
  });

  return [{ name: "P&L", rows }];
}
