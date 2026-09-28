import { Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";

import type { MappedShopeeSettlement } from "./shopee-settlement-mapping";
import type { UpsertStats } from "./pancake-upsert";

/**
 * Upsert Silver `ShopeeSettlement` — idempotent theo `externalId` (khoá tổng hợp
 * ví). Import chồng / re-land không nhân đôi. Lỗi 1 record chỉ `skipped++` +
 * warning, KHÔNG giết batch. `raw` giữ payload gốc để debug. `syncedAt` KHÔNG set
 * ở update (giữ lần đầu).
 */

const now = () => new Date();

export async function upsertOneShopeeSettlement(
  m: MappedShopeeSettlement,
  raw: unknown,
  stats: UpsertStats,
  warnings: string[]
): Promise<void> {
  try {
    const data = {
      shopId: m.shopId,
      txnTime: m.txnTime,
      type: m.type,
      orderCode: m.orderCode,
      amount: m.amount,
      status: m.status,
      runningBalance: m.runningBalance,
      raw: raw as Prisma.InputJsonValue,
    };
    await prisma.shopeeSettlement.upsert({
      where: { externalId: m.externalId },
      create: { externalId: m.externalId, syncedAt: now(), ...data },
      update: data,
    });
    stats.shopeeUpserted++;
  } catch (e) {
    stats.skipped++;
    warnings.push(`Bỏ qua shopee-settlement ${m.externalId}: ${e instanceof Error ? e.message : "upsert lỗi"}`);
  }
}
