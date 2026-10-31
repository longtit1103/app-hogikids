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
 * land ảnh chụp mới nhất CỦA NÓ (`max(fetchedAt)` theo `shopId` = bc_id) cũ hơn 48 giờ (trừ BC nghỉ hẳn — dưới) — hoặc
 * bảng chưa có ảnh chụp nào ⇒ cảnh báo. Lượt kéo đêm chạy mỗi ngày (cửa sổ 7 ngày) nên 48 giờ = lỡ ít nhất một lượt trọn. Không chạy ads
 * TikTok gần đây ⇒ không báo (tín dụng không có gì để trừ).
 *
 * Vì sao THEO TỪNG BC: n8n bỏ qua (`continue`) BC mất quyền finance mà execution vẫn xanh; đo `max(fetchedAt)` cả bảng
 * thì một BC còn sống che mất BC đã chết ⇒ P&L ngừng trừ tín dụng của BC đó trong im lặng. Chỉ biết những BC ĐÃ TỪNG
 * land (không có danh sách BC chuẩn).
 *
 * BC NGHỈ HẲN (thôi chạy ads, gỡ khỏi n8n): BC ngừng land mà CHI TIÊU 3 ngày gần nhất quy hết được về BC KHÁC ⇒ không
 * xét độ tươi BC đó (không có chi tiêu nào của nó để tín dụng trừ). Quy chi tiêu về BC: `Expense.refId` → báo cáo thô
 * (advertiser) → BC của advertiser theo `TiktokAdsTinDung` 30 ngày gần nhất (`docBcCoChiTieu`). Có chi tiêu KHÔNG
 * quy được (ghi tay / import không `refId`, campaign không có báo cáo thô, advertiser không có ảnh chụp 30 ngày) ⇒ xét
 * MỌI BC như cũ — thà báo thừa còn hơn im lặng khi BC đang chi tiêu thật sự chết.
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

/** Client đọc được các bảng cần — prisma gốc hoặc `tx`. */
type DbCanhBaoTinDung = Pick<
  Prisma.TransactionClient,
  "expense" | "rawTiktokBusinessCost" | "rawTiktokBusinessReport" | "tiktokAdsTinDung"
>;

/**
 * `Expense.refId` ads TikTok ⇒ `externalId` báo cáo thô (`streams.ts` sinh xuôi, `demAdsMoCoi` dựng ngược cùng luật):
 *   `TIKTOK_ADS:<ngày>:<campaign>`         → `<campaign>:<ngày>`         (GMV Max)
 *   `TIKTOK_ADS:auction:<ngày>:<campaign>` → `auction:<campaign>:<ngày>` (auction)
 * Khác khuôn ⇒ null (không quy được).
 */
function khoaBaoCaoTuRefId(refId: string): string | null {
  const m = refId.match(/^TIKTOK_ADS:(auction:)?(\d{4}-\d{2}-\d{2}):(.+)$/);
  return m === null ? null : `${m[1] ?? ""}${m[3]}:${m[2]}`;
}

/** Mapping advertiser → BC chỉ đọc ngần này ngày gần nhất: advertiser chuyển BC thì BC cũ thôi bị tính "có chi tiêu". */
const SO_NGAY_GAN_ADVERTISER_BC = 30;

/**
 * Tập BC có chi tiêu trong các dòng `Expense` đã cho (refId → báo cáo thô → advertiser → BC). `null` = có dòng không
 * quy được về BC nào ⇒ caller xét mọi BC. Chạy MỖI lần có BC ngừng land — BC nghỉ hẳn là trạng thái lâu dài nên đây
 * là đường thường xuyên (mỗi lần mở tab Lãi/Lỗ), không phải đường hiếm. Vì vậy câu kho thô KHÔNG quét cả bảng: chỉ đọc
 * dòng `fetchedAt ≥ tuChiTieu − 1 ngày` (đi index `[fetchedAt]`) rồi lọc theo tập khoá — báo cáo của ngày N không thể
 * được land trước đầu ngày N (cộng 1 ngày dư cho lệch múi advertiser), `fetchedAt` bất biến nên mọi phiên bản của khoá
 * đều nằm trong khoảng đó. Không thêm index.
 */
async function docBcCoChiTieu(
  db: DbCanhBaoTinDung,
  refIds: ReadonlyArray<string | null>,
  tuChiTieu: Date
): Promise<Set<string> | null> {
  const khoa = new Set<string>();
  for (const r of refIds) {
    const k = r === null ? null : khoaBaoCaoTuRefId(r);
    if (k === null) return null;
    khoa.add(k);
  }
  const tuMoc = new Date(tuChiTieu.getTime() - MOT_NGAY_MS);
  const baoCao = await db.rawTiktokBusinessReport.findMany({
    // Mốc phiên bản (lần land HOẶC lần thấy lại) — báo cáo kéo lại nội dung cũ trong cửa sổ vẫn tính là đã về.
    where: {
      OR: [{ fetchedAt: { gte: tuMoc } }, { lanThayCuoi: { gte: tuMoc } }],
      externalId: { in: [...khoa] },
    },
    select: { shopId: true, externalId: true },
    distinct: ["shopId", "externalId"],
  });
  const coBaoCao = new Set(baoCao.map((b) => b.externalId));
  if ([...khoa].some((k) => !coBaoCao.has(k))) return null;

  const advertisers = [...new Set(baoCao.map((b) => b.shopId))];
  const gan = await db.tiktokAdsTinDung.findMany({
    where: {
      advertiserId: { in: advertisers },
      ngay: { gte: new Date(tuChiTieu.getTime() - SO_NGAY_GAN_ADVERTISER_BC * MOT_NGAY_MS) },
    },
    select: { advertiserId: true, bcId: true },
    distinct: ["advertiserId", "bcId"],
  });
  const coBc = new Set(gan.map((g) => g.advertiserId));
  if (advertisers.some((a) => !coBc.has(a))) return null;
  return new Set(gan.map((g) => g.bcId));
}

export async function docCanhBaoTinDungTiktokTre(
  bayGio: Date = new Date(),
  db: DbCanhBaoTinDung = prisma
): Promise<CanhBaoTinDungTiktokTre | null> {
  const dauHomNay = dauNgayVn(bayGio);
  const tu = new Date(dauHomNay.getTime() - SO_NGAY_GAN_NHAT * MOT_NGAY_MS);
  const truoc = new Date(dauHomNay.getTime() + MOT_NGAY_MS);
  const [chiTieu, theoBc] = await Promise.all([
    db.expense.findMany({
      where: { categoryId: "ads", adsSource: "TIKTOK_ADS", amount: { gt: 0 }, date: { gte: tu, lt: truoc } },
      select: { refId: true },
    }),
    db.rawTiktokBusinessCost.groupBy({ by: ["shopId"], _max: { fetchedAt: true } }),
  ]);
  if (chiTieu.length === 0) return null;
  if (theoBc.length === 0) return { tuNgay: null };
  const ngung = theoBc
    .map((g) => ({ bcId: g.shopId, lanCuoi: g._max.fetchedAt }))
    .filter((g) => g.lanCuoi === null || bayGio.getTime() - g.lanCuoi.getTime() > TRE_TOI_DA_MS)
    .sort((x, y) => x.bcId.localeCompare(y.bcId));
  if (ngung.length === 0) return null;
  // BC ngừng land mà chi tiêu gần đây đều thuộc BC khác ⇒ BC nghỉ hẳn, bỏ khỏi cảnh báo.
  const bcChiTieu = await docBcCoChiTieu(
    db,
    chiTieu.map((e) => e.refId),
    tu
  );
  const tre = bcChiTieu === null ? ngung : ngung.filter((g) => bcChiTieu.has(g.bcId));
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
