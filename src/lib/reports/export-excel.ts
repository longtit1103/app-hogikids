/**
 * Một sheet của file Excel xuất ra. File dựng ở SERVER (`src/lib/reports/xuat-xlsx-server.ts`, gọi từ
 * route `/api/export/*`) — hàm dựng file phía client cũ đã bị xoá (spec phân quyền §4.3: mọi file xuất
 * qua route có cổng quyền; lưới `tests/luoi/cong-bat-buoc.test.ts` ca 6 chặn đưa lại).
 */
export type ExportSheet = { name: string; rows: Record<string, string | number>[] };
