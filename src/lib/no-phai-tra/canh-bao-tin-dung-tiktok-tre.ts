import type { Prisma } from "@/generated/prisma/client";
import { dauNgayVn } from "@/lib/no-phai-tra/du-no-the";
import { prisma } from "@/lib/prisma";
import { khoaNgayVn } from "@/lib/so-quy/dong-chay-so-quy";

/**
 * Cảnh báo ĐỘ TƯƠI của ảnh chụp tín dụng TikTok tặng (Bronze `RawTiktokBusinessCost` → Silver `TiktokAdsTinDung`).
 * Lãi/Lỗ trừ phần ads trả bằng tín dụng tặng theo ảnh chụp ngày. Ảnh chụp ngừng về (quên import lại workflow
 * `tiktok-business-nightly`, Business Center mất quyền finance nên n8n bỏ qua BC, ảnh chụp bị bỏ…) thì P&L NGỪNG trừ
 * tín dụng mới trong im lặng — chi phí ads cao hơn thật. Hàm này bắt đúng ca đó để tab Lãi/Lỗ nói ra. THUẦN ĐỌC.
 *
 * Luật: có `Expense` ads TIKTOK_ADS (> 0, mọi thẻ) ngày trong 3 ngày gần nhất (giờ VN) VÀ có Business Center mà lần
 * land ảnh chụp mới nhất CỦA NÓ (`max(fetchedAt)` theo `shopId` = bc_id) cũ hơn 48 giờ — hoặc bảng chưa có ảnh chụp
 * nào ⇒ cảnh báo. Lượt kéo đêm chạy mỗi ngày (cửa sổ 7 ngày) nên 48 giờ = lỡ ít nhất một lượt trọn. Không chạy ads
 * TikTok gần đây ⇒ không báo (tín dụng không có gì để trừ).
 *
 * Vì sao THEO TỪNG BC: n8n bỏ qua (`continue`) BC mất quyền finance mà execution vẫn xanh; đo `max(fetchedAt)` cả bảng
 * thì một BC còn sống che mất BC đã chết ⇒ P&L ngừng trừ tín dụng của BC đó trong im lặng. Chỉ biết những BC ĐÃ TỪNG
 * land (không có danh sách BC chuẩn). BC thôi dùng hẳn vẫn bị báo tới khi gỡ ảnh chụp cũ của nó khỏi kho thô.
 */

const SO_NGAY_GAN_NHAT = 3;
/** Lượt kéo đêm chạy mỗi ngày ⇒ quá 48 giờ không có ảnh chụp mới là đã lỡ trọn ít nhất một lượt. */
const TRE_TOI_DA_MS = 48 * 3600 * 1000;
const MOT_NGAY_MS = 24 * 3600 * 1000;

export type CanhBaoTinDungTiktokTre = {
  /**
   * Khoá ngày VN `yyyy-MM-dd` của lần land mới nhất của BC ngừng LÂU nhất (một BC ⇒ đúng lần land mới nhất của
   * bảng); `null` = chưa có ảnh chụp nào.
   */
  tuNgay: string | null;
  /** Các BC ngừng land (sắp theo id) — CHỈ có khi kho có ≥ 2 BC; một BC thì câu cũ đã đủ rõ. */
  bcIds?: string[];
};

/** Client đọc được hai bảng cần — prisma gốc hoặc `tx`. */
type DbCanhBaoTinDung = Pick<Prisma.TransactionClient, "expense" | "rawTiktokBusinessCost">;

export async function docCanhBaoTinDungTiktokTre(
  bayGio: Date = new Date(),
  db: DbCanhBaoTinDung = prisma
): Promise<CanhBaoTinDungTiktokTre | null> {
  const dauHomNay = dauNgayVn(bayGio);
  const tu = new Date(dauHomNay.getTime() - SO_NGAY_GAN_NHAT * MOT_NGAY_MS);
  const truoc = new Date(dauHomNay.getTime() + MOT_NGAY_MS);
  const [coAds, theoBc] = await Promise.all([
    db.expense.findFirst({
      where: { categoryId: "ads", adsSource: "TIKTOK_ADS", amount: { gt: 0 }, date: { gte: tu, lt: truoc } },
      select: { id: true },
    }),
    db.rawTiktokBusinessCost.groupBy({ by: ["shopId"], _max: { fetchedAt: true } }),
  ]);
  if (coAds === null) return null;
  if (theoBc.length === 0) return { tuNgay: null };
  const tre = theoBc
    .map((g) => ({ bcId: g.shopId, lanCuoi: g._max.fetchedAt }))
    .filter((g) => g.lanCuoi === null || bayGio.getTime() - g.lanCuoi.getTime() > TRE_TOI_DA_MS)
    .sort((x, y) => x.bcId.localeCompare(y.bcId));
  if (tre.length === 0) return null;
  // Mốc báo = BC ngừng LÂU nhất (`null` — nhóm không có `fetchedAt` — coi như chưa về lần nào).
  let cuNhat: Date | null = tre[0].lanCuoi;
  for (const g of tre) {
    if (cuNhat === null) break;
    if (g.lanCuoi === null || g.lanCuoi.getTime() < cuNhat.getTime()) cuNhat = g.lanCuoi;
  }
  const tuNgay = cuNhat === null ? null : khoaNgayVn(cuNhat);
  return theoBc.length > 1 ? { tuNgay, bcIds: tre.map((g) => g.bcId) } : { tuNgay };
}

/** Câu chú thích dưới dòng "Tín dụng TikTok tặng" của tab Lãi/Lỗ (server tính sẵn, client chỉ in). */
export function cauCanhBaoTinDungTiktokTre(c: CanhBaoTinDungTiktokTre): string {
  const tu = c.tuNgay === null ? "chưa về lần nào" : `chưa về từ ${c.tuNgay.slice(8, 10)}/${c.tuNgay.slice(5, 7)}`;
  const bc = c.bcIds !== undefined && c.bcIds.length > 0 ? ` (BC ${c.bcIds.join(", ")})` : "";
  return `Ảnh chụp tín dụng TikTok ${tu}${bc} — Lãi/Lỗ có thể đang tính thừa chi phí ads (kiểm workflow n8n / quyền finance BC)`;
}
