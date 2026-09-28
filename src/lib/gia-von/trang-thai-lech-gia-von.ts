/**
 * Trạng thái "app còn lệch giá vốn với Pancake không" — số do lượt đêm chốt, màn hình chỉ đọc.
 *
 * VÌ SAO CẦN: `Variant.costPrice` là APP-OWNED nên giá Pancake KHÔNG tự chảy vào. Trước 2026-09-07,
 * cách duy nhất để biết lệch là chủ shop nhớ mà báo rồi chạy CLI — chủ shop phàn nàn đúng: quy trình
 * dựa vào trí nhớ thì kiểu gì cũng hỏng. Nay lượt đêm tự đếm, con số này là thứ đẩy lên badge.
 *
 * Đo 8 tuần (13/07→06/09): giá vốn Pancake đổi 107 lần, **chỉ 14 do phiếu nhập** — 93 lần còn lại là
 * chủ shop tự gõ giá bên Pancake. Nên KHÔNG neo tín hiệu vào phiếu nhập; phải so thẳng app ↔ Bronze.
 *
 * Cùng khuôn với `stock-resync-status.ts` (mốc vá tồn): số đọc từ `Setting`, giá trị rác ⇒ nói thẳng
 * là "chưa kiểm", KHÔNG đoán là ổn. Im lặng vì chưa đo ≠ im lặng vì khớp.
 */

/** Key trong bảng `Setting`. Lượt đêm ghi, layout + màn Cài đặt đọc — một nguồn tên. */
export const KEY_SO_LECH_GIA_VON = "costPriceMismatchCount";
export const KEY_MOC_KIEM_GIA_VON = "costPriceCheckedAt";

/**
 * Quá ngần này giờ chưa kiểm lại là BẤT THƯỜNG. Lượt đếm chạy 1 lần/đêm (03:00) ⇒ 26 giờ = 1 ngày
 * + biên 2 giờ. Cùng ngưỡng với lượt vá tồn, cùng lý do.
 */
export const GIO_COI_LA_TRE = 26;

export type MucLechGiaVon = "khop" | "co-lech" | "chua-kiem" | "tre";

export type TrangThaiLechGiaVon = {
  soLech: number;
  mocLuc: Date | null;
  gioTruoc: number | null;
  muc: MucLechGiaVon;
};

/**
 * Suy trạng thái từ hai giá trị thô trong `Setting`.
 *
 * Thứ tự xét CỐ Ý: "trễ" thắng "có lệch". Mốc quá hạn nghĩa là con số đang cầm đã cũ — báo "12 mã
 * lệch" từ số của ba hôm trước còn tệ hơn nói thẳng "cơ chế đếm có vẻ đã chết", vì cái đầu làm chủ
 * shop tin là mình đang nhìn hiện tại.
 */
export function trangThaiLechGiaVon(
  soLechTho: string | null | undefined,
  mocTho: string | null | undefined,
  bayGio = new Date(),
): TrangThaiLechGiaVon {
  const soLech = docSoNguyenKhongAm(soLechTho);
  const moc = mocTho ? new Date(mocTho) : null;
  const mocHopLe = moc && !Number.isNaN(moc.getTime()) ? moc : null;

  if (soLech === null || !mocHopLe) {
    return { soLech: soLech ?? 0, mocLuc: mocHopLe, gioTruoc: null, muc: "chua-kiem" };
  }

  const gioTruoc = (bayGio.getTime() - mocHopLe.getTime()) / 3_600_000;
  if (gioTruoc > GIO_COI_LA_TRE) {
    return { soLech, mocLuc: mocHopLe, gioTruoc, muc: "tre" };
  }
  return { soLech, mocLuc: mocHopLe, gioTruoc, muc: soLech > 0 ? "co-lech" : "khop" };
}

/** `null` = không đọc được (thiếu/rác/âm) — KHÁC hẳn với 0 = "đã đếm và không lệch dòng nào". */
function docSoNguyenKhongAm(v: string | null | undefined): number | null {
  if (v == null || v.trim() === "") return null;
  const n = Number(v);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) return null;
  return n;
}
