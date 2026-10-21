import { khoaNgayVn } from "@/lib/so-quy/dong-chay-so-quy";

/** Mốc gắn nền tảng ads → thẻ ở dạng tối thiểu đủ tính khoảng hiệu lực (khớp `GanNenTang` + id). */
export type MocGanDeTinhKhoang = { id: string; cardId: string; nenTang: string; tuNgay: Date };

/**
 * Khoảng hiệu lực của MỘT mốc, tính trên mốc của MỌI thẻ cùng nền tảng:
 * - `denNgay`: đầu ngày VN của NGÀY CUỐI mốc còn gánh ads (ngày trước mốc kế tiếp); `null` = mốc cuối, gánh mãi;
 * - `cardIdKeTiep`: thẻ của mốc kế tiếp (có thể là thẻ khác — "đổi thẻ" là thêm mốc ở thẻ mới); `null` = mốc cuối.
 */
export type KhoangHieuLucMoc = { denNgay: Date | null; cardIdKeTiep: string | null };

const MOT_NGAY_MS = 24 * 3600 * 1000;

/**
 * Cùng luật với `theCuaNenTang` (`the-cua-dong-chi.ts`): ngày d thuộc mốc có `tuNgay` lớn nhất ≤ d của nền
 * tảng đó, so theo khoá ngày VN ⇒ mốc kế tiếp = `tuNgay` nhỏ nhất LỚN HƠN HẲN ngày của mốc này. Test đối chiếu
 * từng ngày với `theCuaNenTang` (`khoang-hieu-luc-moc-gan.test.ts`). THUẦN, không DB.
 */
export function khoangHieuLucCacMoc(gan: readonly MocGanDeTinhKhoang[]): Map<string, KhoangHieuLucMoc> {
  const ketQua = new Map<string, KhoangHieuLucMoc>();
  for (const g of gan) {
    const khoa = khoaNgayVn(g.tuNgay);
    let tiep: MocGanDeTinhKhoang | null = null;
    for (const h of gan) {
      if (h.nenTang !== g.nenTang || khoaNgayVn(h.tuNgay) <= khoa) continue;
      if (tiep === null || h.tuNgay.getTime() < tiep.tuNgay.getTime()) tiep = h;
    }
    ketQua.set(g.id, {
      // VN không có giờ mùa hè ⇒ lùi đúng 24h từ 00:00 VN của mốc kế là 00:00 VN của ngày trước đó.
      denNgay: tiep === null ? null : new Date(new Date(`${khoaNgayVn(tiep.tuNgay)}T00:00:00+07:00`).getTime() - MOT_NGAY_MS),
      cardIdKeTiep: tiep === null ? null : tiep.cardId,
    });
  }
  return ketQua;
}
