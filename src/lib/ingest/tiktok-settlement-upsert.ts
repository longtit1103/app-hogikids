import { Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";

import type { MappedAdsSettlement, MappedPayment, MappedSettlement } from "./tiktok-settlement-mapping";
import type { UpsertStats } from "./pancake-upsert";

/**
 * Upsert Silver "tiền đã về" TikTok — idempotent theo khóa tự nhiên
 * (statementId / transactionId / paymentId). Chạy lại (rebuild/nightly) không
 * nhân đôi. Lỗi 1 record chỉ `skipped++` + warning, KHÔNG giết batch.
 * `raw` giữ payload gốc để debug. `syncedAt` KHÔNG set ở update (giữ lần đầu).
 */

const now = () => new Date();

export async function upsertOneSettlement(
  m: MappedSettlement,
  raw: unknown,
  stats: UpsertStats,
  warnings: string[]
): Promise<void> {
  try {
    const data = {
      shopId: m.shopId,
      statementTime: m.statementTime,
      paymentTime: m.paymentTime,
      paymentStatus: m.paymentStatus,
      paymentId: m.paymentId,
      settlementAmount: m.settlementAmount,
      revenueAmount: m.revenueAmount,
      feeAmount: m.feeAmount,
      adjustmentAmount: m.adjustmentAmount,
      netSalesAmount: m.netSalesAmount,
      shippingCostAmount: m.shippingCostAmount,
      currency: m.currency,
      raw: raw as Prisma.InputJsonValue,
    };
    await prisma.tiktokSettlement.upsert({
      where: { statementId: m.statementId },
      create: { statementId: m.statementId, syncedAt: now(), ...data },
      update: data,
    });
    stats.settlementsUpserted++;
  } catch (e) {
    stats.skipped++;
    warnings.push(`Bỏ qua settlement ${m.statementId}: ${e instanceof Error ? e.message : "upsert lỗi"}`);
  }
}

export async function upsertOneAdsSettlement(
  m: MappedAdsSettlement,
  raw: unknown,
  stats: UpsertStats,
  warnings: string[]
): Promise<void> {
  try {
    const data = {
      shopId: m.shopId,
      adjustmentId: m.adjustmentId,
      orderCreateTime: m.orderCreateTime,
      settlementAmount: m.settlementAmount,
      raw: raw as Prisma.InputJsonValue,
    };
    await prisma.tiktokAdsSettlement.upsert({
      where: { transactionId: m.transactionId },
      create: { transactionId: m.transactionId, syncedAt: now(), ...data },
      update: data,
    });
    stats.adsUpserted++;
  } catch (e) {
    stats.skipped++;
    warnings.push(`Bỏ qua ads-settlement ${m.transactionId}: ${e instanceof Error ? e.message : "upsert lỗi"}`);
  }
}

export async function upsertOnePayment(
  m: MappedPayment,
  raw: unknown,
  stats: UpsertStats,
  warnings: string[]
): Promise<void> {
  try {
    const data = {
      shopId: m.shopId,
      status: m.status,
      paidTime: m.paidTime,
      settlementValue: m.settlementValue,
      amountValue: m.amountValue,
      reserveValue: m.reserveValue,
      bankAccount: m.bankAccount,
      raw: raw as Prisma.InputJsonValue,
    };
    await prisma.tiktokPayment.upsert({
      where: { paymentId: m.paymentId },
      create: { paymentId: m.paymentId, syncedAt: now(), ...data },
      update: data,
    });
    stats.paymentsUpserted++;
  } catch (e) {
    stats.skipped++;
    warnings.push(`Bỏ qua payment ${m.paymentId}: ${e instanceof Error ? e.message : "upsert lỗi"}`);
  }
}
