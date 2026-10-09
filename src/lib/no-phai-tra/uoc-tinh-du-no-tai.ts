import { dauNgayVn, docGiaoDichThe, docKyNeoThe } from "@/lib/no-phai-tra/du-no-the";
import { duNo } from "@/lib/no-phai-tra/ky-sao-ke";

/**
 * ĐỌC-ONLY: dư nợ ƯỚC TÍNH của một thẻ vào CUỐI NGÀY `ngay` (khoá `yyyy-MM-dd`, giờ VN) — số app tự tính
 * theo neo + giao dịch, để form chốt sao kê cho chủ shop thấy chênh lệch với sao kê ngân hàng TRƯỚC khi
 * lưu. Cùng phép tính với `chotSaoKe` (`uocTinhLucChot`): `duNo(kỳ neo, giao dịch tới hết ngày, ngày)`.
 * Không ghi, không khoá. `null` = thẻ chưa có neo ≤ ngày đó (app không có số để so).
 *
 * Cổng quyền + bọc server action nằm ở `src/lib/actions/uoc-tinh-sao-ke.ts` (lưới "use server" chỉ cho
 * phép action đặt dưới `src/lib/actions/`).
 */
export async function uocTinhDuNoTai(cardId: string, ngay: string): Promise<number | null> {
  const moc = dauNgayVn(new Date(`${ngay}T00:00:00+07:00`));
  const [kys, gd] = await Promise.all([docKyNeoThe(cardId), docGiaoDichThe(cardId, moc)]);
  return duNo(kys, gd, moc);
}
