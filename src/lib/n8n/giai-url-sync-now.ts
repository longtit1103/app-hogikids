import { SYNC_NOW_WEBHOOK_PATH } from "@/lib/n8n/provision/doc-goi-workflow-tu-repo";
import { prisma } from "@/lib/prisma";

/**
 * MỘT nguồn giải URL webhook "Đồng bộ ngay" cho CẢ nút bấm (`triggerSyncNow`) lẫn badge trạng
 * thái ở /cai-dat — hai nơi tự suy riêng thì badge nói "Chưa cấu hình" trong khi nút chạy được
 * (hoặc ngược lại). Ưu tiên env `N8N_SYNC_WEBHOOK_URL` (override tường minh của người vận hành);
 * không có thì ghép `Setting.n8nBaseUrl` + path đọc từ chính JSON workflow.
 *
 * Giá trị từ Setting phải qua kiểm protocol http/https TRƯỚC khi ai đó fetch nó: kho khoá sửa
 * được bằng tay/qua bản phục hồi — một chuỗi rác không được thành đích fetch kèm secret.
 */
export type NguonSyncNow = "env" | "setting";

export async function giaiUrlSyncNow(): Promise<{ url: string; nguon: NguonSyncNow } | null> {
  const tuEnv = (process.env.N8N_SYNC_WEBHOOK_URL ?? "").trim();
  if (tuEnv) return { url: tuEnv, nguon: "env" };

  const row = await prisma.setting.findUnique({ where: { key: "n8nBaseUrl" } });
  const base = row?.value.trim().replace(/\/+$/, "") ?? "";
  if (!base) return null;
  try {
    const u = new URL(base);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  } catch {
    return null;
  }
  return { url: `${base}/webhook/${SYNC_NOW_WEBHOOK_PATH}`, nguon: "setting" };
}
