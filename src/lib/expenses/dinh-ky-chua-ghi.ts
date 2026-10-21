import { addMonths, endOfMonth, format, startOfMonth } from "date-fns";

import type { DateRange } from "@/lib/date-range";
import { mauDinhKySinhChoThang, ngayDenHanDinhKy } from "@/lib/expenses/ensure-recurring-expenses";
import { laNgayTruocMocM, laNhapHangDaKhoaSo } from "@/lib/no-phai-tra/chan-so-chi-phi-da-khoa";

/**
 * Lõi THUẦN đếm "lần đến hạn của mẫu chi định kỳ mà Sổ chi phí CHƯA có dòng" — dùng chung bởi cảnh báo thẻ
 * Quỹ (`so-quy-queries.ts`, biên trên = hôm nay, M = mốc ĐÃ bật) và điều kiện bật nợ phải trả (biên trên =
 * cuối ngày trước ngày bật, M ĐÃ bật = null). Bộ sinh định kỳ chạy LAZY (chỉ sinh khi tháng được mở xem) nên
 * tháng chưa ai mở là thiếu khoản chi thật — quỹ cao hơn thực tế đúng phần thiếu.
 *
 * HAI tham số ngày CỐ Ý tách nhau: `bienTren` là cận trên của lần đến hạn được đếm; `mocMDaBat` là mốc nợ phải
 * trả ĐÃ bật (để bỏ qua lần đến hạn bộ sinh cố ý không sinh). Truyền M của LƯỢT ĐANG BẬT vào `mocMDaBat` là
 * điều kiện rỗng: mọi lần đến hạn trước M bị bỏ qua đúng lúc cần đếm chúng.
 */

/** `thang` là nhãn "MM/yyyy" tăng dần; `khoang` = đầu tháng thiếu SỚM nhất → cuối tháng thiếu MUỘN nhất. */
export type DinhKyChuaGhi = { soKhoan: number; thang: string[]; khoang: DateRange | null };

export const DINH_KY_RONG: DinhKyChuaGhi = { soKhoan: 0, thang: [], khoang: null };

export type MauDinhKyDem = { id: string; dayOfMonth: number; activeFrom: Date | null; categoryId: string };

/** Khoá "mẫu × tháng" của một dòng đã sinh — cùng hạt với UNIQUE `(recurringId, recurringMonth)`. */
export function khoaDaSinh(recurringId: string, ngay: Date): string {
  return `${recurringId}:${format(ngay, "yyyy-MM")}`;
}

export function demDinhKyChuaGhi(p: {
  mau: readonly MauDinhKyDem[];
  /** Tập `khoaDaSinh` của các dòng Expense định kỳ đã có. */
  daSinh: ReadonlySet<string>;
  /** Ngày mở sổ quỹ (đầu ngày) — lần đến hạn trước đó không thuộc quỹ. */
  d0: Date;
  /** Cận trên (cuối ngày) của lần đến hạn được đếm. */
  bienTren: Date;
  /** Mốc nợ phải trả ĐÃ bật (null = chưa bật). KHÔNG phải M của lượt đang bật. */
  mocMDaBat: Date | null;
}): DinhKyChuaGhi {
  const { mau, daSinh, d0, bienTren, mocMDaBat } = p;
  if (mau.length === 0 || bienTren < d0) return DINH_KY_RONG;

  let soKhoan = 0;
  const thang: string[] = [];
  const thangDaThem = new Set<string>();
  let dauTien: Date | null = null;
  let cuoiCung: Date | null = null;
  for (let m = startOfMonth(d0); m <= bienTren; m = addMonths(m, 1)) {
    const key = format(m, "yyyy-MM");
    for (const r of mau) {
      // Tháng trước mốc `activeFrom`: bộ sinh KHÔNG sinh ⇒ không phải "thiếu" (cùng cổng với bộ sinh).
      if (!mauDinhKySinhChoThang(r.activeFrom, m)) continue;
      const ngayDenHan = ngayDenHanDinhKy(r.dayOfMonth, m);
      if (ngayDenHan < d0 || ngayDenHan > bienTren) continue; // chưa tới hạn hoặc trước ngày mở sổ
      // Đã bật nợ: bộ sinh CỐ Ý bỏ lần đến hạn trước M (mọi mẫu — quỹ trước M đã chốt bằng điều chỉnh mở sổ) và
      // mọi lần của mẫu "Nhập hàng" (cùng luật `chan-so-chi-phi-da-khoa.ts`) ⇒ không phải "thiếu" — không thì cảnh
      // báo đòi mở tháng mà mở ra bộ sinh cũng không sinh, không bao giờ tắt.
      if (laNgayTruocMocM(ngayDenHan, mocMDaBat) || laNhapHangDaKhoaSo(r, mocMDaBat)) continue;
      if (daSinh.has(khoaDaSinh(r.id, m))) continue; // đã sinh — không thiếu

      soKhoan++;
      if (!thangDaThem.has(key)) {
        thangDaThem.add(key);
        thang.push(format(m, "MM/yyyy"));
        dauTien ??= m;
        cuoiCung = m;
      }
    }
  }
  const khoang = dauTien && cuoiCung ? { from: dauTien, to: endOfMonth(cuoiCung) } : null;
  return { soKhoan, thang, khoang };
}
