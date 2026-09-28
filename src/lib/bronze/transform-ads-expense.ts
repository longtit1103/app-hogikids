import type { Prisma } from "@prisma/client";

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
import { prisma } from "@/lib/prisma";

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
    // Meta KHÔNG có API hoá đơn cho tài khoản trả thẻ ⇒ VAT là hằng số khai tay, phải bằng
    // `CONFIG.vatRate` của `n8n/meta-ads-nightly.json` (đổi bên nào cũng phải đổi bên kia).
    await ghiChiTieuAds("META", m.row, VAT_META, seen, so, stats, warnings);
  }
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
}
