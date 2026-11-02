/**
 * Câu hướng dẫn cắt tay một phiên DB thuộc role KHÁC role app — dùng chung cho route
 * `/api/restore/cat-phien` (câu 409) và modal phục hồi (dòng phiên không có nút cắt). Module THUẦN, không
 * import gì: được nạp cả từ client component.
 *
 * Role app chỉ `pg_terminate_backend` được phiên cùng role; phiên của role khác (vd script chạy bằng
 * `supabase_admin`) phải do người quản trị DB cắt bằng superuser.
 */
export function cauLenhCatTayPhien(pid: number): string {
  // `pid` luôn là số nguyên dương đã kiểm (zod ở route, `Number.isInteger` ở modal) ⇒ nhúng an toàn.
  return `SELECT pg_terminate_backend(${pid});`;
}

export function huongDanCatTayPhienKhacRole(pid: number, usename: string): string {
  return (
    `Phiên ${pid} thuộc role "${usename || "không rõ"}" — app chỉ cắt được phiên cùng role của app, nên ` +
    `không cắt phiên này. Nếu chắc đó là script bị treo, người quản trị DB cắt tay bằng superuser: ` +
    cauLenhCatTayPhien(pid)
  );
}
