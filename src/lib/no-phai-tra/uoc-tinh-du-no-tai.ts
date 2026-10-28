import { docNguCanhLoc } from "@/lib/no-phai-tra/doc-ngu-canh-loc";
import {
  dauNgayVn,
  docGiaoDichThe,
  docHoaDonTiktokTrongNgay,
  docKyNeoThe,
  type HoaDonTiktokTrongNgay,
} from "@/lib/no-phai-tra/du-no-the";
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

/**
 * Kết quả cho form chốt sao kê: ước tính tại ngày + các lần TikTok trừ THẺ THẬT tạo đúng ngày đó (ngân hàng hay ghi
 * trễ; phần ví TikTok Shop trả đã bỏ ra — không bao giờ lên sao kê).
 */
export type UocTinhSaoKe = { uocTinh: number | null; hoaDonNgayChot: HoaDonTiktokTrongNgay };

/**
 * ĐỌC-ONLY: `uocTinhDuNoTai` + số lần/tổng hoá đơn TikTok trừ thẻ tạo đúng ngày chốt (`docHoaDonTiktokTrongNgay`).
 * Không đổi công thức lõi — chỉ thêm thông tin để chủ shop quyết số gõ vào.
 */
export async function uocTinhSaoKeTai(cardId: string, ngay: string): Promise<UocTinhSaoKe> {
  const ctx = await docNguCanhLoc();
  const [uocTinh, hoaDonNgayChot] = await Promise.all([
    uocTinhDuNoTai(cardId, ngay),
    docHoaDonTiktokTrongNgay(cardId, ngay, undefined, ctx),
  ]);
  return { uocTinh, hoaDonNgayChot };
}
