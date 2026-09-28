import { endOfDay } from "date-fns";

import { type DateRange } from "@/lib/date-range";
import { prisma } from "@/lib/prisma";

/**
 * TÁCH "hoàn" khỏi "hủy/bom" — `/kenh` và `pnl.ts` GỘP hai thứ này làm một (`returnBomOrderCount`),
 * mà chúng là hai vấn đề kinh doanh khác nhau: hoàn = khách nhận rồi trả (chất lượng/mô tả), hủy = đơn
 * chết trước khi giao (bom hàng/giá ship). Đọc mã gốc `Order.raw->>'status'` (mã 4/5 vs 6/7 theo
 * `PANCAKE_STATUS_MAP`) — KHÔNG đụng, KHÔNG đổi số nào của `pnl.ts`.
 *
 * Đi ĐÚNG đường của `mapStatus()` (`pancake-mapping.ts`): mã số trước, rồi FALLBACK theo TÊN trạng thái
 * (`status_name`) qua `PANCAKE_STATUS_NAME_MAP`. Thiếu nhánh tên thì đơn mà mapping vẫn xếp đúng nhờ tên
 * (mã lạ + tên "returning") sẽ rơi xuống `khongRoMa` ở đây — bảng nói "không rõ" về đơn mà app thừa biết
 * là đơn hoàn.
 *
 * Đơn không đọc được CẢ mã LẪN tên rơi vào `khongRoMa` (không im lặng bỏ): tổng 3 nhóm PHẢI bằng số
 * hoàn/bom mà `/kenh` đang hiện cho cùng kỳ + kênh.
 */

export type NhomHoanHuy = { soDon: number; tien: number };
export type HoanHuyTach = { hoan: NhomHoanHuy; huy: NhomHoanHuy; khongRoMa: NhomHoanHuy };

type Hang = { nhom: string; so_don: number; tien: bigint };

export async function hoanHuyTach(range: DateRange, opts?: { channelId?: string }): Promise<HoanHuyTach> {
  const to = endOfDay(range.to);
  const channelId = opts?.channelId ?? null;

  const rows = await prisma.$queryRaw<Hang[]>`
    SELECT
      CASE
        WHEN o.raw->>'status' IN ('4', '5') THEN 'hoan'
        WHEN o.raw->>'status' IN ('6', '7') THEN 'huy'
        -- Fallback theo TÊN, đúng thứ tự mapStatus: mã số thua thì mới xét status_name.
        -- btrim + lower khớp phép chuẩn hoá .trim().toLowerCase() của mapStatus.
        WHEN lower(btrim(o.raw->>'status_name')) IN ('returning', 'returned') THEN 'hoan'
        WHEN lower(btrim(o.raw->>'status_name')) IN ('canceled', 'cancelled') THEN 'huy'
        ELSE 'khong_ro'
      END AS nhom,
      COUNT(*)::int AS so_don,
      COALESCE(SUM(o."itemsTotal"), 0)::bigint AS tien
    FROM "Order" o
    WHERE o."orderedAt" >= ${range.from}
      AND o."orderedAt" <= ${to}
      AND o.status::text IN ('RETURNED', 'CANCELLED')
      AND (${channelId}::text IS NULL OR o."channelId" = ${channelId}::text)
    GROUP BY 1
  `;

  const lay = (nhom: string): NhomHoanHuy => {
    const r = rows.find((x) => x.nhom === nhom);
    return { soDon: r?.so_don ?? 0, tien: Number(r?.tien ?? 0) };
  };
  return { hoan: lay("hoan"), huy: lay("huy"), khongRoMa: lay("khong_ro") };
}
