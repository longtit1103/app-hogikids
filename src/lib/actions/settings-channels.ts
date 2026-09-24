"use server";

import { endOfDay } from "date-fns";
import { revalidatePath } from "next/cache";
import { z } from "zod";

import type { ActionResult } from "@/lib/actions/action-result";
import { dangPhucHoi, LOI_DANG_PHUC_HOI } from "@/lib/backup/khoa-bao-tri";
import { REAL_FEE_CHANNELS } from "@/lib/channels/real-fee-channels";
import type { DateRange } from "@/lib/date-range";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";

// ---- Cài đặt › Kênh bán (bật/tắt, phí %, màu) + "Tính lại phí kỳ này" -------
// ⚠️ CHẠM BẤT BIẾN #1: `recomputeFeesInRange` ghi `platformFeeEst`. Hàng rào
// `notIn: REAL_FEE_CHANNELS` giữ nguyên phí THẬT của Shopee/TikTok — KHÔNG optional.

const channelConfigSchema = z
  .array(
    z.object({
      id: z.enum(["shopee", "tiktok", "facebook", "website", "direct"]),
      isActive: z.boolean(),
      platformFeePct: z.number().min(0).max(100),
      paymentFeePct: z.number().min(0).max(100),
      color: z.string().regex(/^#[0-9a-fA-F]{6}$/, "Màu không hợp lệ"),
    }),
  )
  .length(5)
  .refine((a) => a.some((c) => c.isActive), "Phải có ít nhất 1 kênh hoạt động");

/** Làm tròn % về 2 chữ số thập phân (nhập tay có thể ra 3.333…). */
const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Lưu cấu hình 5 kênh (bật/tắt, phí sàn %, phí thanh toán %, màu). TUYỆT ĐỐI
 * KHÔNG đụng vào đơn đã có — % chỉ là tham số dự phòng cho đơn Facebook/Website;
 * đơn Shopee/TikTok luôn giữ phí THẬT từ Pancake. Muốn áp % mới cho đơn cũ
 * (chỉ FB/Website) phải bấm "Tính lại phí kỳ này" (recomputeFeesInRange).
 */
export async function updateChannels(input: unknown): Promise<ActionResult> {
  await requireUser();
  if (dangPhucHoi()) return { ok: false, error: LOI_DANG_PHUC_HOI };

  const parsed = channelConfigSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0].message };
  }

  try {
    await prisma.$transaction(
      parsed.data.map((c) =>
        prisma.channel.update({
          where: { id: c.id },
          data: {
            isActive: c.isActive,
            platformFeePct: round2(c.platformFeePct),
            paymentFeePct: round2(c.paymentFeePct),
            color: c.color,
          },
        }),
      ),
    );
  } catch {
    return { ok: false, error: "Lỗi khi lưu cấu hình kênh" };
  }

  revalidatePath("/cai-dat");
  return { ok: true, data: undefined };
}

/**
 * Đếm SỐ đơn mà "Tính lại phí kỳ này" sẽ đụng tới trong kỳ — CHỈ kênh KHÔNG có
 * phí sàn thật (Facebook/Website). Đơn Shopee/TikTok mang phí THẬT Pancake nên
 * bị `notIn` loại ra; dialog phải hiện đúng con số này, không được "nói dối"
 * bằng cách đếm cả đơn marketplace. Dùng cùng biên `endOfDay(to)` với recompute.
 */
export async function countRecomputableOrders(
  range: DateRange,
): Promise<ActionResult<{ count: number }>> {
  await requireUser();

  const count = await prisma.order.count({
    where: {
      orderedAt: { gte: range.from, lte: endOfDay(range.to) },
      channelId: { notIn: [...REAL_FEE_CHANNELS] },
    },
  });

  return { ok: true, data: { count } };
}

/**
 * "Tính lại phí kỳ này" — tính lại platformFeeEst ƯỚC TÍNH theo % hiện hành,
 * CHỈ cho đơn kênh KHÔNG có phí sàn thật (Facebook/Website).
 *
 * HÀNG RÀO AN TOÀN (bất biến #1): `channelId: { notIn: [...REAL_FEE_CHANNELS] }`
 * loại toàn bộ đơn Shopee/TikTok — phí 2 kênh này là số THẬT `fee_marketplace`,
 * TUYỆT ĐỐI không được ghi đè bằng ước tính (không hoàn tác được). Filter này
 * KHÔNG optional.
 *
 * Idempotent: chỉ ghi khi phí mới khác phí cũ → chạy lần 2 trả updated=0. Ghi
 * mọi status (P&L tự loại RETURNED/CANCELLED khi cộng). Biên `endOfDay(to)`
 * khớp toàn app (tránh sót đơn ngày cuối kỳ); giờ VN vì container
 * TZ=Asia/Ho_Chi_Minh. Nới timeout vì loop UPDATE có thể > 5s mặc định.
 */
export async function recomputeFeesInRange(
  range: DateRange,
): Promise<ActionResult<{ updated: number }>> {
  await requireUser();
  // Lượt này UPDATE `platformFeeEst` của cả kỳ trong MỘT transaction tới 60s. Chạy giữa lượt phục
  // hồi thì hoặc chết giữa chừng vì bảng bị drop, hoặc commit xong rồi bị bản backup lùi lại —
  // cả hai đều để lại phí sàn không khớp gì cả.
  if (dangPhucHoi()) return { ok: false, error: LOI_DANG_PHUC_HOI };

  const updated = await prisma.$transaction(
    async (tx) => {
      const channels = await tx.channel.findMany();
      const pctById = new Map(channels.map((c) => [c.id, c.platformFeePct + c.paymentFeePct]));

      const orders = await tx.order.findMany({
        where: {
          orderedAt: { gte: range.from, lte: endOfDay(range.to) },
          channelId: { notIn: [...REAL_FEE_CHANNELS] },
        },
        select: { id: true, channelId: true, itemsTotal: true, platformFeeEst: true },
      });

      let n = 0;
      for (const o of orders) {
        const fee = Math.round((o.itemsTotal * (pctById.get(o.channelId) ?? 0)) / 100);
        if (fee !== o.platformFeeEst) {
          await tx.order.update({ where: { id: o.id }, data: { platformFeeEst: fee } });
          n++;
        }
      }
      return n;
    },
    { maxWait: 10_000, timeout: 60_000 },
  );

  revalidatePath("/", "layout");
  return { ok: true, data: { updated } };
}
