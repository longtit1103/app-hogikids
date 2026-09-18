import { endOfDay } from "date-fns";

import { type DateRange } from "@/lib/date-range";
import { prisma } from "@/lib/prisma";

/**
 * KHÁCH MỚI ↔ QUAY LẠI — hai ĐỊNH NGHĨA khác nhau, cố ý trả về CẢ HAI, vì không có cách nào vừa đúng
 * vừa cắt được kỳ:
 *   (1) "trong cửa sổ app": khách có đơn hợp lệ trong kỳ mà TRƯỚC `range.from` chưa có đơn hợp lệ nào.
 *       Cắt kỳ được, nhưng chỉ thấy phần lịch sử app đang giữ (đo 24/08: 4,8%).
 *   (2) "lifetime shop": `raw.customer.order_count` — SNAPSHOT lúc Pancake fetch đơn, KHÔNG cắt kỳ được
 *       (đo 24/08: TikTok 12,8%). Ghép hai số vào một nhãn là bịa.
 * UI phải hiện 2 số với 2 nhãn riêng (spec §5.1b).
 *
 * Khoá khách là `raw.customer.id` — id CẤP SHOP: overlap giữa Shopee và TikTok = 0 (đo 24/08), nên
 * KHÔNG bao giờ gộp khách chéo kênh.
 */

export type KhachTheoKy = {
  khachTrongKy: number;
  khachMoiTrongKy: number;
  khachQuayLaiTrongKy: number;
  donHopLeTrongKy: number;
  /** Đơn hợp lệ trong kỳ KHÔNG đọc được khoá khách — Shopee mù ~60% (đo 24/08). Mẫu số phải nói ra. */
  donThieuKhoaKhach: number;
  /** Mẫu số của tỉ lệ lifetime: khách trong kỳ CÓ `order_count` đọc được. */
  khachCoSoLieuLifetime: number;
  khachLifetimeQuayLai: number;
};

type Hang = {
  khach_trong_ky: number;
  khach_moi: number;
  don_hop_le: number;
  don_thieu_khoa: number;
  khach_co_lifetime: number;
  khach_lifetime_quay_lai: number;
};

export async function khachTheoKy(range: DateRange, opts?: { channelId?: string }): Promise<KhachTheoKy> {
  const to = endOfDay(range.to);
  const channelId = opts?.channelId ?? null;

  const [row] = await prisma.$queryRaw<Hang[]>`
    WITH don_ky AS (
      SELECT
        NULLIF(o.raw->'customer'->>'id', '') AS khach_id,
        -- Trường order_count có thể là số HOẶC chuỗi số tuỳ payload ⇒ lọc regex trên dạng text rồi mới cast.
        CASE WHEN o.raw->'customer'->>'order_count' ~ '^[0-9]+$'
             THEN (o.raw->'customer'->>'order_count')::int END AS lifetime_don
      FROM "Order" o
      WHERE o."orderedAt" >= ${range.from}
        AND o."orderedAt" <= ${to}
        AND o.status::text NOT IN ('RETURNED', 'CANCELLED')
        AND (${channelId}::text IS NULL OR o."channelId" = ${channelId}::text)
    ),
    khach_ky AS (
      -- MAX: một khách nhiều đơn trong kỳ, snapshot lifetime của đơn mới hơn thường lớn hơn.
      SELECT khach_id, MAX(lifetime_don) AS lifetime_don
      FROM don_ky WHERE khach_id IS NOT NULL GROUP BY khach_id
    ),
    khach_truoc AS (
      SELECT DISTINCT NULLIF(o.raw->'customer'->>'id', '') AS khach_id
      FROM "Order" o
      WHERE o."orderedAt" < ${range.from}
        AND o.status::text NOT IN ('RETURNED', 'CANCELLED')
        AND (${channelId}::text IS NULL OR o."channelId" = ${channelId}::text)
    )
    SELECT
      (SELECT COUNT(*) FROM khach_ky)::int AS khach_trong_ky,
      (SELECT COUNT(*) FROM khach_ky k
         WHERE NOT EXISTS (SELECT 1 FROM khach_truoc t WHERE t.khach_id = k.khach_id))::int AS khach_moi,
      (SELECT COUNT(*) FROM don_ky)::int AS don_hop_le,
      (SELECT COUNT(*) FROM don_ky WHERE khach_id IS NULL)::int AS don_thieu_khoa,
      (SELECT COUNT(*) FROM khach_ky WHERE lifetime_don IS NOT NULL)::int AS khach_co_lifetime,
      (SELECT COUNT(*) FROM khach_ky WHERE lifetime_don >= 2)::int AS khach_lifetime_quay_lai
  `;

  const khachTrongKy = row?.khach_trong_ky ?? 0;
  const khachMoiTrongKy = row?.khach_moi ?? 0;
  return {
    khachTrongKy,
    khachMoiTrongKy,
    khachQuayLaiTrongKy: khachTrongKy - khachMoiTrongKy,
    donHopLeTrongKy: row?.don_hop_le ?? 0,
    donThieuKhoaKhach: row?.don_thieu_khoa ?? 0,
    khachCoSoLieuLifetime: row?.khach_co_lifetime ?? 0,
    khachLifetimeQuayLai: row?.khach_lifetime_quay_lai ?? 0,
  };
}
