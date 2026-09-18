import { layCauHinhShop } from "@/lib/ket-noi/cau-hinh-shop";
import { WEBHOOK_PANCAKE_PATH } from "@/lib/n8n/provision/doc-goi-workflow-tu-repo";
import { prisma } from "@/lib/prisma";

/**
 * Webhook Pancake trong khối "Khóa kết nối": chặng Pancake → n8n KHÔNG có khóa nào để điền
 * (bảo mật nằm ở chặng n8n → app bằng bearer hạ tầng), nên phần cấu hình duy nhất thuộc về
 * chủ shop là DÁN ĐÚNG URL vào Pancake của từng shop. Khối này hiện URL đó + mốc sự kiện
 * gần nhất để biết webhook còn sống hay đã đứt (đứt = tồn kho/trạng thái đơn hết realtime,
 * chỉ còn lượt API đêm vét bù).
 *
 * URL soi gương `n8n/huong-dan-cai-dat-workflows.md` mục "Webhook Pancake — 3 workflow":
 * path KHÔNG phải secret (thiết kế đã chốt 2026-07-22) — hiện lên UI được.
 */

/**
 * Base MẶC ĐỊNH khi chưa điền `Setting.n8nWebhookPublicBase` — đúng giá trị prod HogiKids đang
 * chạy (giữ hành vi hiển thị cho tới khi chủ shop điền ô mới; bản clone PHẢI điền vì n8n của họ
 * ở domain khác). Path lấy TỪ chính JSON workflow (`WEBHOOK_PANCAKE_PATH`) — một nguồn sự thật,
 * lệch path là URL dán vào Pancake trỏ vào hư không.
 */
const N8N_WEBHOOK_BASE_MAC_DINH = "https://n8n.example.com";

const DS_WEBHOOK = [
  { ten: "Shop Kho Tổng", vai: "kho" },
  { ten: "Shop Shopee", vai: "shopee" },
  { ten: "Shop TikTok", vai: "tiktok" },
] as const;

export type TrangThaiWebhookShop = {
  ten: string;
  url: string;
  /** "14:03 20/08 (28 phút trước)" — format sẵn phía server; `null` = CHƯA TỪNG nhận sự kiện live. */
  ganNhat: string | null;
};

function tuongDoi(truocMs: number): string {
  const phut = Math.floor(truocMs / 60_000);
  if (phut < 1) return "vừa xong";
  if (phut < 60) return `${phut} phút trước`;
  const gio = Math.floor(phut / 60);
  if (gio < 48) return `${gio} giờ trước`;
  return `${Math.floor(gio / 24)} ngày trước`;
}

function lucVN(d: Date): string {
  return d.toLocaleString("vi-VN", {
    timeZone: "Asia/Ho_Chi_Minh",
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export async function docTrangThaiWebhookPancake(bayGio: Date = new Date()): Promise<TrangThaiWebhookShop[]> {
  // CHỈ source=webhook: dòng nạp bù (file/db-cu) là quá khứ, tính vào đây sẽ làm webhook chết
  // trông như còn sống.
  const moc = await prisma.rawPancakeWebhookEvent.groupBy({
    by: ["shopId"],
    where: { source: "webhook" },
    _max: { receivedAt: true },
  });
  const theoShop = new Map(moc.map((m) => [m.shopId, m._max.receivedAt]));

  // Base URL public của n8n từ cấu hình (khối "Kết nối n8n"); chưa điền → mặc định prod.
  const rowBase = await prisma.setting.findUnique({ where: { key: "n8nWebhookPublicBase" } });
  const base = (rowBase?.value.trim().replace(/\/+$/, "") || N8N_WEBHOOK_BASE_MAC_DINH) + "/webhook";

  // Chưa cấu hình shop ID ⇒ vẫn hiện URL (để người dùng cấu hình Pancake được) nhưng không tra
  // được mốc theo shop — trang Cài đặt không được chết vì thiếu chính thứ nó giúp điền.
  let shopIdTheoVai: Record<(typeof DS_WEBHOOK)[number]["vai"], string> | null = null;
  try {
    const ch = await layCauHinhShop();
    shopIdTheoVai = { kho: ch.kho, shopee: ch.shopee, tiktok: ch.tiktok };
  } catch {
    shopIdTheoVai = null;
  }

  return DS_WEBHOOK.map((w) => {
    const luc = shopIdTheoVai ? (theoShop.get(shopIdTheoVai[w.vai]) ?? null) : null;
    return {
      ten: w.ten,
      url: `${base}/${WEBHOOK_PANCAKE_PATH[w.vai]}`,
      ganNhat: luc ? `${lucVN(luc)} (${tuongDoi(bayGio.getTime() - luc.getTime())})` : null,
    };
  });
}
