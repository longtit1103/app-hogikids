import type { PrismaClient } from "@/generated/prisma/client";
import { NOI_MOC_PHIEN_BAN_DON_SQL, THU_TU_PHIEN_BAN_DON_SQL } from "@/lib/bronze/thu-tu-phien-ban-don";

/**
 * Bốn checksum TÁCH BẠCH cho dữ liệu đơn Pancake (Bronze `RawPancakeOrder` + Silver `Order`/`OrderItem`) — dùng để
 * chứng minh một thao tác (migration đánh số land, dựng lại từ kho thô, dump/restore) không đổi dữ liệu nghiệp vụ.
 *  - C1 nghiệp vụ: cột tiền/trạng thái của `Order` + dòng hàng (xếp ổn định, không theo `id`).
 *  - C2 payload: dòng Bronze (id, khoá, hash, md5 payload, fetchedAt) + md5 `Order.raw`.
 *  - C3 kết cục: dấu kết cục từng dòng Bronze.
 *  - C4 metadata (cũ): `Order.rawFetchedAt`/`syncedAt`, mốc kết cục Bronze — KHÔNG gồm `landSeq`/`rawLandSeq`
 *    (kiểm riêng bằng `soLandSeq`).
 * `banDau`: md5 của ánh xạ (shopId, externalId) → id bản đứng đầu theo thứ tự `thuTu` (mặc định thứ tự hiện hành).
 *
 * Mỗi bộ được biểu diễn bằng `row(...)::text` (KHÔNG `concat_ws`): `concat_ws` BỎ QUA NULL nên `(x, NULL, y)` và
 * `(x, y, NULL)` ra cùng chuỗi `x,y` — đổi NULL↔giá trị giữa hai cột liền kề lọt qua checksum. `row(...)::text` giữ vị
 * trí NULL (ô rỗng không ngoặc), phân biệt chuỗi rỗng (`""`) và tự đặt ngoặc kép cho giá trị chứa dấu phẩy/ngoặc ⇒ ranh
 * giới trường không trộn được. Ca đối chứng: `tests/bronze/checksum-don-pancake-giu-null-va-ranh-gioi.test.ts`.
 */
export type ChecksumDon = { c1: string; c2: string; c3: string; c4: string; banDau: string };

/** Thứ tự phiên bản đơn TRƯỚC khi có `landSeq` — chỉ để so "bản đứng đầu trước/sau migration". */
export const THU_TU_PHIEN_BAN_DON_CU_SQL = `"pbDon".moc DESC NULLS LAST, "fetchedAt" DESC, "id" DESC`;

export async function tinhChecksumDon(db: PrismaClient, thuTu: string = THU_TU_PHIEN_BAN_DON_SQL): Promise<ChecksumDon> {
  const [r] = await db.$queryRawUnsafe<ChecksumDon[]>(`
    SELECT
      (SELECT md5(coalesce(string_agg(x, '|' ORDER BY x), '')) FROM (
        SELECT row('don', "pancakeId", code, "channelId", status, "orderedAt", "statusChangedAt", "customerName",
               "itemsTotal", "shipFeeCustomer", discount, "platformFeeEst", "returnedFee", "paidAtShop",
               "backfilledFromMirror")::text x FROM "Order"
        UNION ALL
        SELECT row('dong', o."pancakeId", i."variantId", i.sku, i."productName", i.quantity, i."unitPrice",
               i."lineDiscount")::text FROM "OrderItem" i JOIN "Order" o ON o.id = i."orderId") t) AS c1,
      (SELECT md5(coalesce(string_agg(x, '|' ORDER BY x), '')) FROM (
        SELECT row('raw', id, "shopId", "externalId", "payloadHash", md5(payload::text), "fetchedAt")::text x
        FROM "RawPancakeOrder"
        UNION ALL SELECT row('don', "pancakeId", md5(raw::text))::text FROM "Order") t) AS c2,
      (SELECT md5(coalesce(string_agg(x, '|' ORDER BY x), '')) FROM (
        SELECT row(id, "silverOutcome", "silverNote", "silverAttempts")::text x FROM "RawPancakeOrder") t) AS c3,
      (SELECT md5(coalesce(string_agg(x, '|' ORDER BY x), '')) FROM (
        SELECT row('don', "pancakeId", "rawFetchedAt", "syncedAt")::text x FROM "Order"
        UNION ALL SELECT row('raw', id, "silverProcessedAt", "silverLastAttemptAt")::text FROM "RawPancakeOrder") t) AS c4,
      (SELECT md5(coalesce(string_agg(row("shopId", "externalId", id)::text, '|' ORDER BY "shopId", "externalId"), ''))
       FROM (
        SELECT DISTINCT ON ("shopId", "externalId") "shopId", "externalId", id
        FROM "RawPancakeOrder" ${NOI_MOC_PHIEN_BAN_DON_SQL}
        ORDER BY "shopId", "externalId", ${thuTu}) t) AS "banDau"
  `);
  return r;
}

/** Ánh xạ id dòng Bronze → `landSeq` (chuỗi, để so/ghi log không vướng BigInt) + `pancakeId` → `rawLandSeq`. */
export async function soLandSeq(db: PrismaClient): Promise<{ bronze: Record<string, string>; silver: Record<string, string | null> }> {
  const bronze = await db.$queryRawUnsafe<{ id: string; s: string }[]>(`SELECT id, "landSeq"::text AS s FROM "RawPancakeOrder"`);
  const silver = await db.$queryRawUnsafe<{ p: string; s: string | null }[]>(
    `SELECT "pancakeId" AS p, "rawLandSeq"::text AS s FROM "Order"`,
  );
  return {
    bronze: Object.fromEntries(bronze.map((r) => [r.id, r.s])),
    silver: Object.fromEntries(silver.map((r) => [r.p, r.s])),
  };
}
