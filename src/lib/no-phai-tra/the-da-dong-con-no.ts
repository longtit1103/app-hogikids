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
 * Lối thoát DUY NHẤT: dòng MỚI vào thẻ đóng (tạo, khôi phục thùng rác, chuyển từ thẻ/loại khác sang) chỉ được là
 * `CARD_PAY` khi thẻ còn nợ > 0 và ngày trả sau ngày chốt của neo đang dùng. KHÔNG kẹp số trả theo dư nợ: dư nợ
 * thẻ là số ƯỚC TÍNH, ngân hàng trừ nhiều hơn (phí, lãi chưa ghi) là ca thật — ghi đúng số ngân hàng đã trừ, phần
 * vượt hiện thành "trả thừa" ở chỉ báo thẻ đóng.
 *
 * Lần trả ĐÃ CÓ của chính thẻ đóng thì xoá / sửa số (giảm hay tăng) / sửa ngày, mô tả đều được (chủ shop chốt
 * 23/10): dư nợ chỉ quay về con số trước lần trả đó, người dùng sửa được nhầm lẫn. Trước đây cấm xoá nhưng lại cho
 * giảm số xuống gần 0 — cùng hệ quả mà khác luật. Vẫn chặn: chuyển lần trả đó RA khỏi thẻ (sang thẻ khác / đổi
 * loại), sửa hay xoá dòng loại khác của thẻ đóng (nạp ví bằng thẻ), và mọi dòng mới không phải `CARD_PAY`. Khoản chi
 * trừ thẻ và gắn nền tảng vào thẻ đóng chặn ở cổng riêng.
 */

/** Một phía (trước/sau) của lượt ghi dòng tiền — chỉ các trường cổng thẻ đóng cần. */
export type PhiaDongTienThe = { kind: string; cardId: string | null; date: Date; amount: number };

export type LoiTraTheDaDong = { message: string; field: "cardId" | "date" };

/**
 * Xét một lượt ghi chạm thẻ ĐÃ ĐÓNG `the`. `kys`/`gd` = neo + giao dịch của thẻ tới hết ngày `den` (đọc TRONG
 * transaction, SAU khoá thẻ) — chỉ cần khi lượt ghi đưa một dòng MỚI vào thẻ (`truoc` không thuộc thẻ này); sửa /
 * xoá lần trả đã có của thẻ không đọc dư nợ. `den` phải ≥ ngày của phía sau (caller lấy max với hôm nay) để lần
 * trả đang xét nằm trong khoảng đếm.
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
  const { the, kys, gd, den, truoc, sau } = p;
  const chanChung: LoiTraTheDaDong = {
    message: `Thẻ ${the.ten} đã đóng — không ghi, sửa hay xoá dòng tiền của thẻ đã đóng`,
    field: "cardId",
  };
  const sauLaTraTheNay = sau !== null && sau.kind === "CARD_PAY" && sau.cardId === the.id;

  if (truoc !== null && truoc.cardId === the.id) {
    // Dòng ĐÃ CÓ của thẻ đóng: chỉ lần trả mới sửa/xoá được, và chỉ khi vẫn là lần trả của chính thẻ này (hoặc xoá
    // hẳn). Sửa một dòng nạp ví bằng thẻ thành "trả thẻ" là xoá một khoản chi khỏi thẻ đã đóng; chuyển lần trả sang
    // thẻ khác / đổi loại là đẩy nghĩa vụ đi chỗ khác — cả hai chặn.
    if (truoc.kind !== "CARD_PAY") return chanChung;
    return sau === null || sauLaTraTheNay ? null : chanChung;
  }

  // Dòng MỚI vào thẻ đóng: chỉ một lần TRẢ mới có thể kéo nợ về 0.
  if (sau === null || !sauLaTraTheNay) return chanChung;
  const noTruoc = duNo(kys, gd, den);
  if (noTruoc === null || noTruoc <= 0) {
    return { message: `Thẻ ${the.ten} đã đóng và không còn nợ — không ghi thêm dòng trả thẻ`, field: "cardId" };
  }
  const noSau = duNo(kys, [...gd, { ngay: sau.date, soTien: sau.amount, loai: "TRA" }], den) ?? noTruoc;
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
