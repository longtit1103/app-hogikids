import { khoaNgayVn } from "@/lib/so-quy/dong-chay-so-quy";
import type { MocGanThe } from "@/lib/no-phai-tra/the-tin-dung-queries";

/** `Date` → `dd/MM/yyyy` theo giờ VN, không lệ thuộc múi giờ trình duyệt. */
export function ngayVnHienThi(d: Date): string {
  const [y, m, ng] = khoaNgayVn(d).split("-");
  return `${ng}/${m}/${y}`;
}

/** Mốc có `tuNgay` sau hôm nay (khoá ngày VN) — chưa có hiệu lực. */
export function laMocSapApDung(g: Pick<MocGanThe, "tuNgay">, homNay: Date): boolean {
  return khoaNgayVn(g.tuNgay) > khoaNgayVn(homNay);
}

/**
 * Mốc đã bị mốc KẾ TIẾP (của bất kỳ thẻ nào cùng nền tảng) thay từ ngày ≤ hôm nay — `denNgay` (ngày cuối còn
 * gánh) đã qua. Chỉ dùng để lọc khi ĐÃ bật; KHÔNG hiện thành nhãn: mốc ngày thật vẫn quyết định ads từ M.
 */
function daBiThayTuTruocHomNay(g: Pick<MocGanThe, "denNgay">, homNay: Date): boolean {
  return g.denNgay !== null && khoaNgayVn(g.denNgay) < khoaNgayVn(homNay);
}

/**
 * Mốc hiển thị, sắp theo ngày tăng dần.
 * - CHƯA bật: ĐỦ lịch sử, không loại mốc nào (mốc chưa đổi số hiện tại nhưng quyết định ads thuộc thẻ nào
 *   từ ngày bật — người điền cần thấy hết).
 * - ĐÃ bật: bỏ mốc đã bị thay trước hôm nay (lịch sử không xoá được), giữ mốc đang gánh + sắp áp dụng.
 */
export function mocGanHienThi(gan: readonly MocGanThe[], daBat: boolean, homNay: Date): MocGanThe[] {
  const ds = [...gan].sort((a, b) => a.tuNgay.getTime() - b.tuNgay.getTime());
  return daBat ? ds.filter((g) => !daBiThayTuTruocHomNay(g, homNay)) : ds;
}

/** "từ dd/MM/yyyy" + " đến dd/MM/yyyy" khi có mốc kế + " (sau đó: <thẻ>)" khi mốc kế ở thẻ khác. */
export function moTaKhoangHieuLuc(g: Pick<MocGanThe, "tuNgay" | "denNgay" | "theKeTiep">): string {
  const tu = `từ ${ngayVnHienThi(g.tuNgay)}`;
  if (g.denNgay === null) return tu;
  return `${tu} đến ${ngayVnHienThi(g.denNgay)}${g.theKeTiep !== null ? ` (sau đó: ${g.theKeTiep})` : ""}`;
}
