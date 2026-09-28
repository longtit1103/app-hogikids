import { chanRouteKhiDangPhucHoi } from "@/lib/backup/khoa-bao-tri";
import { isBronzeOnly } from "@/lib/bronze/bronze-only";
import { doiSoatDonConDo } from "@/lib/bronze/doi-soat-don-con-do";
import { requireIngestSecret } from "@/lib/ingest/ingest-auth";
import { withSyncLog } from "@/lib/ingest/sync-log";

/**
 * POST /api/ingest/reconcile-orders — nhặt các đơn đã nằm trong kho thô mà chưa dựng xong Sổ.
 * Gọi ở CUỐI lượt nightly, ngay sau `resync-products`.
 *
 * VÌ SAO CẦN, khi đã có dấu kết cục theo từng dòng: dấu chỉ giúp lượt gửi lại tự chữa — nó cần một
 * lượt gửi lại để bám vào. Đơn "yên vị" (đã giao xong / đã hoàn) thì Pancake không gửi lại nữa, và
 * đó đúng là lớp đơn mang doanh thu đã chốt. Không có lượt chủ động đi nhặt thì chúng nằm ngoài Sổ
 * vĩnh viễn trong khi mọi lượt đồng bộ vẫn xanh.
 *
 * KHÔNG phải lượt dựng lại toàn bộ: chỉ upsert đúng đơn còn dở, không đụng sản phẩm/tồn kho, không
 * xoá gì. Chi tiết ranh giới ở `doi-soat-don-con-do.ts`.
 *
 * HỢP ĐỒNG MÃ TRẢ VỀ — mã HTTP nói "phép đối soát có chạy được không", KHÔNG nói "dữ liệu có sạch
 * không". Tình trạng dữ liệu nằm ở `status` trong thân trả về:
 *   200 — đối soát ĐÃ chạy xong, kể cả khi còn `pending` hoặc `needs_attention`.
 *   500 — KHÔNG hoàn thành được phép đối soát đáng tin cậy (lỗi hệ thống / cả lô).
 *   503 — đang bảo trì / phục hồi.
 * Vì sao không trả 500 khi còn đơn kẹt: đơn kẹt là một TRẠNG THÁI kéo dài nhiều đêm, mà 500 thì
 * n8n hiểu là "thử lại đi" — thành ra lượt sau chạy chồng lượt trước trên đúng tập đang hỏng. Còn
 * cảnh báo thì đã có `status` + panel đọc thẳng trạng thái từng dòng, luôn phản ánh hiện tại và tự
 * tắt khi hết, khác hẳn một cờ toàn cục chỉ hạ được bằng nút bấm tay.
 */
export async function POST(req: Request): Promise<Response> {
  const unauthorized = requireIngestSecret(req);
  if (unauthorized) return unauthorized;

  const dangPhucHoi = chanRouteKhiDangPhucHoi();
  if (dangPhucHoi) return dangPhucHoi;

  return withSyncLog("PANCAKE", async (warnings) => {
    // Công tắc chỉ-land đang bật = "Sổ đứng yên, chờ dựng lại". Dựng lúc này là lách chính công tắc
    // mình vừa bật. Không mất gì: dòng vẫn ở "chưa xong", lượt sau nhặt lại.
    if (isBronzeOnly()) {
      warnings.push("BRONZE_ONLY: bỏ qua lượt đối soát đơn (Sổ đang cố ý đứng yên)");
      return { status: "skipped" as const, mode: "bronze-only" as const };
    }

    return doiSoatDonConDo(warnings);
  });
}
