import { lyDoTuChoiDichN8n } from "@/lib/n8n/kiem-dich-den-n8n";
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
  // Env là override tường minh của người vận hành nên KHÔNG kiểm dải — nhưng vẫn gác denylist
  // link-local/metadata, vì đó là đích không bao giờ hợp lệ dù ai đặt.
  if (tuEnv) {
    const lyDo = lyDoTuChoiDichN8n(tuEnv);
    // ⚠️ Caller dịch `null` thành "Chưa cấu hình kết nối n8n — điền n8n URL ở Cài đặt", tức NÓI SAI
    // lý do cho ca này: người vận hành sẽ đi mò trong `/cai-dat` trong khi lỗi nằm ở `.env`. Chưa
    // tách được lý do lên UI (đổi hợp đồng trả về đụng cả badge trạng thái) nên tối thiểu phải để
    // lại một dòng ở log máy chủ, đừng im lặng.
    if (lyDo) {
      console.error(`[giaiUrlSyncNow] N8N_SYNC_WEBHOOK_URL bị từ chối: ${lyDo}`);
      return null;
    }
    return { url: tuEnv, nguon: "env" };
  }

  const row = await prisma.setting.findUnique({ where: { key: "n8nBaseUrl" } });
  const base = row?.value.trim().replace(/\/+$/, "") ?? "";
  if (!base) return null;
  const lyDoSetting = lyDoTuChoiDichN8n(base);
  if (lyDoSetting) {
    console.error(`[giaiUrlSyncNow] Setting.n8nBaseUrl bị từ chối: ${lyDoSetting}`);
    return null;
  }
  return { url: `${base}/webhook/${SYNC_NOW_WEBHOOK_PATH}`, nguon: "setting" };
}
