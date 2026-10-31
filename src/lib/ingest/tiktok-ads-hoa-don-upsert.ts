import { prisma } from "@/lib/prisma";

import type { HoaDonTiktok } from "./tiktok-ads-hoa-don-mapping";
import { sqlJson, sqlThoiDiem } from "./tiktok-settlement-upsert";

/**
 * Upsert Silver `TiktokAdsHoaDon` — idempotent theo `transactionId` (chạy lại đêm sau / dựng lại không nhân
 * đôi; TikTok chỉnh hoá đơn ⇒ bản Bronze mới hơn ghi đè đúng dòng). Lỗi một dòng chỉ `skipped++` + cảnh báo,
 * KHÔNG giết lượt (khuôn `tiktok-settlement-upsert.ts`). `syncedAt` chỉ set lúc tạo (giữ lần đầu thấy).
 *
 * Chốt phiên bản `nguonFetchedAt` y khuôn `tiktok-settlement-upsert.ts`: một câu ghi, chỉ đè khi mốc kho thô mới ≥ mốc
 * đang lưu ⇒ lượt transform cầm ảnh cũ tới sau không kéo nợ thẻ lùi; thua ⇒ `hoaDonAdsSkippedStale` (không `skipped`).
 *
 * `raw` = payload Bronze để debug — ĐÃ qua `JSON.parse` nên số int64 trong đó có thể bị làm tròn; các cột id
 * (`paymentPortfolioId`, `invoiceId`, …) mới là bản lossless (rút bằng SQL).
 */

/** Bộ đếm tối thiểu — kiểu cấu trúc để module ingest không phải import ngược kiểu của tầng Bronze. */
export type BoDemHoaDon = { skipped: number; hoaDonAdsUpserted: number; hoaDonAdsSkippedStale: number };

export async function upsertOneHoaDonTiktok(
  h: HoaDonTiktok,
  raw: unknown,
  mocNguon: Date,
  stats: BoDemHoaDon,
  warnings: string[]
): Promise<void> {
  try {
    const ghi = await prisma.$queryRaw<{ ghi: number }[]>`
      INSERT INTO "TiktokAdsHoaDon" AS t (
        "id", "transactionId", "bcId", "advertiserId", "invoiceId", "createTime", "amount", "subtotal", "taxAmount",
        "transactionType", "billingType", "amountType", "paymentPortfolioId", "raw", "syncedAt", "nguonFetchedAt"
      ) VALUES (
        gen_random_uuid()::text, ${h.transactionId}::text, ${h.bcId}::text, ${h.advertiserId}::text,
        ${h.invoiceId}::text, ${sqlThoiDiem(h.createTime)}, ${h.amount}::int, ${h.subtotal}::int, ${h.taxAmount}::int,
        ${h.transactionType}::text, ${h.billingType}::text, ${h.amountType}::text, ${h.paymentPortfolioId}::text,
        ${sqlJson(raw)}, ${sqlThoiDiem(new Date())}, ${sqlThoiDiem(mocNguon)}
      )
      ON CONFLICT ("transactionId") DO UPDATE SET
        "bcId" = EXCLUDED."bcId", "advertiserId" = EXCLUDED."advertiserId", "invoiceId" = EXCLUDED."invoiceId",
        "createTime" = EXCLUDED."createTime", "amount" = EXCLUDED."amount", "subtotal" = EXCLUDED."subtotal",
        "taxAmount" = EXCLUDED."taxAmount", "transactionType" = EXCLUDED."transactionType",
        "billingType" = EXCLUDED."billingType", "amountType" = EXCLUDED."amountType",
        "paymentPortfolioId" = EXCLUDED."paymentPortfolioId", "raw" = EXCLUDED."raw",
        "nguonFetchedAt" = EXCLUDED."nguonFetchedAt"
      WHERE t."nguonFetchedAt" IS NULL OR t."nguonFetchedAt" <= EXCLUDED."nguonFetchedAt"
      RETURNING 1 AS ghi
    `;
    if (ghi.length > 0) stats.hoaDonAdsUpserted++;
    else stats.hoaDonAdsSkippedStale++;
  } catch (e) {
    stats.skipped++;
    warnings.push(`Bỏ qua hoá đơn TikTok ${h.transactionId}: ${e instanceof Error ? e.message : "upsert lỗi"}`);
  }
}
