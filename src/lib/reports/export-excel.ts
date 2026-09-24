import { toast } from "sonner";

export type ExportSheet = { name: string; rows: Record<string, string | number>[] };

/**
 * Xuất 1+ sheet ra file `.xlsx`, chỉ chạy CLIENT (dynamic import `xlsx` —
 * không kéo lib vào bundle server/RSC). Tên sheet Excel giới hạn 31 ký tự,
 * cắt bớt phòng lỗi `XLSX.utils.book_append_sheet` (không phải nguồn dữ liệu
 * nào của app dài tới mức đó, nhưng cắt cho chắc thay vì để thư viện ném lỗi).
 */
export async function exportTabToExcel(
  tab: "pnl" | "san-pham" | "xu-huong" | "so-quy",
  sheets: ExportSheet[],
  ky: string
): Promise<void> {
  try {
    const XLSX = await import("xlsx");
    const wb = XLSX.utils.book_new();
    for (const sheet of sheets) {
      const ws = XLSX.utils.json_to_sheet(sheet.rows);
      XLSX.utils.book_append_sheet(wb, ws, sheet.name.slice(0, 31));
    }
    XLSX.writeFile(wb, `hogikids-${tab}-${ky}.xlsx`);
    toast.success("Đã xuất Excel");
  } catch {
    toast.error("Xuất Excel thất bại, thử lại");
  }
}
