import { differenceInCalendarDays, endOfDay, endOfMonth, isSameDay, startOfDay, startOfMonth, subDays, subMonths } from "date-fns";

import {
  clampRangeEndToNow,
  previousComparableRange,
  previousRange,
  type DateRange,
} from "@/lib/date-range";

/**
 * So kỳ trước cho trang chủ (spec trang chủ §4.1–§4.4) — hàm THUẦN, mọi biên ngày theo giờ VN qua
 * `date-range.ts` (process chạy `TZ=Asia/Ho_Chi_Minh`).
 */

/** % thay đổi so kỳ trước. Kỳ trước 0 ⇒ `null` (huy hiệu "Mới", không chia 0). Chia |kỳ trước| để lỗ giảm = tăng. */
export function phanTramThayDoi(hienTai: number, kyTruoc: number): number | null {
  if (kyTruoc === 0) return null;
  return ((hienTai - kyTruoc) / Math.abs(kyTruoc)) * 100;
}

const soNgay = (r: DateRange) => differenceInCalendarDays(r.to, r.from) + 1;

/** Dạng "tháng này đến nay" mà `previousComparableRange` rẽ sang `lastMonthToSameDay`. */
function laThangNayDenNay(r: DateRange, now: Date): boolean {
  return r.from.getTime() === startOfMonth(now).getTime() && r.to.getTime() === endOfDay(now).getTime();
}

/**
 * Range gốc đúng MỘT THÁNG DƯƠNG LỊCH ĐÃ QUA (preset "Tháng trước" hoặc Tùy chọn 01→cuối tháng): so với
 * TRỌN tháng dương lịch liền trước, không trượt "N ngày trước đó" (tháng 31 ngày ⇒ lệch sang tháng trước nữa).
 * Tháng ĐANG CHẠY không thuộc nhánh này — "Tháng này" đi đường `previousComparableRange` (cùng kỳ tháng trước).
 */
function laThangDuongLichDaQua(r: DateRange, now: Date): boolean {
  return (
    r.from.getTime() === startOfMonth(r.from).getTime() &&
    r.to.getTime() === endOfMonth(r.from).getTime() &&
    r.from.getTime() < startOfMonth(now).getTime()
  );
}

/** Trọn tháng dương lịch liền trước tháng của `r.from`. */
function thangLienTruoc(r: DateRange): DateRange {
  const dau = startOfMonth(subMonths(r.from, 1));
  return { from: dau, to: endOfMonth(dau) };
}

/**
 * Kỳ so sánh. "Kỳ 1 ngày" xét trên RANGE GỐC của bộ chọn (cùng tiêu chí với `rangeBieuDo`), phép so chạy
 * trên kỳ đã kẹp `clampRangeEndToNow`:
 * - range gốc 1 ngày ("Hôm nay"/"Hôm qua") ⇒ TRỌN ngày liền trước (spec §4.1) — kể cả ngày 01, khi "Hôm nay"
 *   trùng dạng "tháng này đến nay" mà `previousComparableRange` sẽ đẩy sang ngày 01 tháng trước;
 * - range gốc là trọn một tháng dương lịch đã qua ⇒ TRỌN tháng dương lịch liền trước;
 * - còn lại ⇒ `previousComparableRange` — "Tháng này" ngày 01 (kẹp còn 1 ngày) vẫn so cùng kỳ tháng trước.
 */
export function kySoSanh(range: DateRange, now: Date): DateRange {
  const kyTinh = clampRangeEndToNow(range, now);
  if (soNgay(range) === 1) return previousRange(kyTinh);
  if (laThangDuongLichDaQua(range, now)) return thangLienTruoc(range);
  return previousComparableRange(kyTinh, now);
}

/** Nhãn "so với …" — rẽ nhánh y hệt `kySoSanh` (range gốc), nên luôn khớp kỳ thật đang so. */
export function nhanKySoSanh(range: DateRange, now: Date): string {
  const k = clampRangeEndToNow(range, now);
  if (soNgay(range) === 1) {
    if (isSameDay(k.from, now)) return "hôm qua";
    if (isSameDay(k.from, subDays(now, 1))) return "hôm kia";
    return "hôm trước"; // Tùy chọn đúng 1 ngày xa hơn hôm qua
  }
  if (laThangDuongLichDaQua(range, now)) return "tháng trước đó";
  if (laThangNayDenNay(k, now)) return "cùng kỳ tháng trước";
  return `${soNgay(k)} ngày trước đó`;
}

/**
 * Kỳ của biểu đồ ngày. Kỳ 1 ngày ⇒ 7 ngày kết thúc ở ngày đó (`motNgay` — không vẽ đường kỳ trước).
 * Khác ⇒ kẹp ngày tương lai về hôm nay (ngày tương lai ra điểm 0 trông như doanh thu sụp).
 */
export function rangeBieuDo(range: DateRange, now: Date): { range: DateRange; motNgay: boolean } {
  if (soNgay(range) === 1) {
    return { range: { from: startOfDay(subDays(range.from, 6)), to: endOfDay(range.from) }, motNgay: true };
  }
  return { range: clampRangeEndToNow(range, now), motNgay: false };
}

/**
 * Ghép điểm kỳ này với kỳ trước theo THỨ TỰ (ngày 1 ↔ ngày 1). Kỳ trước ngắn hơn (tháng 31 ngày so
 * tháng 30 ngày) ⇒ phần đuôi `null` (đường đứt dừng sớm); `null` ⇒ toàn `null`.
 */
export function ghepKyTruoc<T>(
  hienTai: readonly T[],
  kyTruoc: readonly T[] | null
): Array<{ hienTai: T; kyTruoc: T | null }> {
  return hienTai.map((h, i) => ({ hienTai: h, kyTruoc: kyTruoc && i < kyTruoc.length ? kyTruoc[i] : null }));
}
