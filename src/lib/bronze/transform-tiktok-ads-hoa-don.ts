import { mapHoaDonTiktok, type TruongHoaDonTho } from "@/lib/ingest/tiktok-ads-hoa-don-mapping";
import { upsertOneHoaDonTiktok } from "@/lib/ingest/tiktok-ads-hoa-don-upsert";
import { prisma } from "@/lib/prisma";

import {
  chamMoc,
  mocPhienBanSql,
  thuTuPhienBanSql,
  type TransformOptions,
  type TransformStats,
} from "./transform-raw-helpers";

/**
 * Nhánh hoá đơn quảng cáo TikTok (`tiktokbusiness/invoice`) → Silver `TiktokAdsHoaDon`. Gọi từ
 * `transform-from-raw.ts`, chạy ở CẢ đường ingest thường ngày (`/api/ingest/raw`, theo `externalIds` vừa land)
 * lẫn lượt dựng lại (quét cả bảng). `BRONZE_ONLY` do route chặn TRƯỚC khi tới đây (cùng mọi nhánh khác) — lượt
 * dựng lại bù sau.
 *
 * DÒNG TIỀN ĐỐI CHIẾU / NGHĨA VỤ thẻ tín dụng — KHÔNG P&L, KHÔNG quỹ. Nhánh `tiktokbusiness/report` vẫn đọc
 * THẲNG kho thô hoá đơn để đo VAT (`buildVatByMonth`) — không đổi.
 */

type HoaDonThoRow = {
  shopId: string;
  externalId: string;
  payload: unknown;
  /** Trường cấp một của payload, giá trị là CHUỖI rút bằng `#>> '{}'` — lossless cho int64 lẫn tiền. */
  truong: TruongHoaDonTho | null;
  /** Mốc phiên bản của dòng kho thô (`mocPhienBanSql`) — chốt CAS `TiktokAdsHoaDon.nguonFetchedAt`. */
  mocPhienBan: Date;
};

/**
 * Bản mới nhất của mỗi hoá đơn (Bronze append-only nhiều phiên bản) + bản đồ trường dạng chuỗi.
 *
 * Vì sao không dùng `latestPayloads`: payload qua Prisma là `JSON.parse` ⇒ `payment_portfolio_id` dạng SỐ JSON
 * bị làm tròn int64. Rút TỪNG trường cấp một thành text NGAY TRONG Postgres (jsonb giữ số chính xác) rồi mới
 * trả về — mapping chỉ đọc chuỗi. Payload không phải object (rác) ⇒ `truong` NULL ⇒ mapping trả lý do.
 *
 * `externalIds` mảng rỗng = không có gì mới land ⇒ 0 dòng (KHÔNG rơi về quét cả bảng) — cùng hợp đồng
 * `LatestFilter`. `shopId` (= bc_id) có thì lọc để dùng index `[shopId, externalId, fetchedAt]`.
 */
async function docHoaDonMoiNhat(filter: { shopId?: string; externalIds?: string[] }): Promise<HoaDonThoRow[]> {
  const conds: string[] = [];
  const params: unknown[] = [];
  if (filter.shopId !== undefined) {
    params.push(filter.shopId);
    conds.push(`"shopId" = $${params.length}`);
  }
  if (filter.externalIds !== undefined) {
    if (filter.externalIds.length === 0) return [];
    params.push(filter.externalIds);
    conds.push(`"externalId" = ANY($${params.length}::text[])`);
  }
  const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
  return prisma.$queryRawUnsafe<HoaDonThoRow[]>(
    `
    SELECT DISTINCT ON ("shopId", "externalId")
      "shopId", "externalId", payload,
      CASE WHEN jsonb_typeof(payload) = 'object'
        THEN (SELECT jsonb_object_agg(e.k, e.v #>> '{}') FROM jsonb_each(payload) AS e(k, v))
      END AS truong,
      ${mocPhienBanSql("RawTiktokBusinessInvoice")} AS "mocPhienBan"
    FROM "RawTiktokBusinessInvoice"
    ${where}
    ORDER BY "shopId", "externalId", ${thuTuPhienBanSql("RawTiktokBusinessInvoice")}
    `,
    ...params,
  );
}

/** Hoá đơn quảng cáo TikTok → Silver `TiktokAdsHoaDon` (mọi loại giao dịch, idempotent theo `transactionId`). */
export async function transformTiktokAdsHoaDon(
  stats: TransformStats,
  warnings: string[],
  opts: TransformOptions,
): Promise<void> {
  const { externalIds, shopId, checkpoint } = opts;
  let i = 0;
  for (const row of await docHoaDonMoiNhat({ shopId, externalIds })) {
    await chamMoc(checkpoint, i++);
    const m = mapHoaDonTiktok(row.externalId, row.shopId, row.truong);
    if (!m.ok) {
      // Kẹt ở Bronze (dedupe theo hash chặn dựng lại) ⇒ `skipped` — lượt dựng lại giữ cờ backlog tới khi sửa mapping.
      stats.skipped++;
      warnings.push(`Bỏ qua hoá đơn TikTok ${row.externalId}: ${m.loi}`);
      continue;
    }
    await upsertOneHoaDonTiktok(m.hoaDon, row.payload, row.mocPhienBan, stats, warnings);
  }
}
