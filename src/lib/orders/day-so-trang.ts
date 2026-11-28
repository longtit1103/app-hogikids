/**
 * Dãy nút phân trang kiểu "‹ 1 … 4 5 6 … 63 ›": luôn có trang 1, trang cuối và ±1 quanh trang hiện
 * tại; mỗi khoảng hở (dù chỉ thiếu một trang) thành đúng một "…". Hàm thuần, trang ngoài khoảng được kẹp.
 */
export function daySoTrang(trang: number, tongTrang: number): (number | "…")[] {
  const cuoi = Number.isFinite(tongTrang) ? Math.max(1, Math.floor(tongTrang)) : 1;
  const hienTai = Number.isFinite(trang) ? Math.min(Math.max(1, Math.floor(trang)), cuoi) : 1;

  const giuLai = [...new Set([1, cuoi, hienTai - 1, hienTai, hienTai + 1])]
    .filter((p) => p >= 1 && p <= cuoi)
    .sort((a, b) => a - b);

  const ra: (number | "…")[] = [];
  for (const p of giuLai) {
    const truoc = ra[ra.length - 1];
    if (typeof truoc === "number" && p - truoc > 1) ra.push("…");
    ra.push(p);
  }
  return ra;
}
