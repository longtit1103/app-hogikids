import type { Prisma } from "@/generated/prisma/client";

import { mocCatNenTang, mocCatViTraTruoc, type NguCanhLoc } from "@/lib/no-phai-tra/the-cua-dong-chi";
import { khoaNgayVn } from "@/lib/so-quy/dong-chay-so-quy";
import type { KhoangNgayQuy } from "@/lib/so-quy/so-quy-queries";

/**
 * Bộ lọc "chi phí TRỪ QUỸ" dùng chung (spec §5.2 + §5.9) — Sổ quỹ (thẻ, dòng chạy, dự báo, Excel) lẫn tab
 * Dòng tiền (`getExpenseSummary` với `chiTienThat`) gọi CÙNG hàm này; mỗi bên tự viết là sớm muộn trôi.
 * Sổ chi phí (tab chi phí) KHÔNG dùng: ở đó mọi dòng vẫn hiện, chi phí vẫn là chi phí dù trả bằng gì.
 *
 * Công tắc tắt (`mocM` null) ⇒ trả ĐÚNG object cũ `{ date: khoang }` — quỹ y như trước từng đồng, bất
 * kể đã gắn thẻ hay có `cardId` (hồ sơ chuẩn bị không được đổi quỹ). Khi bật, LOẠI khỏi quỹ:
 *   (a) `cardId IS NOT NULL AND date ≥ M` — khoản chi tay "trừ vào thẻ": tiền rời quỹ lúc TRẢ THẺ;
 *   (b) `cardId IS NULL AND categoryId='ads' AND adsSource=P AND date ≥ T_P` với mỗi nền tảng P đã gắn
 *       thẻ — `T_P = mocCatNenTang(ctx, P)` (đầu ngày VN của max(M, tuNgay sớm nhất));
 *   (c) `cardId IS NULL AND adsSource=V AND date ≥ T_V` với mỗi nền tảng V ĐÃ CÓ hồ sơ `ViAdsTraTruoc`
 *       (hiện chỉ SHOPEE_ADS) — ví nạp trước: tiền rời quỹ lúc nạp (`ADS_TOPUP` → nguồn `napViTuBank`), chi
 *       chạy ads chỉ trừ VÍ. `T_V = mocCatViTraTruoc(ctx, V)` = max(M, ngày sau `ngayNeo`) — ví neo CUỐI
 *       ngày nên cắt từ ngày kế tiếp, khớp cửa sổ `so-du-vi-ads.ts`. CHƯA có hồ sơ ví ⇒ KHÔNG loại (trừ quỹ
 *       như cũ): không hồ sơ thì không ghi được `ADS_TOPUP` (CHECK `viAdsId NOT NULL`), loại là quỹ phồng.
 *       Không phụ thuộc gắn thẻ.
 *
 * Biên: `M`/`T_P` là 00:00 giờ VN (`Date`), so `gte`/`lt` trên timestamp — cùng cách `khoang` dựng bằng
 * `startOfDay`/`endOfDay` (TZ tiến trình = VN). Khớp từng ngày với `theCuaDongChi` (so khoá ngày VN):
 * dòng nào bộ lọc loại thì đúng dòng đó có thẻ gánh, không dòng nào vừa trừ quỹ vừa cộng nợ thẻ.
 *
 * Viết DƯƠNG (AND của các OR "không thuộc nhánh") thay vì `NOT: { OR: [...] }`: `adsSource`/`cardId` là
 * cột NULL được — SQL ba trị cho `NOT (NULL)` = NULL ⇒ dòng ads MANUAL không nguồn bị loại oan. Mỗi
 * phủ định của so sánh trên cột NULL được tách tường minh `{ cột: null } OR { cột: { not: X } }`.
 */

const NEN_TANG_TIKTOK_ADS = "TIKTOK_ADS";

/** 00:00 giờ VN của ngày chứa `d` — chuẩn hoá M phòng khi caller đưa Date giữa ngày. */
function dauNgayVn(d: Date): Date {
  return new Date(`${khoaNgayVn(d)}T00:00:00+07:00`);
}

/**
 * Dòng KHÔNG thuộc nhánh "ads của nền tảng P, không cardId, từ mốc `tu`" (phủ định null-an-toàn).
 * Vế `cardId not null` thừa về logic (mọi dòng cardId có date ≥ T ≥ M đã bị (a) loại) — giữ để đọc khớp §5.2.
 */
function ngoaiNhanhNenTang(nenTang: string, tu: Date, chiAds: boolean): Prisma.ExpenseWhereInput {
  return {
    OR: [
      { cardId: { not: null } },
      ...(chiAds ? [{ categoryId: { not: "ads" } }] : []),
      { adsSource: null },
      { adsSource: { not: nenTang } },
      { date: { lt: tu } },
    ],
  };
}

export function dieuKienChiPhiTruQuy(ctx: NguCanhLoc, khoang: KhoangNgayQuy): Prisma.ExpenseWhereInput {
  if (ctx.mocM === null) return { date: khoang };
  const m = dauNgayVn(ctx.mocM);

  const dieuKien: Prisma.ExpenseWhereInput[] = [
    { date: khoang },
    // (a) phủ định: không cardId, hoặc trước M (cardId trước M không có hiệu lực — vẫn trừ quỹ).
    { OR: [{ cardId: null }, { date: { lt: m } }] },
  ];
  // (c) mỗi nền tảng có hồ sơ ví trả trước — cắt tại max(M, ngày sau neo), không cần gắn thẻ.
  for (const vi of ctx.viAds) {
    const t = mocCatViTraTruoc(ctx, vi.nenTang);
    if (t !== null) dieuKien.push(ngoaiNhanhNenTang(vi.nenTang, t, false));
  }
  // (b) mỗi nền tảng đã gắn thẻ một lần — `mocCatNenTang` đã gộp mọi dòng gắn của P (lấy tuNgay sớm nhất).
  for (const nenTang of new Set(ctx.gan.map((g) => g.nenTang))) {
    const t = mocCatNenTang(ctx, nenTang);
    if (t !== null) dieuKien.push(ngoaiNhanhNenTang(nenTang, t, true));
  }
  return { AND: dieuKien };
}

/**
 * Ads TikTok sàn trừ ví được CỘNG LẠI quỹ (vì đã trừ một lần ở Sổ chi phí) — CHỈ khi Expense ads TikTok
 * cùng ngày còn trừ quỹ. Từ `T_TIKTOK_ADS` thẻ gánh ads TikTok (nhánh (b) loại Expense) nên ví KHÔNG
 * được cộng lại nữa: hai vế cắt CÙNG mốc của CÙNG nền tảng, lệch nhau là quỹ phồng/hụt đúng phần giữa.
 * Chưa gắn / tắt ⇒ không cắt (y cũ).
 */
export function dieuKienViTiktokCongLai(
  ctx: NguCanhLoc,
  khoang: KhoangNgayQuy
): Prisma.TiktokAdsSettlementWhereInput {
  const t = mocCatNenTang(ctx, NEN_TANG_TIKTOK_ADS);
  if (t === null) return { orderCreateTime: khoang };
  return { AND: [{ orderCreateTime: khoang }, { orderCreateTime: { lt: t } }] };
}
