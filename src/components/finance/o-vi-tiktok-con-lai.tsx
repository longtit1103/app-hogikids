import { formatVnd } from "@/lib/format";
import type { ViTiktokConLaiToiThieu } from "@/lib/vi-san/vi-tiktok-con-lai-toi-thieu";

/**
 * Ô nhỏ CHỈ ĐỌC "Còn ở ví TikTok" trong thẻ Quỹ — tiền sàn đã chốt mà chủ shop chưa rút về. Số
 * THÔNG TIN, KHÔNG nằm trong số quỹ (quỹ = tiền thật đã về tài khoản). Cận dưới tự suy — xem
 * `src/lib/vi-san/vi-tiktok-con-lai-toi-thieu.ts`.
 *
 * `null` (chưa có statement nào, hoặc đọc lỗi) ⇒ không render gì: in "0 ₫" là nói dối.
 */
export function OViTiktokConLai({ vi }: { vi: ViTiktokConLaiToiThieu | null }) {
  if (vi === null) return null;

  return (
    <div className="mt-3 rounded-xl bg-surface-card p-3" data-testid="o-vi-tiktok-con-lai">
      <p className="text-xs text-muted-foreground">Còn ở ví TikTok</p>
      {vi.viHienTai < 0 ? (
        // Không thể xảy ra theo cấu trúc công thức (B0 cận dưới luôn kéo chuỗi về ≥ 0) — nếu vẫn tới
        // đây thì dữ liệu đọc ra đã hỏng; in số âm là khiến chủ shop tin một con số sai.
        <p className="mt-1 text-xs text-amber-700">
          ⚠️ dữ liệu ví không khớp — kiểm lại đồng bộ TikTok
        </p>
      ) : (
        <>
          <p className="mt-1 font-serif text-xl text-ink">
            {formatVnd(vi.viHienTai)}{" "}
            <span className="font-sans text-xs text-muted-foreground">≈ tối thiểu</span>
          </p>
          {vi.tangTuD0 !== null && (
            <p className="mt-0.5 text-xs text-muted-foreground">
              {vi.tangTuD0 >= 0 ? "+" : ""}
              {formatVnd(vi.tangTuD0)} từ ngày mở sổ (đã chốt, chưa rút về quỹ)
            </p>
          )}
        </>
      )}
      <p className="mt-1 text-xs text-muted-foreground">
        Cận dưới: số dư ví trước 15/01/2026 không có trong dữ liệu; số thật trên Seller Center ≥ số
        này. Không cộng vào quỹ.
      </p>
    </div>
  );
}
