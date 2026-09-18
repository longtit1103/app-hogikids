import { chanRouteKhiDangPhucHoi } from "@/lib/backup/khoa-bao-tri";
import { capNhatSoLechGiaVon } from "@/lib/gia-von/cap-nhat-so-lech";
import { requireIngestSecret } from "@/lib/ingest/ingest-auth";
import { withSyncLog } from "@/lib/ingest/sync-log";

/**
 * POST /api/ingest/dem-gia-von — đếm lại số biến thể lệch giá vốn với Pancake, chốt vào `Setting`.
 *
 * VÌ SAO TÁCH RIÊNG khỏi `resync-products` (thêm 2026-09-07, ngay sau khi tính năng lên prod):
 * bước đếm đang nằm ở CUỐI lượt đêm, còn nút "Đồng bộ ngay" chạy workflow khác (`pancake-sync-now`,
 * chỉ kéo 3 luồng nhẹ rồi dừng). Hệ quả: chủ shop nhập hàng xong bấm "Đồng bộ ngay", giá vốn mới ĐÃ
 * về app nhưng dải nhắc việc vẫn im tới 03:00 hôm sau — bấm mà không thấy gì nhúc nhích thì tưởng
 * nút không ăn. Đúng loại "hỏng lặng" mà cả tính năng này sinh ra để chống.
 *
 * KHÔNG gọi thẳng `resync-products` từ workflow đó: endpoint kia còn dựng lại TOÀN BỘ tồn kho và có
 * chốt chặn riêng ("lượt kéo products shop kho phải còn sống trong 2 giờ") — kéo nguyên khối đó vào
 * một nút bấm tay là đổi hẳn ý nghĩa của nút, và thêm một đường ghi tồn không ai yêu cầu.
 *
 * Endpoint này CHỈ ĐỌC Bronze + ghi 2 ô cấu hình. KHÔNG chạm `Variant`, KHÔNG chạm tiền.
 *
 * Lỗi thì trả lỗi THẬT (khác lượt đêm — bên đó nuốt vì vá tồn quan trọng hơn): ở đây đếm là việc
 * DUY NHẤT, nuốt lỗi thì endpoint thành cái vỏ luôn báo thành công.
 */
export async function POST(req: Request): Promise<Response> {
  const unauthorized = requireIngestSecret(req);
  if (unauthorized) return unauthorized;

  const dangPhucHoi = chanRouteKhiDangPhucHoi();
  if (dangPhucHoi) return dangPhucHoi;

  return withSyncLog("PANCAKE", async () => {
    const soLech = await capNhatSoLechGiaVon();
    return { mode: "dem-gia-von" as const, soLechGiaVon: soLech };
  });
}
