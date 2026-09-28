"use client";

import { FileDown, Printer } from "lucide-react";
import { toast } from "sonner";

import { buildProductSheetRows } from "@/components/bao-cao/product-report-tab";
import { buildTrendSheetRows } from "@/components/bao-cao/trend-tab";
import { Button } from "@/components/ui/button";
import { exportTabToExcel, type ExportSheet } from "@/lib/reports/export-excel";
import type { MonthlyTrendRow } from "@/lib/reports/monthly-trend";
import type { PnlBreakdown } from "@/lib/reports/pnl";
import { pnlPercentBase } from "@/lib/reports/pnl-percent-base";
import { buildPnlLineItems, displayValue } from "@/lib/reports/pnl-line-items";
import type { PlatformFeeComponent } from "@/lib/reports/platform-fee-breakdown";
import type { VoucherBreakdown } from "@/lib/reports/voucher-breakdown";
import type { ProductReportRow } from "@/lib/reports/product-report";

type ReportExportData =
  | {
      tab: "pnl";
      monthPnl: PnlBreakdown;
      prevMonthPnl: PnlBreakdown;
      feeComponents?: PlatformFeeComponent[];
      prevFeeComponents?: PlatformFeeComponent[];
      voucher?: VoucherBreakdown;
      prevVoucher?: VoucherBreakdown;
      backfilledFee?: number;
      prevBackfilledFee?: number;
    }
  | { tab: "san-pham"; rows: ProductReportRow[] }
  | { tab: "xu-huong"; rows: MonthlyTrendRow[] };

/**
 * Bảng P&L → dòng sheet Excel, dùng LẠI `buildPnlLineItems` (pnl-tab.tsx) cho
 * thứ tự + nhãn dòng — không viết lại danh sách khoản mục lần 2 (đúng chỗ
 * dễ lệch số nếu 2 nơi tự khai báo độc lập).
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

function buildSheets(data: ReportExportData): ExportSheet[] {
  if (data.tab === "pnl")
    return buildPnlSheetRows(
      data.monthPnl,
      data.prevMonthPnl,
      data.feeComponents,
      data.prevFeeComponents,
      data.voucher,
      data.prevVoucher,
      data.backfilledFee,
      data.prevBackfilledFee
    );
  if (data.tab === "san-pham") return buildProductSheetRows(data.rows);
  return [{ name: "Xu hướng", rows: buildTrendSheetRows(data.rows) }];
}

export function ReportExportButtons({ ky, hasData, data }: { ky: string; hasData: boolean; data: ReportExportData }) {
  async function handleExcel() {
    await exportTabToExcel(data.tab, buildSheets(data), ky);
  }

  function handlePrint() {
    try {
      window.print();
    } catch {
      toast.error("Xuất PDF thất bại, thử lại");
    }
  }

  return (
    <div className="flex gap-2 print:hidden">
      <Button type="button" variant="outline" size="sm" onClick={handleExcel} disabled={!hasData}>
        <FileDown className="size-4" />
        Xuất Excel
      </Button>
      <Button type="button" variant="outline" size="sm" onClick={handlePrint} disabled={!hasData}>
        <Printer className="size-4" />
        Xuất PDF
      </Button>
    </div>
  );
}
