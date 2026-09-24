"use client";

import { FileDown } from "lucide-react";

import { Button } from "@/components/ui/button";
import { exportTabToExcel } from "@/lib/reports/export-excel";
import type { SoQuyDongChay } from "@/lib/so-quy/dong-chay-so-quy-types";
import { buildSoQuySheetRows } from "@/lib/so-quy/xuat-excel-so-quy";

/**
 * Nút "Xuất Excel" tab Sổ quỹ (dòng chạy) — chỉ render khi có số để xuất (nhánh `CO_SO` của
 * `SoQuyDongChay`); controller (`so-quy-dong-chay-tab.tsx`) tự quyết ẩn/không gắn nút này ở hai nhánh
 * còn lại (`CHUA_MO_SO`/`TRUOC_MO_SO`). `ky` = khoá kỳ đang xem (`yyyy-MM`), dùng cho TÊN FILE, cùng
 * khuôn `exportTabToExcel` (toast thành công/thất bại đã nằm trong đó, không lặp ở đây).
 */
export function SoQuyXuatExcelButton({
  dongChay,
  ky,
  laThangHienTai,
}: {
  dongChay: Extract<SoQuyDongChay, { trangThai: "CO_SO" }>;
  ky: string;
  /** Kỳ đang xem có phải tháng hiện tại — tab tính sẵn (`isCurrentMonth`), truyền xuống cho nhãn "Cuối
   * kỳ" của sheet KHỚP đúng nhãn màn hình (`nhanCuoiKySoQuy`). */
  laThangHienTai: boolean;
}) {
  async function handleExcel() {
    const rows = buildSoQuySheetRows(dongChay, laThangHienTai);
    await exportTabToExcel("so-quy", [{ name: "Sổ quỹ", rows }], ky);
  }

  return (
    <Button type="button" variant="outline" size="sm" onClick={handleExcel} className="print:hidden">
      <FileDown className="size-4" />
      Xuất Excel
    </Button>
  );
}
