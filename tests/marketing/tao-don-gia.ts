import { Prisma, type OrderStatus } from "@prisma/client";

import { prisma } from "@/lib/prisma";

/**
 * Dựng 1 đơn Silver + payload `raw` tối thiểu cho các reader marketing (chúng đọc jsonb, không đọc
 * cột Silver). Ghi thẳng Prisma là ĐÚNG ở đây: đối tượng kiểm là câu SQL đọc `raw`, không phải mapping —
 * đi qua `/api/ingest/raw` sẽ buộc dựng cả payload Pancake hợp lệ mà chẳng kiểm thêm được gì.
 */
let dem = 0;

export async function taoDon(opts: {
  channelId?: string;
  status?: OrderStatus;
  orderedAt: Date;
  itemsTotal: number;
  raw?: Record<string, unknown>;
}): Promise<string> {
  dem += 1;
  const o = await prisma.order.create({
    data: {
      pancakeId: `TEST-MKT-${Date.now()}-${dem}`,
      code: String(dem),
      channelId: opts.channelId ?? "tiktok",
      status: opts.status ?? "COMPLETED",
      orderedAt: opts.orderedAt,
      itemsTotal: opts.itemsTotal,
      syncedAt: new Date(),
      raw: (opts.raw ?? {}) as Prisma.InputJsonValue,
    },
    select: { id: true },
  });
  return o.id;
}
