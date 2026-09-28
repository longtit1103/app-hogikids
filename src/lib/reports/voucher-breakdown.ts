import { endOfDay } from "date-fns";

import { type DateRange } from "@/lib/date-range";
import { prisma } from "@/lib/prisma";

/**
 * CHI TIẾT GIẢM GIÁ CHO KHÁCH theo kỳ — diễn giải dòng "Voucher" của P&L.
 *
 * Tiền giảm cho khách nằm ở BA chỗ khác nhau, và chỉ một trong ba hiện thành
 * dòng "Voucher" của bảng:
 *  1. Voucher mức CẢ ĐƠN, shop chịu (`Order.discount` = `total_discount`) —
 *     chính là dòng "Voucher", trừ vào doanh thu thuần. Lấy thẳng từ
 *     `PnlBreakdown.voucher`, module này KHÔNG cộng lại (một nguồn số duy nhất).
 *  2. Giảm giá TỪNG SẢN PHẨM, shop chịu (`Σ OrderItem.lineDiscount`) — đã bị
 *     trừ NGẦM khi dựng `itemsTotal`, nên "Doanh thu gộp" đã là số sau giảm giá
 *     này. Không hiện ở đâu trong bảng ⇒ chủ shop tưởng mình chỉ giảm vài nghìn
 *     trong khi thực tế giảm hàng chục triệu. Đây là số module này bù vào.
 *  3. Voucher SÀN tài trợ — tính bằng HIỆU `Σ giảm giá dòng thô − Σ
 *     OrderItem.lineDiscount` THEO TỪNG ĐƠN (cùng phép suy với drawer
 *     `orders.ts#suyVoucherSanDaApDung`). KHÔNG đọc thẳng
 *     `advanced_platform_fee.marketplace_voucher`: mapping còn CỘNG THÊM phần
 *     `suyVoucherSanTuCod` bù khi Pancake bỏ trống ô voucher — đọc field gốc là
 *     bỏ sót đúng phần đó (drawer hiện 33.460 mà bảng kỳ hiện 0 cho cùng một
 *     đơn). `lineDiscount` là phần shop chịu SAU khi mapping đã trừ voucher sàn
 *     (kẹp + suy), nên hiệu này tự động đúng theo mọi luật của mapping.
 *
 * Quan hệ bất biến: (2) + (3) = Σ `quantity × discount_each_product` — đúng
 * theo cách `pancake-mapping.ts` tách `giamGiaShopTheoDong`. Test integration
 * canh đúng đẳng thức này.
 *
 * (1) và (2) là HAI hình thức khuyến mãi khác nhau ở sàn, không phải một khoản
 * bị ghi hai chỗ — verify 2026-08-05 trên 2 đơn TikTok có cả hai:
 *   #583339446326822045: 74.688 (giảm giá SP, shop chịu) + 5.312 (voucher đơn)
 *   #583515742800938356: 108.410 + 2.590
 * cộng lại khớp ĐÚNG TỪNG ĐỒNG `seller_discount_amount` mà TikTok Shop API tự
 * chốt (80.000 và 111.000) — nếu trùng nhau thì tổng đã vượt. `total_discount`
 * còn ra tỉ lệ tròn tuyệt đối trên giá sau giảm giá dòng (2,000% và 1,000%),
 * dấu hiệu của mã giảm giá cả đơn theo phần trăm; hai đơn khác là 1.500 chẵn
 * (voucher số tiền cố định). Pancake KHÔNG lưu tên/mã voucher
 * (`activated_promotion_advances` rỗng) nên đừng tìm nhãn ở payload.
 */

export type VoucherBreakdown = {
  /** (2) Σ giảm giá từng sản phẩm shop chịu — ĐÃ trừ trong `itemsTotal`, đừng trừ lần nữa. */
  shopLineLevel: number;
  /** (3) Σ voucher sàn tài trợ đã kẹp — sàn trả thay, KHÔNG trừ vào doanh thu. */
  marketplaceFunded: number;
};

/**
 * Cùng tập "đơn hợp lệ" (status ∉ {RETURNED, CANCELLED}) và cùng biên phải kỳ
 * `endOfDay(range.to)` với `calcPnl` — lệch tập đơn là lệch số so với dòng cha.
 *
 * Vế thô lặp lại ĐÚNG các bước của `mapPancakeOrder`: clamp ≥ 0 rồi làm tròn
 * `discount_each_product`, nhân `quantity`. Vế shop chịu đọc thẳng
 * `OrderItem.lineDiscount` đã persist. Hiệu hai vế lấy THEO TỪNG ĐƠN, kẹp ≥ 0
 * (gộp toàn kỳ sẽ ra số khác khi có đơn lẻ dữ liệu dị) — nhờ đó mọi luật kẹp/suy
 * của mapping tự phản ánh vào đây, không phải chép lại lần hai.
 */
export async function computeVoucherBreakdown(
  range: DateRange,
  opts?: { channelId?: string }
): Promise<VoucherBreakdown> {
  const to = endOfDay(range.to);
  const channelId = opts?.channelId ?? null;

  // Guard ở mọi chỗ cast: payload là kho THÔ, một đơn có field đổi kiểu
  // (null/chuỗi/object) sẽ làm cả truy vấn văng lỗi chứ không chỉ sai một dòng —
  // cả trang Tài chính sẽ trắng. CHUỖI SỐ phải được nhận như số: schema ingest
  // `z.coerce` chấp nhận `"quantity":"1"` nên mapping/drawer đều tính, mà coi
  // chuỗi là 0 ở đây thì phần sàn tài trợ của đúng đơn đó biến mất khỏi bảng kỳ
  // (drawer hiện số, bảng hiện 0). Chuỗi KHÔNG phải số (regex chặn) mới coi 0.
  const [row] = await prisma.$queryRaw<{ shop_line: bigint; san: bigint }[]>`
    WITH don AS (
      SELECT o.id, o.raw
      FROM "Order" o
      WHERE o."orderedAt" >= ${range.from}
        AND o."orderedAt" <= ${to}
        AND o.status::text NOT IN ('RETURNED', 'CANCELLED')
        AND (${channelId}::text IS NULL OR o."channelId" = ${channelId}::text)
    ),
    giam_gia_dong_tho AS (
      SELECT d.id,
        COALESCE(SUM(
          GREATEST(0, ROUND(
            CASE WHEN jsonb_typeof(it->'discount_each_product') = 'number'
                   OR (jsonb_typeof(it->'discount_each_product') = 'string'
                       AND it->>'discount_each_product' ~ '^-?[0-9]{1,15}(\\.[0-9]+)?$')
                 THEN (it->>'discount_each_product')::numeric ELSE 0 END
          )) *
          CASE WHEN jsonb_typeof(it->'quantity') = 'number'
                 OR (jsonb_typeof(it->'quantity') = 'string'
                     AND it->>'quantity' ~ '^-?[0-9]{1,15}(\\.[0-9]+)?$')
               THEN (it->>'quantity')::numeric ELSE 0 END
        ), 0) AS tho
      FROM don d
      LEFT JOIN LATERAL jsonb_array_elements(
        CASE WHEN jsonb_typeof(d.raw->'items') = 'array' THEN d.raw->'items' ELSE '[]'::jsonb END
      ) AS it ON true
      GROUP BY d.id
    )
    ,
    shop_line_theo_don AS (
      SELECT oi."orderId" AS id, SUM(oi."lineDiscount")::numeric AS shop
      FROM "OrderItem" oi
      WHERE oi."orderId" IN (SELECT id FROM don)
      GROUP BY oi."orderId"
    )
    SELECT
      COALESCE(SUM(COALESCE(s.shop, 0)), 0)::bigint AS shop_line,
      COALESCE(SUM(GREATEST(0, g.tho - COALESCE(s.shop, 0))), 0)::bigint AS san
    FROM don d
    JOIN giam_gia_dong_tho g ON g.id = d.id
    LEFT JOIN shop_line_theo_don s ON s.id = d.id
  `;

  return {
    shopLineLevel: Number(row?.shop_line ?? 0),
    marketplaceFunded: Number(row?.san ?? 0),
  };
}
