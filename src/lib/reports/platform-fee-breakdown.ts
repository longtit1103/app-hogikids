import { endOfDay } from "date-fns";

import { type DateRange } from "@/lib/date-range";
import { prisma } from "@/lib/prisma";

/**
 * CHI TIẾT PHÍ SÀN theo kỳ — chỉ để DIỄN GIẢI dòng "Phí sàn" của P&L, KHÔNG
 * phải nguồn số thứ hai: tổng vẫn là `PnlBreakdown.platformFee` (pnl.ts), ở đây
 * chỉ chia nó ra từng khoản. Phần không chia được (Pancake không trả chi tiết)
 * hiện thành dòng riêng nên "Σ con = cha" luôn đúng — xem `buildPnlLineItems`.
 *
 * Nguồn: `Order.raw->'advanced_platform_fee'` (payload gốc Pancake lưu kèm mỗi
 * đơn Silver). KHÔNG lấy từ settlement/ví của sàn — bất biến #7 (số đối soát
 * độc lập P&L, trộn vào là đếm hai lần).
 *
 * Kiểm chứng trên dữ liệu prod 2026-08-05 (đơn hợp lệ, chỉ đọc): Σ 6 khoản dưới
 * đây = `fee_marketplace` ĐÚNG TỪNG ĐỒNG ở 11/11 đơn Shopee và 296/303 đơn
 * TikTok; 7 đơn còn lại Pancake trả `advanced_platform_fee` RỖNG (vẫn có tổng
 * phí) → rơi vào dòng "chưa có chi tiết", không bịa số.
 */

/** Khoản phí + nhãn hiển thị. Danh sách WHITELIST — key lạ KHÔNG được cộng (xem `unknown`). */
const KHOAN_PHI: { key: string; label: string }[] = [
  { key: "platform_commission", label: "Hoa hồng nền tảng" },
  { key: "affiliate_commission", label: "Hoa hồng liên kết (affiliate)" },
  { key: "payment_fee", label: "Phí giao dịch" },
  { key: "seller_transaction_fee", label: "Phí giao dịch người bán" },
  { key: "service_fee", label: "Phí dịch vụ" },
  { key: "tax", label: "Thuế sàn khấu trừ (VAT + TNCN)" },
];

const NHAN_THEO_KEY = new Map(KHOAN_PHI.map((k) => [k.key, k.label]));

/**
 * Các key CÓ trong `advanced_platform_fee` nhưng KHÔNG phải phí — liệt kê để
 * người sau khỏi tưởng bị bỏ sót:
 * - `marketplace_voucher`: voucher SÀN tài trợ (sàn trả thay khách — đã cộng
 *   vào doanh thu, bất biến #1), không phải khoản shop mất.
 * - `returned_fee`: phí đơn hoàn/hủy — là dòng RIÊNG của P&L (`returnedOrderFee`).
 * - `shipping_fee_amount` / `customer_paid_shipping_fee` / `diff_shipping_fee`:
 *   tiền ship. Trên ĐƠN HỢP LỆ — tập mà `computePlatformFeeComponents` cộng —
 *   cả ba nằm NGOÀI `fee_marketplace` (đo prod: cộng vào là vượt tổng). NGOẠI LỆ
 *   đơn hoàn: ở đó `fee_marketplace = returned_fee = service_fee +
 *   shipping_fee_amount`, tức shipping nằm TRONG tổng.
 *   Không phải xử lý gì, và cổng chặn là WHITELIST `KHOAN_PHI` chứ không phải bộ
 *   lọc status: ba khoá này không có trong `KHOAN_PHI` nên không lọt ở CẢ HAI hàm
 *   của file — kể cả `tachChiTietPhiTuRaw` vốn KHÔNG lọc status gì. Bộ lọc
 *   `status NOT IN (RETURNED, CANCELLED)` chỉ là lớp thứ hai (đo prod 2026-08-15:
 *   cả 4 đơn có `shipping_fee_amount ≠ 0` đều RETURNED, phí của chúng đi dòng
 *   `returnedOrderFee`).
 * - `marketplace_promotion` (Shopee): mảng MÃ khuyến mãi dạng chuỗi, không phải
 *   tiền. `settlement` / `statement` (TikTok): object đối soát — CHỨA tiền thật
 *   và trùng tuyệt đối `fee_marketplace` (`-settlement.fee_tax_amount` khớp
 *   14/14), nhưng dùng nó cho P&L là mở nguồn phí thứ hai ⇒ phá bất biến #7.
 */

export type PlatformFeeComponent = {
  key: string;
  label: string;
  /** VND, DƯƠNG (là khoản bị trừ — đổi dấu ở lớp hiển thị, quy ước `displayValue`). */
  amount: number;
};

/**
 * Tách chi tiết phí của MỘT đơn từ `Order.raw` — bản THUẦN (không DB) của phép
 * cộng ở `computePlatformFeeComponents`, dùng cho drawer chi tiết đơn.
 *
 * Dùng CHUNG `KHOAN_PHI` với bản theo kỳ: khai whitelist lần thứ hai là mở đường
 * cho hai màn cộng ra hai số phí khác nhau trên cùng một đơn.
 */
export function tachChiTietPhiTuRaw(raw: unknown): PlatformFeeComponent[] {
  const apf = (raw as { advanced_platform_fee?: unknown } | null)?.advanced_platform_fee;
  if (!apf || typeof apf !== "object" || Array.isArray(apf)) return [];

  const khoan = apf as Record<string, unknown>;
  return KHOAN_PHI.map((k) => ({ key: k.key, label: k.label, amount: Math.round(Number(khoan[k.key] ?? 0)) }))
    .filter((c) => Number.isFinite(c.amount) && c.amount !== 0)
    .sort((a, b) => b.amount - a.amount);
}

/**
 * Cộng dồn từng khoản phí của các đơn HỢP LỆ trong kỳ (status ∉
 * {RETURNED, CANCELLED}) — cùng định nghĩa "đơn hợp lệ" và cùng biên phải kỳ
 * `endOfDay(range.to)` với `calcPnl`, nếu không tổng con sẽ lệch tổng cha.
 *
 * Trả về danh sách đã bỏ khoản 0 và sắp giảm dần theo số tiền.
 */
export async function computePlatformFeeComponents(
  range: DateRange,
  opts?: { channelId?: string }
): Promise<PlatformFeeComponent[]> {
  const to = endOfDay(range.to);
  const keys = KHOAN_PHI.map((k) => k.key);

  // `jsonb_each` + whitelist thay vì đọc từng key: khoản Pancake thêm về sau sẽ
  // KHÔNG âm thầm lọt vào tổng con (nó rơi vào "chưa có chi tiết" — thà thiếu
  // còn hơn cộng nhầm khoản không phải phí). `jsonb_typeof = 'number'` chặn
  // `settlement`/`statement` (object) và giá trị null làm hỏng phép cast.
  // `jsonb_each` VĂNG LỖI trên giá trị không phải object ("cannot call jsonb_each on a non-object"),
  // mà schema khai `advanced_platform_fee` là nullish ⇒ chỉ một đơn có `null` là cả trang Lãi/Lỗ trả
  // 500, mất luôn bảng P&L lẫn nút xuất Excel. Guard `jsonb_typeof(k.value)` ở WHERE không cứu được:
  // nó chạy SAU khi hàm đã văng. Ép về `{}` ngay tại nguồn — cùng cách `voucher-breakdown.ts` làm với `items`.
  const rows = await prisma.$queryRaw<{ key: string; amount: bigint }[]>`
    SELECT k.key AS key, SUM((k.value #>> '{}')::numeric)::bigint AS amount
    FROM "Order" o,
    jsonb_each(
      CASE WHEN jsonb_typeof(o.raw->'advanced_platform_fee') = 'object'
           THEN o.raw->'advanced_platform_fee' ELSE '{}'::jsonb END
    ) AS k
    WHERE o."orderedAt" >= ${range.from}
      AND o."orderedAt" <= ${to}
      AND o.status::text NOT IN ('RETURNED', 'CANCELLED')
      -- Đơn BÙ có platformFeeEst là số ƯỚC (Pancake mất đơn gốc) nên khoản chi
      -- tiết trong payload — nếu có — KHÔNG cùng gốc với tổng phí của nó. Trộn vào
      -- đây là chia nhầm giữa hai dòng con "Đơn bù" và "Pancake chưa trả chi tiết",
      -- nặng hơn thì đẻ dòng đỏ "Chênh lệch chi tiết" báo động giả.
      -- Đo prod 2026-08-06: cả 24 đơn bù đều có khối rỗng ⇒ loại ra KHÔNG đổi số
      -- hiện tại, chỉ chặn ca payload mirror về sau có chi tiết.
      AND o."backfilledFromMirror" = false
      AND (${opts?.channelId ?? null}::text IS NULL OR o."channelId" = ${opts?.channelId ?? null}::text)
      AND k.key = ANY(${keys}::text[])
      AND jsonb_typeof(k.value) = 'number'
    GROUP BY k.key
  `;

  return rows
    .map((r) => ({
      key: r.key,
      label: NHAN_THEO_KEY.get(r.key) ?? r.key,
      amount: Number(r.amount),
    }))
    .filter((c) => c.amount !== 0)
    .sort((a, b) => b.amount - a.amount);
}

/**
 * Σ phí sàn của các đơn ĐƯỢC BÙ từ bản sao kho trong kỳ (`backfilledFromMirror`).
 *
 * Phí của chúng là ƯỚC TÍNH do app tự tính (Pancake mất đơn gốc nên không có
 * `fee_marketplace` thật), vì vậy chúng KHÔNG BAO GIỜ chia được thành khoản.
 * Tách riêng để dòng "chưa chia được" nói rõ bao nhiêu là do đơn bù — đo prod
 * 2026-08-06: một cụm đơn chiếm 96% phần chưa chia được, mà nhìn bảng
 * thì tưởng Pancake trả thiếu dữ liệu.
 *
 * Cùng tập đơn + cùng biên kỳ với `computePlatformFeeComponents` và `calcPnl`.
 */
export async function computeBackfilledPlatformFee(
  range: DateRange,
  opts?: { channelId?: string }
): Promise<number> {
  const agg = await prisma.order.aggregate({
    _sum: { platformFeeEst: true },
    where: {
      orderedAt: { gte: range.from, lte: endOfDay(range.to) },
      status: { notIn: ["RETURNED", "CANCELLED"] },
      backfilledFromMirror: true,
      ...(opts?.channelId ? { channelId: opts.channelId } : {}),
    },
  });
  return agg._sum.platformFeeEst ?? 0;
}
