import { Prisma } from "@/generated/prisma/client";

import { prisma } from "@/lib/prisma";

import type { HoaDonTiktok } from "./tiktok-ads-hoa-don-mapping";

/**
 * Upsert Silver `TiktokAdsHoaDon` — idempotent theo `transactionId` (chạy lại đêm sau / dựng lại không nhân
 * đôi; TikTok chỉnh hoá đơn ⇒ bản Bronze mới hơn ghi đè đúng dòng). Lỗi một dòng chỉ `skipped++` + cảnh báo,
 * KHÔNG giết lượt (khuôn `tiktok-settlement-upsert.ts`). `syncedAt` chỉ set lúc tạo (giữ lần đầu thấy).
 *
 * `raw` = payload Bronze để debug — ĐÃ qua `JSON.parse` nên số int64 trong đó có thể bị làm tròn; các cột id
 * (`paymentPortfolioId`, `invoiceId`, …) mới là bản lossless (rút bằng SQL).
 */

/** Bộ đếm tối thiểu — kiểu cấu trúc để module ingest không phải import ngược kiểu của tầng Bronze. */
export type BoDemHoaDon = { skipped: number; hoaDonAdsUpserted: number };

export async function upsertOneHoaDonTiktok(
  h: HoaDonTiktok,
  raw: unknown,
  stats: BoDemHoaDon,
  warnings: string[]
): Promise<void> {
  try {
    const data = {
      bcId: h.bcId,
      advertiserId: h.advertiserId,
      invoiceId: h.invoiceId,
      createTime: h.createTime,
      amount: h.amount,
      subtotal: h.subtotal,
      taxAmount: h.taxAmount,
      transactionType: h.transactionType,
      billingType: h.billingType,
      amountType: h.amountType,
      paymentPortfolioId: h.paymentPortfolioId,
      raw: raw as Prisma.InputJsonValue,
    };
    await prisma.tiktokAdsHoaDon.upsert({
      where: { transactionId: h.transactionId },
      create: { transactionId: h.transactionId, syncedAt: new Date(), ...data },
      update: data,
    });
    stats.hoaDonAdsUpserted++;
  } catch (e) {
    stats.skipped++;
    warnings.push(`Bỏ qua hoá đơn TikTok ${h.transactionId}: ${e instanceof Error ? e.message : "upsert lỗi"}`);
  }
}
