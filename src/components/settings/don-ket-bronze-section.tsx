import { Badge } from "@/components/ui/badge";
import type { DonCanXem } from "@/lib/bronze/ket-cuc-silver";

/**
 * Khối "Đơn chưa vào Sổ" trong section Kết nối & Đồng bộ.
 *
 * Lý do tồn tại: một tiến trình chết giữa "land kho thô" và "ghi Sổ" để lại đơn kẹt mà mọi lượt
 * đồng bộ về sau vẫn xanh (lượt gửi lại trùng hash không tự chữa được). Lượt đối soát đêm nhặt
 * chúng, nhưng đơn có payload KHÔNG map được thì nó cố ý DỪNG thử lại — và đúng những đơn đó phải
 * hiện ở đây để chủ shop biết mà vào xử lý rồi dựng lại từ kho thô.
 *
 * Nguồn số liệu đọc THẲNG trạng thái từng dòng trong `RawPancakeOrder` (cột `silverOutcome`), nên
 * luôn phản ánh hiện tại và tự tắt khi hết — KHÔNG mượn một cờ toàn cục chỉ hạ được bằng nút bấm.
 */

const NHAN_KET_CUC: Record<string, string> = {
  FAILED_SHAPE: "Payload không map được",
  FAILED_RETRY_LIMIT: "Hỏng lặp lại — đã dừng thử lại",
};

/**
 * Hướng xử lý PHẢI theo từng kết cục, không gộp chung "sửa mapping".
 * - FAILED_SHAPE: payload sai khuôn ⇒ lỗi ở tầng map, sửa mapping mới chữa được.
 * - FAILED_RETRY_LIMIT: lỗi ghi RIÊNG DÒNG lặp lại qua đủ số lượt thử — KHÔNG phải sai khuôn
 *   payload, cũng KHÔNG phải lỗi hệ thống cả lô (Prisma P1xxx/P2003… bị `laLoiHeThong` ném cả lô,
 *   đi đường khác, không tới kết cục này). Nguyên nhân không nhìn ra từ khuôn payload; phải đọc
 *   ghi chú để lần.
 */
const HUONG_XU_LY: Record<string, string> = {
  FAILED_SHAPE: "sửa mapping rồi dựng lại từ kho thô",
  FAILED_RETRY_LIMIT: "xử lý nguyên nhân trong ghi chú rồi dựng lại từ kho thô",
};

function lucVN(d: Date): string {
  return d.toLocaleString("vi-VN", {
    timeZone: "Asia/Ho_Chi_Minh",
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function DonKetBronzeSection({
  pendingTotal,
  oldestPendingAt,
  tongCanXem,
  canXem,
  tenShop,
}: {
  /** Map shop id → tên hiển thị (từ cấu hình `Setting` — page dựng, rỗng khi chưa cấu hình). */
  tenShop: Record<string, string>;
  /** Số đơn đã land kho thô mà CHƯA dựng xong Sổ (chưa đóng dấu, đã quá hạn). Lượt đêm sẽ nhặt. */
  pendingTotal: number;
  /** Mốc tải về của đơn chưa dựng CŨ NHẤT — để biết việc đã treo bao lâu. */
  oldestPendingAt: Date | null;
  /**
   * TỔNG THẬT số đơn đã dừng thử lại tự động (đếm không LIMIT). Badge phải dùng số này, KHÔNG dùng
   * `canXem.length` — danh sách bị cắt còn `gioiHan` dòng nên đếm theo nó sẽ báo trần giả (vd 20/73).
   */
  tongCanXem: number;
  /** Danh sách (đã cắt) đơn dừng thử lại — mỗi dòng một việc cần vào xử lý rồi dựng lại. */
  canXem: DonCanXem[];
}) {
  const soHienThi = canXem.length;
  const biCat = soHienThi < tongCanXem;
  // Không có gì đang chờ VÀ không có gì cần xem ⇒ khối im lặng hẳn (đỡ nhiễu panel).
  if (pendingTotal === 0 && tongCanXem === 0) return null;

  return (
    <div className="flex flex-col gap-3 rounded-lg bg-surface-soft p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-medium text-ink">Đơn chưa vào Sổ</h3>
        {tongCanXem > 0 ? (
          <Badge variant="destructive">{tongCanXem} đơn cần xem</Badge>
        ) : (
          <span className="text-xs text-muted-foreground">
            Đang chờ lượt đối soát đêm
          </span>
        )}
      </div>

      {pendingTotal > 0 && (
        <p className="text-sm text-muted-foreground">
          {pendingTotal} đơn đã về kho thô mà chưa dựng xong Sổ
          {oldestPendingAt ? ` (cũ nhất từ ${lucVN(oldestPendingAt)})` : ""} —
          lượt đối soát đêm sẽ dựng nốt. Cần ngay thì chạy “Dựng lại từ kho
          thô”.
        </p>
      )}

      {tongCanXem > 0 && (
        <div className="flex flex-col gap-2 rounded-lg bg-error/10 p-3 text-sm">
          <p className="font-semibold text-error">
            Đơn không dựng được — kiểm tra nguyên nhân rồi dựng lại:
          </p>
          {canXem.map((d) => (
            <div
              key={`${d.shopId}-${d.externalId}`}
              className="flex flex-col text-error/90"
            >
              <span>
                {d.silverProcessedAt ? `${lucVN(d.silverProcessedAt)} · ` : ""}
                {tenShop[d.shopId] ?? d.shopId} · đơn {d.externalId} ·{" "}
                {NHAN_KET_CUC[d.silverOutcome] ?? d.silverOutcome} —{" "}
                {d.silverNote ?? "(không có ghi chú)"}
              </span>
              <span className="text-xs text-error/70">
                →{" "}
                {HUONG_XU_LY[d.silverOutcome] ??
                  "kiểm tra nguyên nhân rồi dựng lại từ kho thô"}
              </span>
            </div>
          ))}
          {biCat && (
            <p className="text-xs text-error/70">
              Hiển thị {soHienThi}/{tongCanXem} đơn mới nhất — tổng đầy đủ ở
              badge. Xử lý các đơn đang thấy rồi tải lại để xem phần còn lại.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
