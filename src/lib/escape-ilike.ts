/**
 * Chuỗi người dùng gõ đi vào `ILIKE`/`LIKE` phải thoát ký tự đại diện: `%` (mọi chuỗi) và `_` (đúng một
 * ký tự) vốn là cú pháp mẫu, không phải chữ. Không thoát thì SKU `AO_THUN_01` khớp cả `AO-THUN-01`,
 * và gõ `%` ra toàn bộ danh sách. Ký tự thoát là `\` (mặc định của PostgreSQL) nên cũng phải thoát
 * chính `\`. Tham số vẫn được bind (không phải SQL injection) — đây chỉ là đúng nghĩa của ô tìm kiếm.
 */
export function boKyTuDaiDienIlike(chuoi: string): string {
  return chuoi.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/** Mẫu "chứa" an toàn cho `ILIKE`: cắt khoảng trắng hai đầu, thoát ký tự đại diện rồi bọc `%…%`. */
export function mauTimKiemIlike(tuKhoa: string): string {
  return `%${boKyTuDaiDienIlike(tuKhoa.trim())}%`;
}
