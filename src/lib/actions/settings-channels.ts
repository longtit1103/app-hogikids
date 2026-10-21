"use server";

import { differenceInCalendarDays, endOfDay } from "date-fns";
import { revalidatePath } from "next/cache";
import { z } from "zod";

import type { ActionResult } from "@/lib/actions/action-result";
import { dangPhucHoi, LOI_DANG_PHUC_HOI } from "@/lib/backup/khoa-bao-tri";
import { REAL_FEE_CHANNELS } from "@/lib/channels/real-fee-channels";
import type { DateRange } from "@/lib/date-range";
import { ghiNhatKy } from "@/lib/nhat-ky/ghi-nhat-ky";
import { HANH_DONG } from "@/lib/nhat-ky/hanh-dong";
import { prisma } from "@/lib/prisma";
import { congAction } from "@/lib/quyen/cong-action";

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

/** Trần số ngày của kỳ "Tính lại phí": một transaction UPDATE từng đơn có hạn 60s, kỳ vô hạn sẽ vượt. */
const TRAN_NGAY_TINH_LAI_PHI = 366;

/**
 * Kỳ nhận từ client: hai ngày phải là Date thật (Invalid Date bị `z.date()` loại), `from ≤ to` và
 * kỳ không dài quá 366 ngày (đếm cả hai đầu). Tin client thì 1970→2100 sẽ chạy transaction 60s.
 */
const rangeTinhLaiPhiSchema = z
  .object({ from: z.date({ error: "Ngày bắt đầu không hợp lệ" }), to: z.date({ error: "Ngày kết thúc không hợp lệ" }) })
  .refine((r) => r.from.getTime() <= r.to.getTime(), { message: "Ngày bắt đầu phải trước hoặc bằng ngày kết thúc" })
  .refine((r) => differenceInCalendarDays(r.to, r.from) + 1 <= TRAN_NGAY_TINH_LAI_PHI, {
    message: `Kỳ tính lại phí tối đa ${TRAN_NGAY_TINH_LAI_PHI} ngày — chọn kỳ ngắn hơn`,
  });

/** Làm tròn % về 2 chữ số thập phân (nhập tay có thể ra 3.333…). */
const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Lưu cấu hình 5 kênh (bật/tắt, phí sàn %, phí thanh toán %, màu). TUYỆT ĐỐI
 * KHÔNG đụng vào đơn đã có — % chỉ là tham số dự phòng cho đơn Facebook/Website;
 * đơn Shopee/TikTok luôn giữ phí THẬT từ Pancake. Muốn áp % mới cho đơn cũ
 * (chỉ FB/Website) phải bấm "Tính lại phí kỳ này" (recomputeFeesInRange).
 */
export async function updateChannels(input: unknown): Promise<ActionResult> {
  const cong = await congAction("cai-dat:sua");
  if (!cong.ok) return cong;
  if (dangPhucHoi()) return { ok: false, error: LOI_DANG_PHUC_HOI };

  const parsed = channelConfigSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0].message };
  }

  try {
    await prisma.$transaction(async (tx) => {
      for (const c of parsed.data) {
        await tx.channel.update({
          where: { id: c.id },
          data: {
            isActive: c.isActive,
            platformFeePct: round2(c.platformFeePct),
            paymentFeePct: round2(c.paymentFeePct),
            color: c.color,
          },
        });
      }
      await ghiNhatKy(tx, { actor: cong.nguoiDung, hanhDong: HANH_DONG.CAI_DAT_KENH });
    });
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
  const cong = await congAction("cai-dat:xem");
  if (!cong.ok) return cong;

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
  const cong = await congAction("cai-dat:sua");
  if (!cong.ok) return cong;
  // Lượt này UPDATE `platformFeeEst` của cả kỳ trong MỘT transaction tới 60s. Chạy giữa lượt phục
  // hồi thì hoặc chết giữa chừng vì bảng bị drop, hoặc commit xong rồi bị bản backup lùi lại —
  // cả hai đều để lại phí sàn không khớp gì cả.
  if (dangPhucHoi()) return { ok: false, error: LOI_DANG_PHUC_HOI };

  const kyHopLe = rangeTinhLaiPhiSchema.safeParse(range);
  if (!kyHopLe.success) {
    return { ok: false, error: kyHopLe.error.issues[0]?.message ?? "Kỳ tính lại phí không hợp lệ" };
  }
  range = kyHopLe.data;

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
      await ghiNhatKy(tx, { actor: cong.nguoiDung, hanhDong: HANH_DONG.CAI_DAT_TINH_LAI_PHI, ghiChu: { soDong: n } });
      return n;
    },
    { maxWait: 10_000, timeout: 60_000 },
  );

  revalidatePath("/", "layout");
  return { ok: true, data: { updated } };
}
