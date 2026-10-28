import type { Prisma } from "@/generated/prisma/client";
import { docNguCanhLoc } from "@/lib/no-phai-tra/doc-ngu-canh-loc";
import { dauNgayVn, type DbDocThe } from "@/lib/no-phai-tra/du-no-the";
import { mocCatNenTang, theCuaNenTang, type NguCanhLoc } from "@/lib/no-phai-tra/the-cua-dong-chi";
import { prisma } from "@/lib/prisma";
import { khoaNgayVn } from "@/lib/so-quy/dong-chay-so-quy";

/**
 * Cảnh báo ĐỘ TƯƠI của nguồn nợ thẻ TikTok: từ khi TIKTOK_ADS gắn thẻ, dư nợ thẻ phần TikTok đọc HOÁ ĐƠN thật
 * (`TiktokAdsHoaDon`), không đọc `Expense` ads. Hoá đơn ngừng về (BC mất quyền finance, n8n bỏ qua BC, lượt dựng
 * Silver hoá đơn chưa chạy sau deploy, mapping trôi…) thì dư nợ ước tính đứng yên — THẤP hơn ngân hàng — mà chi
 * tiêu ads vẫn về đều. Hàm này bắt đúng ca đó để khối Thẻ tín dụng nói ra, thay vì để ô "Sau khi trả hết nợ" phồng
 * lên trong im lặng. THUẦN ĐỌC.
 *
 * Luật: nền tảng TIKTOK_ADS đang gắn thẻ (sau M) VÀ có `Expense` ads TikTok (`cardId` null, > 0) ngày D ≥ max(M, mốc
 * gắn) trong 3 ngày gần nhất VÀ không có hoá đơn trừ thẻ nào (`BILL_PAYMENT`/`ADD_BALANCE`, CASH, POSITIVE)
 * `createTime` ≥ D − 2 ngày ⇒ cảnh báo, kèm mốc D − 2. D = ngày chi tiêu MUỘN NHẤT (điều kiện chặt nhất: hoá đơn
 * ≥ D_max − 2 thì cũng ≥ D − 2 với mọi D sớm hơn). Lề 2 ngày phủ độ trễ API hoá đơn 6–11h + lượt kéo đêm.
 *
 * Chặn báo động giả: phần chi tiêu TikTok PHẢI TRẢ BẰNG TIỀN từ D − 2 tới D (= Σ `Expense` − Σ tín dụng tặng
 * `TiktokAdsTinDung.grantGomVat` cùng khoảng) phải ≥ `NGUONG_CHI_TRA_TIEN_DE_CO_HOA_DON`. Tín dụng tặng trả trọn chi
 * tiêu vài ngày thì không có hoá đơn trừ thẻ là ĐÚNG — so cả `Expense` gộp là báo giả.
 */

const SO_NGAY_GAN_NHAT = 3;
const LE_TRE_HOA_DON_NGAY = 2;

/**
 * Ngưỡng phần chi tiêu trả bằng tiền (gồm VAT) trong 3 ngày [D − 2, D] mà KHÔNG có hoá đơn trừ thẻ thì mới đáng báo.
 * TikTok chỉ xuất hoá đơn khi số nợ ads chạm NGƯỠNG THANH TOÁN của tài khoản (đo 21/10: 143.000đ gồm VAT một lần) ⇒
 * chi dưới ngưỡng chưa có hoá đơn là bình thường. 300.000đ ≈ 2 lần ngưỡng: chắc chắn đã phải có ít nhất một lần trừ.
 * TikTok nâng ngưỡng theo lịch sử tài khoản (500k, 1tr…) thì phải nâng số này theo, không thì báo giả đều đặn.
 */
const NGUONG_CHI_TRA_TIEN_DE_CO_HOA_DON = 300_000;
const MOT_NGAY_MS = 24 * 3600 * 1000;

export type CanhBaoHoaDonTiktok = {
  /** Khoá ngày VN `yyyy-MM-dd` — mốc từ đó lẽ ra phải có hoá đơn TikTok trừ thẻ. */
  tuNgay: string;
};

/** Client đọc được bảng nợ thẻ + Silver tín dụng tặng (để trừ phần tín dụng khỏi chi tiêu). */
type DbCanhBao = DbDocThe & Pick<Prisma.TransactionClient, "tiktokAdsTinDung">;

export async function docCanhBaoHoaDonTiktok(
  bayGio: Date = new Date(),
  db: DbCanhBao = prisma,
  ctx?: NguCanhLoc
): Promise<CanhBaoHoaDonTiktok | null> {
  const c = ctx ?? (await docNguCanhLoc(db));
  // Nền tảng đang gắn thẻ ngay lúc này (M null ⇒ null luôn) — không gắn thì nợ thẻ không đọc hoá đơn TikTok.
  if (theCuaNenTang(c, "TIKTOK_ADS", bayGio) === null) return null;
  const mocGan = mocCatNenTang(c, "TIKTOK_ADS");
  if (mocGan === null) return null;

  const dauHomNay = dauNgayVn(bayGio);
  const tuCuaSo = new Date(dauHomNay.getTime() - SO_NGAY_GAN_NHAT * MOT_NGAY_MS);
  const tu = tuCuaSo > mocGan ? tuCuaSo : mocGan;
  const truoc = new Date(dauHomNay.getTime() + MOT_NGAY_MS);
  const dieuKienAds = { categoryId: "ads", adsSource: "TIKTOK_ADS", cardId: null, amount: { gt: 0 } } as const;

  const muonNhat = await db.expense.findFirst({
    where: { ...dieuKienAds, date: { gte: tu, lt: truoc } },
    orderBy: { date: "desc" },
    select: { date: true },
  });
  if (muonNhat === null) return null;

  const tuHoaDon = new Date(dauNgayVn(muonNhat.date).getTime() - LE_TRE_HOA_DON_NGAY * MOT_NGAY_MS);
  const tuChi = tuHoaDon > mocGan ? tuHoaDon : mocGan;
  const [tongChi, tinDung, hoaDon] = await Promise.all([
    db.expense.aggregate({
      where: { ...dieuKienAds, date: { gte: tuChi, lt: truoc } },
      _sum: { amount: true },
    }),
    // Cùng khoảng ngày, cùng neo 00:00 VN với `Expense.date` của dòng ads (`TiktokAdsTinDung.ngay`).
    db.tiktokAdsTinDung.aggregate({
      where: { ngay: { gte: tuChi, lt: truoc } },
      _sum: { grantGomVat: true },
    }),
    db.tiktokAdsHoaDon.findFirst({
      where: {
        createTime: { gte: tuHoaDon },
        transactionType: { in: ["BILL_PAYMENT", "ADD_BALANCE"] },
        billingType: "CASH",
        amountType: "POSITIVE",
      },
      select: { createTime: true },
    }),
  ]);
  if (hoaDon !== null) return null;
  const chiTraTien = (tongChi._sum.amount ?? 0) - (tinDung._sum.grantGomVat ?? 0);
  if (chiTraTien < NGUONG_CHI_TRA_TIEN_DE_CO_HOA_DON) return null;
  return { tuNgay: khoaNgayVn(tuHoaDon) };
}
