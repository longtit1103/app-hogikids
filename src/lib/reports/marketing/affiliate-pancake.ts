import { endOfDay } from "date-fns";

import { type DateRange } from "@/lib/date-range";
import { prisma } from "@/lib/prisma";

/**
 * AFFILIATE / KOC theo kỳ — đọc `Order.raw->'advanced_platform_fee'->'affiliate_commission'`.
 *
 * Đây là TIỀN THẬT Pancake (cùng nguồn với dòng "Hoa hồng liên kết (affiliate)" trong chi tiết phí sàn
 * ở `/tai-chinh`), KHÔNG phải số sàn tự nhận công ⇒ hiển thị với nhãn "Pancake", KHÔNG bọc `<SoSanBao>`.
 *
 * ⚠️ Chỉ là CỜ NHỊ PHÂN: payload Pancake không mang creator nào cả (đo 24/08: 0/1.026 đơn có `creator`).
 * "KOC nào" là việc của P3 (`affiliate_seller/orders/search`), đừng hứa ở đây.
 *
 * Cùng tập đơn (status ∉ {RETURNED, CANCELLED}) và cùng biên phải `endOfDay(range.to)` với `calcPnl`.
 * Đo prod 25/08 00:40: `jsonb_typeof(affiliate_commission)` = **number 326 · NULL 212 · KHÔNG có string** ⇒ lọc `'number'` không hụt đồng nào.
 * `jsonb_typeof = 'number'` là bắt buộc: `advanced_platform_fee` có đơn trả `null` (đo 06/08) và cast
 * thẳng sẽ làm VĂNG cả truy vấn ⇒ trang trắng, không phải sai một dòng.
 */

export type AffiliateTheoKy = {
  /** Số đơn hợp lệ trong kỳ có `affiliate_commission` khác 0. */
  soDonCoHoaHong: number;
  /** Mẫu số tỉ lệ — số đơn hợp lệ trong kỳ (KHÔNG phải doanh thu, không thay `pnl.ts`). */
  tongSoDonHopLe: number;
  /** Σ `itemsTotal` của riêng nhóm đơn có hoa hồng. */
  doanhThuDonCoHoaHong: number;
  /** Σ `affiliate_commission`, VND Int. */
  tongHoaHong: number;
};

type Hang = {
  so_don_co_hoa_hong: number;
  tong_so_don: number;
  doanh_thu_co_hoa_hong: bigint;
  tong_hoa_hong: bigint;
};

export async function affiliateTheoKy(range: DateRange, opts?: { channelId?: string }): Promise<AffiliateTheoKy> {
  const to = endOfDay(range.to);
  const channelId = opts?.channelId ?? null;

  const [row] = await prisma.$queryRaw<Hang[]>`
    WITH don AS (
      SELECT
        o."itemsTotal" AS items_total,
        CASE WHEN jsonb_typeof(o.raw->'advanced_platform_fee'->'affiliate_commission') = 'number'
             THEN (o.raw->'advanced_platform_fee'->>'affiliate_commission')::numeric
             ELSE 0 END AS hoa_hong
      FROM "Order" o
      WHERE o."orderedAt" >= ${range.from}
        AND o."orderedAt" <= ${to}
        AND o.status::text NOT IN ('RETURNED', 'CANCELLED')
        AND (${channelId}::text IS NULL OR o."channelId" = ${channelId}::text)
    )
    SELECT
      COUNT(*) FILTER (WHERE hoa_hong <> 0)::int                              AS so_don_co_hoa_hong,
      COUNT(*)::int                                                            AS tong_so_don,
      COALESCE(SUM(items_total) FILTER (WHERE hoa_hong <> 0), 0)::bigint       AS doanh_thu_co_hoa_hong,
      COALESCE(SUM(hoa_hong), 0)::bigint                                       AS tong_hoa_hong
    FROM don
  `;

  return {
    soDonCoHoaHong: row?.so_don_co_hoa_hong ?? 0,
    tongSoDonHopLe: row?.tong_so_don ?? 0,
    doanhThuDonCoHoaHong: Number(row?.doanh_thu_co_hoa_hong ?? 0),
    tongHoaHong: Number(row?.tong_hoa_hong ?? 0),
  };
}
