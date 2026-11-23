/**
 * Thông tin kết nối cho các test gọi `psql` (tiến trình con) từ URL DB test — server đòi mật khẩu (như CI: `postgres:15`
 * có `POSTGRES_PASSWORD`) vẫn chạy được mà mật khẩu KHÔNG BAO GIỜ nằm trong tham số dòng lệnh / chuỗi lệnh shell (lộ qua
 * `ps`, log, thông báo lỗi): nó CHỈ đi qua biến môi trường `PGPASSWORD` của riêng tiến trình con.
 * Rào DB test giữ nguyên: helper chỉ đọc URL đã qua `tests/setup.ts`, không tự chọn DB.
 */
export function ketNoiPsql(url: string, db?: string) {
  const u = new URL(url);
  const matKhau = decodeURIComponent(u.password);
  const host = u.hostname;
  const port = u.port || "5432";
  const nguoiDung = decodeURIComponent(u.username) || "postgres";
  const tenDb = db ?? decodeURIComponent(u.pathname.replace(/^\//, ""));
  u.password = "";
  u.search = "";
  u.pathname = `/${tenDb}`;
  return {
    /** Cờ dòng lệnh psql KHÔNG có mật khẩu: `-h … -p … -U … -d …`. */
    co: `-h ${host} -p ${port} -U ${nguoiDung} -d ${tenDb}`,
    /** Mảng tham số tương ứng `co` (cho spawn không qua shell). */
    thamSo: ["-h", host, "-p", port, "-U", nguoiDung, "-d", tenDb],
    /** URL KHÔNG mật khẩu, không `?schema=` (psql không hiểu tham số đó). */
    urlKhongMatKhau: u.toString(),
    /** Env RIÊNG cho tiến trình con; rỗng khi URL không có mật khẩu (server trust). */
    env: (matKhau ? { PGPASSWORD: matKhau } : {}) as Record<string, string>,
  };
}
