import type { Prisma } from "@/generated/prisma/client";

import { chuanBiDongAdsHoacBoQua, type AdsSource } from "@/lib/ingest/ads-expense-row";
import {
  napSoChiTieuAds,
  upsertOneAdsExpense,
  type SoChiTieuAds,
} from "@/lib/ingest/ads-expense-upsert";
import {
  buildVatByMonth,
  mapMetaAdsReport,
  mapTiktokAdsReport,
  VAT_META,
  type AdsReportRow,
} from "@/lib/ingest/ads-report-mapping";
import { giuKhoaGhiChiTieuAds } from "@/lib/ingest/khoa-ghi-chi-tieu-ads";
import { docMocM } from "@/lib/no-phai-tra/cong-bat-no-phai-tra";
import { prisma } from "@/lib/prisma";
import { khoaNgayVn } from "@/lib/so-quy/dong-chay-so-quy";

import {
  chamMoc,
  latestPayloads,
  type TransformOptions,
  type TransformStats,
} from "./transform-raw-helpers";

/**
 * CHI TIÊU QUẢNG CÁO (Meta / TikTok Business) → `Expense` source=ADS_API.
 *
 * NGOẠI LỆ DUY NHẤT của transform chạm bảng do app sở hữu, và CHỈ khi `opts.rebuild` (lượt dựng
 * lại có chủ đích), CHỈ dòng `source = "ADS_API"` (cổng chặn nằm ở `upsertOneAdsExpense`). Chi phí
 * chủ shop nhập tay không có bản gốc nào để dựng lại nên tuyệt đối không được đụng tới.
 *
 * Đường ghi thường ngày vẫn là `/api/ingest/ads` (n8n đẩy mỗi đêm); nhánh này dựng LẠI đúng những
 * dòng đó từ kho thô — cùng khoá `refId` và cùng công thức tiền (`prepareAdsExpenseRow`) nên hai
 * đường KHÔNG BAO GIỜ cộng dồn, chạy lại chỉ ghi đè đúng số.
 *
 * Không lọc theo `shopId`: `shopId` ở đây là tài khoản quảng cáo (chủ shop tự tạo thêm được), lọc
 * cứng là bỏ sót chi phí của tài khoản mới.
 */

/**
 * CẮT TẠI MỐC NỢ PHẢI TRẢ M (chủ shop chốt 23/10): đã bật (M ≠ null) ⇒ lượt dựng lại BỎ QUA mọi dòng ngày VN < M —
 * không tạo, không sửa (kể cả hạ về 0đ), không xoá `Expense` ADS_API ngày < M.
 *
 * Vì sao: quỹ cuối M−1 đã CHỐT theo tiền thật bằng điều chỉnh mở sổ `CUTOVER_ADJ_*` lúc bật, nên mọi thay đổi chi
 * phí ngày < M làm `Q(M−1) + ΣCUTOVER` lệch ⇒ trang Nợ phải trả báo "trôi quỹ", P&L tháng đã chốt cũng nhích. Mà
 * lượt dựng lại KHÔNG tái tạo được đúng số n8n đã ghi: VAT TikTok ở đây gộp theo THÁNG hoá đơn, còn n8n tính theo
 * CỬA SỔ 7 ngày ⇒ chạy lại là đổi số ngày cũ dù nền tảng không chốt lại gì. Số ngày < M đang nằm trong sổ là số đã
 * đối chiếu lúc bật — giữ nguyên.
 *
 * Đường n8n hằng ngày (`/api/ingest/ads`) KHÔNG đi qua đây và GIỮ ngoại lệ của nó (nền tảng chốt lại số ngày cũ vài
 * hôm sau — xem `upsertOneAdsExpense`). Cắt ở TẦNG GỌI này chứ không ở cổng ghi chung, để cổng ghi chung vẫn phục
 * vụ đúng một luật cho cả hai đường.
 *
 * Đếm `skippedTruocM`, KHÔNG `skipped`: dòng bỏ cố ý không được giữ cờ backlog dính vĩnh viễn (xem `TransformStats`).
 * So theo KHOÁ NGÀY VN: `row.date` là chuỗi `YYYY-MM-DD` (đã kiểm khuôn năm 4 chữ số ở `ads-report-mapping.ts`) nên
 * so chuỗi = so ngày; M quy về khoá bằng `khoaNgayVn`. Cắt TRƯỚC bước tra VAT / khoá trùng: dòng < M không được
 * sinh `skipped` hay cảnh báo nào cho một khoản ta đằng nào cũng không ghi.
 */
type CatTaiMocM = {
  /** Khoá ngày VN của M (`YYYY-MM-DD`), `null` = chưa bật ⇒ không cắt gì. */
  khoaM: string | null;
  /** Số dòng đã bỏ vì ngày < M trong nhánh này. */
  soDong: number;
};

/** Đọc mốc M cho một nhánh ads: lấy M người gọi truyền xuống, chỉ tự đọc DB khi người gọi bỏ trống. */
async function napCatTaiMocM(opts: TransformOptions): Promise<CatTaiMocM> {
  const moc = opts.mocNoPhaiTra === undefined ? await docMocM() : opts.mocNoPhaiTra;
  return { khoaM: moc === null ? null : khoaNgayVn(moc), soDong: 0 };
}

/** Dòng ngày `ngay` có nằm trước M không — có thì đếm và báo người gọi bỏ dòng. */
function boQuaViTruocMocM(cat: CatTaiMocM, ngay: string): boolean {
  if (cat.khoaM === null || ngay >= cat.khoaM) return false;
  cat.soDong++;
  return true;
}

/** Tiền tố cảnh báo cắt tại M — script dựng lại lọc theo tiền tố này để in riêng, không chìm giữa cảnh báo khác. */
export const TIEN_TO_CANH_BAO_CAT_TAI_M = "Đã bật Nợ phải trả từ ";

/** Cộng bộ đếm + đẩy MỘT dòng cảnh báo cho cả nhánh (không lặp mỗi dòng). */
function chotCatTaiMocM(cat: CatTaiMocM, nhan: string, stats: TransformStats, warnings: string[]): void {
  if (cat.khoaM === null || cat.soDong === 0) return;
  stats.skippedTruocM += cat.soDong;
  const [y, m, d] = cat.khoaM.split("-");
  warnings.push(
    `${TIEN_TO_CANH_BAO_CAT_TAI_M}${d}/${m}/${y}: bỏ qua ${cat.soDong} dòng ads ${nhan} trước mốc (giữ số đã chốt)`,
  );
}

/**
 * Mở transaction riêng, giành KHOÁ GHI CHI TIÊU ADS rồi mới chạy `fn`.
 *
 * Lượt dựng lại ghi bằng client thường — nó ghi hàng chục nghìn dòng, giữ một transaction suốt lượt
 * là khoá đường ghi ads hàng phút — nên cặp "hỏi ngày này đã ghi đè bằng file chưa" + "tạo dòng" của
 * nó nằm ở 2 câu lệnh rời và có thể chen vào giữa một lượt import chưa commit (xem
 * `upsertOneAdsExpense`). Bọc ĐÚNG nhánh tạo mới là đủ để hai đường loại trừ nhau.
 *
 * Chỉ nhánh tạo mới: nhánh cập nhật là một câu `updateMany` (tự nó đã nguyên tử) và là đường đi của
 * gần như toàn bộ hàng chục nghìn khoá — bọc nó là trả thêm 3 round-trip (BEGIN + giành khoá +
 * COMMIT) cho mỗi khoá mà không đổi lấy gì.
 *
 * `timeout` phải rộng hơn thời gian bên kia khoá giữ khoá (`/api/ingest/ads` và import file đều đặt
 * 60s): thời gian NẰM CHỜ khoá tính vào hạn transaction. Quá hạn thì `ghiChiTieuAds` bắt lỗi, bỏ đúng
 * dòng đó kèm cảnh báo, lượt dựng lại sau ghi lại được.
 */
function chayTrongKhoaGhiAds<T>(
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  return prisma.$transaction(
    async (tx) => {
      await giuKhoaGhiChiTieuAds(tx);
      return fn(tx);
    },
    { timeout: 60_000, maxWait: 10_000 },
  );
}

/**
 * Dựng 1 dòng chi tiêu quảng cáo từ báo cáo trong kho thô rồi ghi vào sổ chi phí.
 *
 * `seen` chống hai dòng raw KHÁC nhau sinh CÙNG `refId` trong một lượt (2 tài khoản quảng cáo lỡ
 * trùng `campaign_id`): route ingest THROW cả lô ở ca này, lượt dựng lại thì bỏ dòng sau + cảnh báo
 * — im lặng ghi đè sẽ làm mất một khoản chi phí mà không ai biết.
 *
 * Lỗi ghi của MỘT dòng chỉ `skipped++` + cảnh báo: lượt dựng lại là đường phục hồi, ném cả lượt thì
 * mất luôn phần đã dựng dở. (Route ingest thì ngược lại — để lỗi ném ra, không ghi lô nửa vời.)
 */
async function ghiChiTieuAds(
  source: AdsSource,
  row: AdsReportRow,
  vatRate: number,
  seen: Set<string>,
  so: SoChiTieuAds,
  stats: TransformStats,
  warnings: string[],
): Promise<void> {
  // Ngày ngoài biên hợp lý: bỏ ĐÚNG dòng này kèm cảnh báo — cùng luật với `/api/ingest/ads`.
  const prepared = chuanBiDongAdsHoacBoQua(source, { ...row, vatRate }, warnings);
  if (prepared === null) {
    stats.skipped++;
    return;
  }
  if (seen.has(prepared.refId)) {
    stats.skipped++;
    warnings.push(
      `Chi tiêu ads ${prepared.refId} có 2 bản trong kho thô (2 tài khoản quảng cáo trùng campaign_id?) — ` +
        `bỏ bản sau để không ghi đè, kiểm lại nguồn`,
    );
    return;
  }
  seen.add(prepared.refId);
  try {
    await upsertOneAdsExpense(
      prisma,
      source,
      prepared,
      so,
      stats,
      warnings,
      chayTrongKhoaGhiAds,
    );
  } catch (e) {
    stats.skipped++;
    warnings.push(
      `Bỏ qua chi tiêu ads ${prepared.refId}: ${e instanceof Error ? e.message : "ghi lỗi"}`,
    );
  }
}

/** Báo cáo quảng cáo Meta trong kho thô → `Expense`. CHỈ chạy ở lượt dựng lại. */
export async function transformMetaAdsReport(
  stats: TransformStats,
  warnings: string[],
  opts: TransformOptions,
): Promise<void> {
  const { externalIds, rebuild, checkpoint } = opts;
  if (!rebuild) return; // trang ingest thường ngày: chỉ land Bronze, sổ chi phí đứng yên
  const rows = await latestPayloads("RawMetaAdsReport", { externalIds });
  if (rows.length === 0) return;

  const cat = await napCatTaiMocM(opts);
  const seen = new Set<string>();
  const so = await napSoChiTieuAds(prisma);
  let iMeta = 0;
  for (const row of rows) {
    await chamMoc(checkpoint, iMeta++);
    const m = mapMetaAdsReport(row.payload);
    if (!m.ok) {
      stats.skipped++;
      warnings.push(`Bỏ qua báo cáo ads Meta ${row.externalId}: ${m.loi}`);
      continue;
    }
    if (boQuaViTruocMocM(cat, m.row.date)) continue;
    // Meta KHÔNG có API hoá đơn cho tài khoản trả thẻ ⇒ VAT là hằng số khai tay, phải bằng
    // `CONFIG.vatRate` của `n8n/meta-ads-nightly.json` (đổi bên nào cũng phải đổi bên kia).
    await ghiChiTieuAds("META", m.row, VAT_META, seen, so, stats, warnings);
  }
  chotCatTaiMocM(cat, "Meta", stats, warnings);
}

/** Báo cáo quảng cáo TikTok Business trong kho thô → `Expense`. CHỈ chạy ở lượt dựng lại. */
export async function transformTiktokAdsReport(
  stats: TransformStats,
  warnings: string[],
  opts: TransformOptions,
): Promise<void> {
  const { externalIds, rebuild, checkpoint } = opts;
  if (!rebuild) return; // trang ingest thường ngày: chỉ land Bronze, sổ chi phí đứng yên
  const rows = await latestPayloads("RawTiktokBusinessReport", {
    externalIds,
  });
  if (rows.length === 0) return;

  // VAT đo lại từ hoá đơn Business Center trong kho thô — BẢN SOI GƯƠNG hàm `tinhVat` của
  // `n8n/tiktok-business-nightly.json`, hai nơi phải đổi cùng nhau (xem `buildVatByMonth`).
  const hoaDon = await latestPayloads("RawTiktokBusinessInvoice", {});
  const vat = buildVatByMonth(
    hoaDon.map((h) => h.payload),
    warnings,
  );

  const cat = await napCatTaiMocM(opts);
  const seen = new Set<string>();
  const so = await napSoChiTieuAds(prisma);
  let iTkb = 0;
  for (const row of rows) {
    await chamMoc(checkpoint, iTkb++);
    const m = mapTiktokAdsReport(row.payload);
    if (!m.ok) {
      stats.skipped++;
      warnings.push(`Bỏ qua báo cáo ads TikTok ${row.externalId}: ${m.loi}`);
      continue;
    }
    // Cắt TRƯỚC tra VAT: tháng < M có VAT vô lý sẽ `skipped++` (giữ cờ) cho một dòng đằng nào cũng không ghi.
    if (boQuaViTruocMocM(cat, m.row.date)) continue;
    const vatRate = vat.rateForDate(m.row.date);
    if (vatRate === null) {
      stats.skipped++; // tháng có VAT vô lý — đã cảnh báo MỘT lần ở buildVatByMonth, không lặp mỗi dòng
      continue;
    }
    await ghiChiTieuAds(
      "TIKTOK_ADS",
      m.row,
      vatRate,
      seen,
      so,
      stats,
      warnings,
    );
  }
  chotCatTaiMocM(cat, "TikTok", stats, warnings);
}
