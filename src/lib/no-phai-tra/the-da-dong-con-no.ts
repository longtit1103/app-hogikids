import { format } from "date-fns";

import { formatVnd } from "@/lib/format";
import { duNo, neoTai, type GiaoDichThe, type KyNeo } from "@/lib/no-phai-tra/ky-sao-ke";
import { khoaNgayVn } from "@/lib/so-quy/dong-chay-so-quy";

/**
 * Thẻ tín dụng ĐÃ ĐÓNG mà dư nợ ước tính ≠ 0 — THUẦN, không DB.
 *
 * Vì sao xảy ra: chi tiêu ads chốt lại MUỘN (`ADS_API`, nền tảng sửa số ngày cũ) gán về thẻ theo ĐÚNG lịch sử
 * mốc gắn (`theCuaNenTang` — ngày đó thẻ này còn gánh nền tảng), kể cả khi thẻ đã đóng sau đó. Không "đẩy" sang
 * thẻ khác: ngân hàng thật đã trừ vào thẻ cũ. Kết quả là thẻ đóng còn nợ > 0 mà trước đây không có lối ghi
 * "Trả thẻ" (cổng thẻ đóng chặn mọi dòng) ⇒ nợ treo mãi, "Sau khi trả hết nợ" hụt đúng số đó.
 *
 * Lối thoát DUY NHẤT: `CARD_PAY` vào thẻ đóng khi và chỉ khi thẻ còn nợ > 0 (chưa tính chính dòng đang sửa) và
 * ngày trả sau ngày chốt của neo đang dùng. KHÔNG kẹp số trả theo dư nợ: dư nợ thẻ là số ƯỚC TÍNH, ngân hàng trừ
 * nhiều hơn (phí, lãi chưa ghi) là ca thật — ghi đúng số ngân hàng đã trừ, phần vượt hiện thành "trả thừa" ở chỉ
 * báo thẻ đóng. Mọi loại dòng khác (nạp ví bằng thẻ, khoản chi trừ thẻ, gắn nền tảng) vào thẻ đóng vẫn bị chặn;
 * xoá / chuyển một lần trả RA khỏi thẻ đóng cũng chặn (nợ tăng lại).
 */

/** Một phía (trước/sau) của lượt ghi dòng tiền — chỉ các trường cổng thẻ đóng cần. */
export type PhiaDongTienThe = { kind: string; cardId: string | null; date: Date; amount: number };

export type LoiTraTheDaDong = { message: string; field: "cardId" | "date" };

/** Bỏ ĐÚNG MỘT giao dịch TRA khớp ngày + số tiền (dòng đang sửa) — không tìm thấy thì giữ nguyên danh sách. */
function boMotLanTra(gd: readonly GiaoDichThe[], ngay: Date, soTien: number): GiaoDichThe[] {
  const i = gd.findIndex((g) => g.loai === "TRA" && g.soTien === soTien && g.ngay.getTime() === ngay.getTime());
  return i < 0 ? [...gd] : [...gd.slice(0, i), ...gd.slice(i + 1)];
}

/**
 * Xét một lượt ghi chạm thẻ ĐÃ ĐÓNG `the`. `kys`/`gd` = neo + giao dịch của thẻ tới hết ngày `den` (đọc TRONG
 * transaction, SAU khoá thẻ) — `gd` đã gồm dòng `truoc` nếu dòng đó là lần trả của thẻ này. `den` phải ≥ ngày của
 * cả hai phía (caller lấy max với hôm nay) để lần trả đang xét nằm trong khoảng đếm.
 *
 * Trả `null` = cho ghi; ngược lại là lý do từ chối (caller ném `THE_DA_DONG`).
 */
export function xetTraVaoTheDaDong(p: {
  the: { id: string; ten: string };
  kys: readonly KyNeo[];
  gd: readonly GiaoDichThe[];
  den: Date;
  truoc: PhiaDongTienThe | null;
  sau: PhiaDongTienThe | null;
}): LoiTraTheDaDong | null {
  const { the, kys, den, truoc, sau } = p;
  const chanChung: LoiTraTheDaDong = {
    message: `Thẻ ${the.ten} đã đóng — không ghi, sửa hay xoá dòng tiền của thẻ đã đóng`,
    field: "cardId",
  };
  // Chỉ một lần TRẢ vào chính thẻ này mới có thể kéo nợ về 0; dòng cũ của thẻ (nếu có) cũng phải là lần trả —
  // sửa một dòng nạp ví bằng thẻ thành "trả thẻ" là xoá một khoản chi khỏi thẻ đã đóng.
  if (sau === null || sau.kind !== "CARD_PAY" || sau.cardId !== the.id) return chanChung;
  if (truoc !== null && truoc.cardId === the.id && truoc.kind !== "CARD_PAY") return chanChung;

  const gdKhongDongNay =
    truoc !== null && truoc.cardId === the.id ? boMotLanTra(p.gd, truoc.date, truoc.amount) : [...p.gd];
  const noTruoc = duNo(kys, gdKhongDongNay, den);
  if (noTruoc === null || noTruoc <= 0) {
    return { message: `Thẻ ${the.ten} đã đóng và không còn nợ — không ghi thêm dòng trả thẻ`, field: "cardId" };
  }
  const noSau = duNo(kys, [...gdKhongDongNay, { ngay: sau.date, soTien: sau.amount, loai: "TRA" }], den) ?? noTruoc;
  if (noSau === noTruoc) {
    // Ngày trả không sau ngày chốt của neo đang dùng ⇒ lần trả nằm trong số sao kê, không trừ được nợ còn treo.
    const neo = neoTai(kys, den);
    return {
      message: `Thẻ ${the.ten} đã đóng — ngày trả phải sau ngày chốt sao kê gần nhất${
        neo ? ` (${format(neo.ngayChot, "dd/MM/yyyy")})` : ""
      } mới trừ được số còn nợ`,
      field: "date",
    };
  }
  return null;
}

/** Mốc `den` cho cổng: ngày muộn nhất trong hôm nay và ngày của các phía chạm thẻ (giao dịch phải nằm trong khoảng đếm). */
export function denChoCongTheDaDong(homNay: Date, cardId: string, ...phia: (PhiaDongTienThe | null)[]): Date {
  let den = homNay;
  for (const x of phia) {
    if (x !== null && x.cardId === cardId && khoaNgayVn(x.date) > khoaNgayVn(den)) den = x.date;
  }
  return den;
}

/** Một thẻ đã đóng còn dư nợ ước tính ≠ 0 — cho chỉ báo ở khối Thẻ tín dụng / trang Nợ phải trả. */
export type TheDongConNo = { id: string; ten: string; duNo: number };

/** Lọc thẻ đã đóng có dư nợ ≠ 0 (dương = còn nợ, âm = trả thừa). Thẻ chưa có neo (`null`) không đoán. */
export function locTheDongConNo(
  the: readonly { id: string; ten: string; closedAt: Date | null; duNo: number | null }[],
): TheDongConNo[] {
  return the.flatMap((t) =>
    t.closedAt !== null && t.duNo !== null && t.duNo !== 0 ? [{ id: t.id, ten: t.ten, duNo: t.duNo }] : [],
  );
}

/**
 * Một thẻ cho ô chọn của form "Nhập quỹ / rút quỹ" (`TheChon`): `dong` = thẻ KHÔNG nhận dòng mới. Thẻ mở ⇒ chọn
 * được. Thẻ đã đóng còn nợ > 0 ⇒ vẫn chọn được, nhãn nêu số còn nợ và chỉ dùng để ghi "Trả thẻ" (server là cổng
 * thật — `xetTraVaoTheDaDong`). Thẻ đã đóng hết nợ / trả thừa / chưa có neo ⇒ `dong = true`. `chiTraThe` đánh
 * dấu thẻ đóng-còn-nợ để form chỉ liệt kê nó khi loại là `CARD_PAY`.
 */
export function theChoOChon(
  t: { id: string; ten: string; closedAt: Date | null },
  duNo: number | null,
): { id: string; ten: string; dong: boolean; chiTraThe?: boolean } {
  if (t.closedAt === null) return { id: t.id, ten: t.ten, dong: false };
  if (duNo !== null && duNo > 0) {
    return {
      id: t.id,
      ten: `${t.ten} (đã đóng — còn nợ ${formatVnd(duNo)}, chỉ ghi Trả thẻ)`,
      dong: false,
      chiTraThe: true,
    };
  }
  return { id: t.id, ten: t.ten, dong: true };
}
