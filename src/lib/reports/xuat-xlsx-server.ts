import { endOfMonth, startOfMonth } from "date-fns";
import * as XLSX from "xlsx";

import { dangPhucHoi } from "@/lib/backup/khoa-bao-tri";
import { ghiNhatKy, ghiNhatKyLoi } from "@/lib/nhat-ky/ghi-nhat-ky";
import { HANH_DONG } from "@/lib/nhat-ky/hanh-dong";
import { prisma } from "@/lib/prisma";
import type { Quyen } from "@/lib/quyen/danh-muc-quyen";
import { coQuyen, type NguoiDung } from "@/lib/quyen/nguoi-dung-phien";
import type { ExportSheet } from "@/lib/reports/export-excel";

/**
 * Dựng + trả file xuất ở SERVER cho mọi route `/api/export/*` (spec phân quyền §4.3). Route mở bằng
 * `congRoute(<quyền module>)` (lưới tĩnh ép), rồi gọi `tuChoiNeuThieuQuyen` cho các quyền PHẢI CÓ ĐỦ
 * (cổng route chỉ nhận "ít nhất một" khi truyền mảng), dựng file, ghi nhật ký `XUAT_FILE`, trả file.
 */

const KY_THANG = /^(\d{4})-(0[1-9]|1[0-2])$/;

/**
 * `?ky=yyyy-MM` → trọn tháng đó theo giờ máy chủ (container neo `Asia/Ho_Chi_Minh`, bất biến #3).
 * Sai khuôn / ngoài 2000–2100 ⇒ null (route trả 400) — không đoán kỳ thay người dùng.
 */
export function docKyThang(ky: string | null): { from: Date; to: Date } | null {
  const m = ky ? KY_THANG.exec(ky) : null;
  if (!m) return null;
  const nam = Number(m[1]);
  if (nam < 2000 || nam > 2100) return null;
  const from = startOfMonth(new Date(nam, Number(m[2]) - 1, 1));
  return { from, to: endOfMonth(from) };
}

/** Một sheet + thứ tự cột cố định (giữ header kể cả khi không có dòng nào). */
export type SheetXuat = ExportSheet & { header?: string[] };

/** Workbook `.xlsx` từ danh sách sheet. Tên sheet Excel giới hạn 31 ký tự — cắt cho chắc thay vì để thư viện ném. */
export function dungXlsxBuffer(sheets: SheetXuat[]): Buffer {
  const wb = XLSX.utils.book_new();
  for (const sheet of sheets) {
    const ws = XLSX.utils.json_to_sheet(sheet.rows, sheet.header ? { header: sheet.header } : undefined);
    XLSX.utils.book_append_sheet(wb, ws, sheet.name.slice(0, 31));
  }
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
}

const CONTENT_TYPE = {
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  csv: "text/csv; charset=utf-8",
} as const;

/** Tên file chỉ giữ ký tự an toàn cho header `Content-Disposition` (chặn tiêm header/ngoặc kép). */
function tenFileAnToan(filename: string): string {
  return filename.replace(/[^A-Za-z0-9._-]/g, "-");
}

/** Response tải file: attachment + nosniff + no-store (dữ liệu kinh doanh — không để browser/CDN cache). */
export function phanHoiTaiFile(noiDung: Buffer | string, filename: string, loai: "xlsx" | "csv"): Response {
  const body = typeof noiDung === "string" ? noiDung : new Uint8Array(noiDung);
  return new Response(body, {
    headers: {
      "Content-Type": CONTENT_TYPE[loai],
      "Content-Disposition": `attachment; filename="${tenFileAnToan(filename)}"`,
      "X-Content-Type-Options": "nosniff", // chặn browser sniff bytes thành type khác
      "Cache-Control": "no-store",
    },
  });
}

/**
 * Kiểm các quyền PHẢI CÓ ĐỦ (ngoài quyền module đã qua `congRoute`). Thiếu ⇒ nhật ký `TU_CHOI_QUYEN`
 * (LOI, cùng khuôn cổng route) + JSON 403 cùng hình dạng cổng; đủ ⇒ `null`.
 */
export async function tuChoiNeuThieuQuyen(nd: NguoiDung, canDu: readonly Quyen[]): Promise<Response | null> {
  const thieu = canDu.filter((q) => !coQuyen(nd, q));
  if (thieu.length === 0) return null;
  await ghiNhatKyLoi({
    actor: { id: nd.id, email: nd.email },
    hanhDong: HANH_DONG.TU_CHOI_QUYEN,
    ghiChu: { quyenThieu: thieu.join(", ") },
  });
  return Response.json(
    { error: "Bạn không có quyền thực hiện thao tác này", code: "KHONG_CO_QUYEN" },
    { status: 403 },
  );
}

/**
 * Nhật ký `XUAT_FILE` (OK) sau khi đã dựng xong file. Ném ⇒ route không trả file (Next trả 500):
 * không bao giờ có lượt xuất dữ liệu mà thiếu dấu vết. NGOẠI LỆ: đang phục hồi DB thì bỏ dòng (schema đích
 * đang bị xoá + nạp lại — ghi lúc này lỗi/treo/bị bản backup lùi mất), cùng luật với `ghiNhatKyLoi`.
 */
export async function ghiNhatKyXuat(nd: NguoiDung, loaiBanGhi: string, p: { ky?: string; soDong?: number } = {}): Promise<void> {
  if (dangPhucHoi()) return;
  await ghiNhatKy(prisma, {
    actor: { id: nd.id, email: nd.email },
    hanhDong: HANH_DONG.XUAT_FILE,
    ghiChu: { loaiBanGhi, ...(p.ky ? { ky: p.ky } : {}), ...(p.soDong !== undefined ? { soDong: p.soDong } : {}) },
  });
}
