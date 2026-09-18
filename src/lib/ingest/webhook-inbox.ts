import { createHash } from "node:crypto";

import { layCauHinhShop } from "@/lib/ket-noi/cau-hinh-shop";
import { prisma } from "@/lib/prisma";

/**
 * Hộp thư THÔ webhook Pancake POS — nơi DUY NHẤT ghi vào `RawPancakeWebhookEvent`.
 * Endpoint nhận (`/api/ingest/webhook/[shop]`) và script nạp bù dùng chung hàm này để
 * luật băm/dedupe chỉ có một bản.
 *
 * Nguyên tắc: NHẬN LÀ GHI. Không parse, không sniff loại sự kiện, không đụng Silver.
 * App chưa hiểu shape cũng phải giữ được payload — mất raw là mất vĩnh viễn (Pancake
 * không có API lấy lại lịch sử sự kiện).
 */

/**
 * Slug hợp lệ trên URL endpoint — whitelist TĨNH (cấu trúc 3 vai là cố định, chỉ GIÁ TRỊ id nằm
 * ở cấu hình): slug lạ bị từ chối 400 mà KHÔNG cần đụng DB, còn slug đúng mới resolve ra shop id.
 */
export const SHOP_SLUGS = ["kho", "shopee", "tiktok"] as const;
export type ShopSlug = (typeof SHOP_SLUGS)[number];

export function laShopSlug(s: string): s is ShopSlug {
  return (SHOP_SLUGS as readonly string[]).includes(s);
}

/**
 * Slug → shop id Pancake từ cấu hình `Setting`. THROW khi chưa cấu hình — người gọi ở đường
 * webhook phải đổi thành 503 (tạm bận, Pancake/n8n còn gửi lại + nhánh ghi file của n8n vẫn giữ
 * payload), TUYỆT ĐỐI không nuốt thành 200 rỗng.
 */
export async function shopIdTheoSlug(slug: ShopSlug): Promise<string> {
  // boQuaCache: shopId này được GHI vào hộp thư + Bronze — bản cache 60s ngay sau khi đổi id
  // sẽ sinh dòng mồ côi mang id cũ (xem ghi chú ở layCauHinhShop).
  const ch = await layCauHinhShop({ boQuaCache: true });
  return ch[slug];
}

/** Trần payload 5MB — sự kiện thật ~10–30KB; chặn body khổng lồ trước khi đụng Postgres. */
export const MAX_WEBHOOK_PAYLOAD = 5_000_000;

/** Đường vào của một dòng: bắn thẳng từ n8n, hay nạp bù từ file mẫu / bảng hệ cũ. */
export type NguonSuKien = "webhook" | "file" | "db-cu";

export function bamPayload(payload: string): string {
  return createHash("md5").update(payload, "utf8").digest("hex");
}

/**
 * Ghi một sự kiện vào hộp thư. `daGhi=false` khi trùng khoá (shop + mốc nhận + băm) —
 * chỉ xảy ra lúc chạy lại script nạp bù, KHÔNG phải lỗi. `id` trả về để pha 2 ghi kết cục
 * xử lý (`processedAs`) vào ĐÚNG dòng vừa tạo — payload gốc không bao giờ bị sửa.
 */
export async function luuSuKienWebhook(args: {
  shopId: string;
  payload: string;
  receivedAt?: Date;
  source?: NguonSuKien;
}): Promise<{ daGhi: boolean; id: string | null }> {
  const { shopId, payload, receivedAt, source = "webhook" } = args;
  try {
    const dong = await prisma.rawPancakeWebhookEvent.create({
      data: {
        shopId,
        payload,
        payloadHash: bamPayload(payload),
        source,
        ...(receivedAt ? { receivedAt } : {}),
      },
    });
    return { daGhi: true, id: dong.id };
  } catch (err) {
    if (typeof err === "object" && err !== null && (err as { code?: string }).code === "P2002") {
      return { daGhi: false, id: null };
    }
    throw err;
  }
}
