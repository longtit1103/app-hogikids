import { khoaNgayVn } from "@/lib/so-quy/dong-chay-so-quy";

/**
 * "Thẻ gánh" của một dòng chi — luật thẻ duy nhất, THUẦN (không DB, không Prisma).
 *
 * - Thẻ của ads: nền tảng ads (META/TIKTOK_ADS/SHOPEE_ADS) gắn vào một thẻ tín dụng từ `tuNgay`;
 *   đổi thẻ = thêm dòng gắn mới, dòng cũ giữ lịch sử.
 * - Thẻ của một dòng Expense: `cardId` ghi tay thắng; nếu không có và là ads có `adsSource` ⇒ thẻ của nền tảng.
 *
 * Trước mốc M (`mocM`) chưa bật theo dõi nợ nên mọi hàm trả null; hành vi cũ giữ nguyên từng đồng.
 * Ngày so sánh theo khoá ngày VN để biên 00:00 giờ VN không bị lệch UTC.
 */
export type GanNenTang = { cardId: string; nenTang: string; tuNgay: Date };
/** Hồ sơ ví ads TRẢ TRƯỚC (`ViAdsTraTruoc`) — `ngayNeo` = ngày có số dư neo CUỐI NGÀY (= M − 1). */
export type ViAdsNeo = { nenTang: string; ngayNeo: Date };
export type NguCanhLoc = { mocM: Date | null; gan: GanNenTang[]; viAds: ViAdsNeo[] };

const MOT_NGAY_MS = 24 * 3600 * 1000;

/** Khoá ngày VN `yyyy-MM-dd` ⇒ mốc 00:00 giờ VN (biên dưới cho phép so `date ≥ mốc` của Prisma). */
function dauNgayVnTuKhoa(khoa: string): Date {
  return new Date(`${khoa}T00:00:00+07:00`);
}

/** Thẻ gánh nền tảng tại ngày d: dòng gắn có tuNgay lớn nhất ≤ d, chỉ khi d ≥ max(mocM, tuNgay). */
export function theCuaNenTang(ctx: NguCanhLoc, nenTang: string, d: Date): string | null {
  if (ctx.mocM === null) return null;
  const khoaD = khoaNgayVn(d);
  if (khoaD < khoaNgayVn(ctx.mocM)) return null;
  let tot: GanNenTang | null = null;
  for (const g of ctx.gan) {
    if (g.nenTang !== nenTang) continue;
    if (khoaNgayVn(g.tuNgay) > khoaD) continue;
    if (tot === null || g.tuNgay.getTime() > tot.tuNgay.getTime()) tot = g;
  }
  return tot === null ? null : tot.cardId;
}

/**
 * Mốc bắt đầu loại ads của nền tảng khỏi quỹ: max(mocM, min tuNgay). Không gắn hoặc M null ⇒ null.
 * Trả ĐẦU NGÀY VN (00:00 +07) của khoá ngày, không trả Date thô: bộ lọc quỹ dùng `date ≥ T_P` (so timestamp)
 * còn `theCuaNenTang` so khoá ngày — tuNgay 10:00 mà trả nguyên giờ thì Expense 00:00 cùng ngày bị trừ quỹ
 * VÀ cộng nợ thẻ (trừ hai lần).
 */
export function mocCatNenTang(ctx: NguCanhLoc, nenTang: string): Date | null {
  if (ctx.mocM === null) return null;
  let somNhat: Date | null = null;
  for (const g of ctx.gan) {
    if (g.nenTang !== nenTang) continue;
    if (somNhat === null || g.tuNgay.getTime() < somNhat.getTime()) somNhat = g.tuNgay;
  }
  if (somNhat === null) return null;
  const khoaGan = khoaNgayVn(somNhat);
  const khoaM = khoaNgayVn(ctx.mocM);
  return dauNgayVnTuKhoa(khoaGan > khoaM ? khoaGan : khoaM);
}

/**
 * Mốc bắt đầu loại chi ads của nền tảng ví TRẢ TRƯỚC khỏi quỹ: max(M, ngày KẾ TIẾP `ngayNeo`), đầu ngày VN.
 * Số dư neo là số CUỐI NGÀY `ngayNeo` (chi ngày neo đã nằm trong neo, `so-du-vi-ads.ts` đếm từ ngày sau) ⇒
 * cắt quỹ từ ngày kế tiếp — cắt sớm hơn là dòng ngày neo vừa không trừ quỹ vừa không trừ ví.
 * Chưa có hồ sơ ví hoặc M null ⇒ null: KHÔNG loại (chưa có ví thì không ghi được `ADS_TOPUP`, loại là quỹ phồng).
 */
export function mocCatViTraTruoc(ctx: NguCanhLoc, nenTang: string): Date | null {
  if (ctx.mocM === null) return null;
  const vi = ctx.viAds.find((v) => v.nenTang === nenTang);
  if (vi === undefined) return null;
  // VN không có giờ mùa hè ⇒ +24h từ 00:00 VN là đúng 00:00 VN ngày sau.
  const sauNeo = new Date(dauNgayVnTuKhoa(khoaNgayVn(vi.ngayNeo)).getTime() + MOT_NGAY_MS);
  const dauM = dauNgayVnTuKhoa(khoaNgayVn(ctx.mocM));
  return sauNeo > dauM ? sauNeo : dauM;
}

/**
 * Luật thẻ duy nhất: cardId thắng; else ads có nguồn ⇒ thẻ của nền tảng; else null.
 * `cardId` chỉ có hiệu lực khi `date ≥ mocM` (so khoá ngày VN) — bộ lọc quỹ chỉ loại `cardId ∧ date ≥ M`,
 * nên dòng trước M luôn trừ quỹ; cho nó thắng ở đây là vừa trừ quỹ vừa cộng nợ thẻ.
 */
export function theCuaDongChi(
  ctx: NguCanhLoc,
  dong: { cardId: string | null; categoryId: string; adsSource: string | null; date: Date }
): string | null {
  if (ctx.mocM === null) return null;
  if (dong.cardId !== null) {
    return khoaNgayVn(dong.date) >= khoaNgayVn(ctx.mocM) ? dong.cardId : null;
  }
  if (dong.categoryId === "ads" && dong.adsSource !== null) {
    return theCuaNenTang(ctx, dong.adsSource, dong.date);
  }
  return null;
}
