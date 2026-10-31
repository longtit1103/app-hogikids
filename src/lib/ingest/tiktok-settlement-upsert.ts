import { Prisma } from "@/generated/prisma/client";

import { prisma } from "@/lib/prisma";

import type { MappedAdsSettlement, MappedPayment, MappedSettlement } from "./tiktok-settlement-mapping";
import type { UpsertStats } from "./pancake-upsert";

/**
 * Upsert Silver "tiền đã về" TikTok — idempotent theo khóa tự nhiên
 * (statementId / transactionId / paymentId). Chạy lại (rebuild/nightly) không
 * nhân đôi. Lỗi 1 record chỉ `skipped++` + warning, KHÔNG giết batch.
 * `raw` giữ payload gốc để debug. `syncedAt` CHỈ đặt lúc tạo (giữ lần đầu thấy — người đọc "dòng về muộn" dựa vào
 * đó), KHÔNG bao giờ dùng làm mốc so phiên bản.
 *
 * CHỐT PHIÊN BẢN (`nguonFetchedAt`): mỗi câu ghi mang mốc phiên bản của dòng kho thô đã dựng nên nó và chỉ ĐÈ khi mốc
 * mới ≥ mốc đang lưu (NULL = dòng có trước cột ⇒ cho ghi). Hai lượt transform song song — lượt A đọc ảnh cũ, lượt B
 * ghi ảnh mới xong rồi A mới ghi — thì A bị từ chối thay vì kéo Silver lùi. `<=` (nhận BẰNG) là bắt buộc: lượt dựng lại
 * đọc đúng dòng đứng đầu đã ghi nên mốc bằng nhau, đòi "mới hơn thật" là lượt cứu dữ liệu bị từ chối sạch.
 *
 * MỘT câu `INSERT … ON CONFLICT … DO UPDATE … WHERE` (không đọc-rồi-ghi, không ném khi thua): điều kiện phiên bản nằm
 * TRONG câu ghi nên không có khe giữa so và ghi; thua thì 0 dòng trả về ⇒ đếm `*SkippedStale` (kết cục ĐÚNG, không
 * phải `skipped`). `id` tự cấp (`gen_random_uuid()`) vì `@default(cuid())` là mặc định PHÍA Prisma, cột dưới DB không
 * có mặc định.
 */

/**
 * Bộ đếm tối thiểu — kiểu cấu trúc để module ingest không phải import ngược kiểu của tầng Bronze (`TransformStats`
 * thoả kiểu này).
 */
export type BoDemTienVeTiktok = Pick<
  UpsertStats,
  | "skipped"
  | "settlementsUpserted"
  | "adsUpserted"
  | "paymentsUpserted"
  | "settlementsSkippedStale"
  | "adsSkippedStale"
  | "paymentsSkippedStale"
>;

/**
 * Thời điểm → biểu thức SQL kiểu `timestamp` theo giờ UTC — ĐÚNG cách Prisma ghi cột `DateTime` (timestamp không múi
 * giờ), bất kể `TimeZone` của phiên (cùng khuôn `ensure-recurring-expenses.ts`). `null` ⇒ NULL.
 */
export function sqlThoiDiem(d: Date | null): Prisma.Sql {
  return Prisma.sql`(${d === null ? null : d.toISOString()}::timestamptz AT TIME ZONE 'UTC')`;
}

/** Payload (đã qua `JSON.parse` của Prisma — y như cách ghi cũ) → tham số jsonb. */
export function sqlJson(raw: unknown): Prisma.Sql {
  return Prisma.sql`${raw === undefined ? null : JSON.stringify(raw)}::jsonb`;
}

export async function upsertOneSettlement(
  m: MappedSettlement,
  raw: unknown,
  mocNguon: Date,
  stats: BoDemTienVeTiktok,
  warnings: string[]
): Promise<void> {
  try {
    const ghi = await prisma.$queryRaw<{ ghi: number }[]>`
      INSERT INTO "TiktokSettlement" AS t (
        "id", "statementId", "shopId", "statementTime", "paymentTime", "paymentStatus", "paymentId",
        "settlementAmount", "revenueAmount", "feeAmount", "adjustmentAmount", "netSalesAmount", "shippingCostAmount",
        "currency", "raw", "syncedAt", "nguonFetchedAt"
      ) VALUES (
        gen_random_uuid()::text, ${m.statementId}::text, ${m.shopId}::text, ${sqlThoiDiem(m.statementTime)},
        ${sqlThoiDiem(m.paymentTime)}, ${m.paymentStatus}::text, ${m.paymentId}::text,
        ${m.settlementAmount}::int, ${m.revenueAmount}::int, ${m.feeAmount}::int, ${m.adjustmentAmount}::int,
        ${m.netSalesAmount}::int, ${m.shippingCostAmount}::int,
        ${m.currency}::text, ${sqlJson(raw)}, ${sqlThoiDiem(new Date())}, ${sqlThoiDiem(mocNguon)}
      )
      ON CONFLICT ("statementId") DO UPDATE SET
        "shopId" = EXCLUDED."shopId", "statementTime" = EXCLUDED."statementTime",
        "paymentTime" = EXCLUDED."paymentTime", "paymentStatus" = EXCLUDED."paymentStatus",
        "paymentId" = EXCLUDED."paymentId", "settlementAmount" = EXCLUDED."settlementAmount",
        "revenueAmount" = EXCLUDED."revenueAmount", "feeAmount" = EXCLUDED."feeAmount",
        "adjustmentAmount" = EXCLUDED."adjustmentAmount", "netSalesAmount" = EXCLUDED."netSalesAmount",
        "shippingCostAmount" = EXCLUDED."shippingCostAmount", "currency" = EXCLUDED."currency",
        "raw" = EXCLUDED."raw", "nguonFetchedAt" = EXCLUDED."nguonFetchedAt"
      WHERE t."nguonFetchedAt" IS NULL OR t."nguonFetchedAt" <= EXCLUDED."nguonFetchedAt"
      RETURNING 1 AS ghi
    `;
    if (ghi.length > 0) stats.settlementsUpserted++;
    else stats.settlementsSkippedStale++;
  } catch (e) {
    stats.skipped++;
    warnings.push(`Bỏ qua settlement ${m.statementId}: ${e instanceof Error ? e.message : "upsert lỗi"}`);
  }
}

export async function upsertOneAdsSettlement(
  m: MappedAdsSettlement,
  raw: unknown,
  mocNguon: Date,
  stats: BoDemTienVeTiktok,
  warnings: string[]
): Promise<void> {
  try {
    const ghi = await prisma.$queryRaw<{ ghi: number }[]>`
      INSERT INTO "TiktokAdsSettlement" AS t (
        "id", "transactionId", "shopId", "adjustmentId", "orderCreateTime", "settlementAmount", "raw", "syncedAt",
        "nguonFetchedAt"
      ) VALUES (
        gen_random_uuid()::text, ${m.transactionId}::text, ${m.shopId}::text, ${m.adjustmentId}::text,
        ${sqlThoiDiem(m.orderCreateTime)}, ${m.settlementAmount}::int, ${sqlJson(raw)}, ${sqlThoiDiem(new Date())},
        ${sqlThoiDiem(mocNguon)}
      )
      ON CONFLICT ("transactionId") DO UPDATE SET
        "shopId" = EXCLUDED."shopId", "adjustmentId" = EXCLUDED."adjustmentId",
        "orderCreateTime" = EXCLUDED."orderCreateTime", "settlementAmount" = EXCLUDED."settlementAmount",
        "raw" = EXCLUDED."raw", "nguonFetchedAt" = EXCLUDED."nguonFetchedAt"
      WHERE t."nguonFetchedAt" IS NULL OR t."nguonFetchedAt" <= EXCLUDED."nguonFetchedAt"
      RETURNING 1 AS ghi
    `;
    if (ghi.length > 0) stats.adsUpserted++;
    else stats.adsSkippedStale++;
  } catch (e) {
    stats.skipped++;
    warnings.push(`Bỏ qua ads-settlement ${m.transactionId}: ${e instanceof Error ? e.message : "upsert lỗi"}`);
  }
}

export async function upsertOnePayment(
  m: MappedPayment,
  raw: unknown,
  mocNguon: Date,
  stats: BoDemTienVeTiktok,
  warnings: string[]
): Promise<void> {
  try {
    const ghi = await prisma.$queryRaw<{ ghi: number }[]>`
      INSERT INTO "TiktokPayment" AS t (
        "id", "paymentId", "shopId", "status", "paidTime", "settlementValue", "amountValue", "reserveValue",
        "bankAccount", "raw", "syncedAt", "nguonFetchedAt"
      ) VALUES (
        gen_random_uuid()::text, ${m.paymentId}::text, ${m.shopId}::text, ${m.status}::text,
        ${sqlThoiDiem(m.paidTime)}, ${m.settlementValue}::int, ${m.amountValue}::int, ${m.reserveValue}::int,
        ${m.bankAccount}::text, ${sqlJson(raw)}, ${sqlThoiDiem(new Date())}, ${sqlThoiDiem(mocNguon)}
      )
      ON CONFLICT ("paymentId") DO UPDATE SET
        "shopId" = EXCLUDED."shopId", "status" = EXCLUDED."status", "paidTime" = EXCLUDED."paidTime",
        "settlementValue" = EXCLUDED."settlementValue", "amountValue" = EXCLUDED."amountValue",
        "reserveValue" = EXCLUDED."reserveValue", "bankAccount" = EXCLUDED."bankAccount",
        "raw" = EXCLUDED."raw", "nguonFetchedAt" = EXCLUDED."nguonFetchedAt"
      WHERE t."nguonFetchedAt" IS NULL OR t."nguonFetchedAt" <= EXCLUDED."nguonFetchedAt"
      RETURNING 1 AS ghi
    `;
    if (ghi.length > 0) stats.paymentsUpserted++;
    else stats.paymentsSkippedStale++;
  } catch (e) {
    stats.skipped++;
    warnings.push(`Bỏ qua payment ${m.paymentId}: ${e instanceof Error ? e.message : "upsert lỗi"}`);
  }
}
