"use client";

import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import type { TrangThaiWebhookShop } from "@/lib/ket-noi/webhook-pancake-info";

/**
 * Khối webhook trong thẻ Pancake POS: không có khóa để điền — việc của chủ shop là dán ĐÚNG
 * URL vào Pancake của từng shop. Mốc "sự kiện gần nhất" cho biết webhook còn sống; đứt thì
 * tồn kho/trạng thái đơn hết realtime (lượt API đêm vẫn vét bù nên không mất dữ liệu).
 */
export function WebhookPancakePanel({ danhSach }: { danhSach: TrangThaiWebhookShop[] }) {
  async function copy(url: string) {
    try {
      await navigator.clipboard.writeText(url);
      toast.success("Đã copy URL webhook");
    } catch {
      toast.error("Không copy được — chọn và copy tay giúp");
    }
  }

  return (
    <div className="flex flex-col gap-2 rounded-lg bg-muted/50 p-3">
      <p className="text-sm font-medium text-ink">Webhook (sự kiện realtime từ Pancake)</p>
      <div className="flex flex-col gap-2">
        {danhSach.map((w) => (
          <div key={w.url} className="flex flex-col gap-0.5">
            <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-0.5">
              <span className="text-xs font-medium text-ink">{w.ten}</span>
              <span className="text-xs text-muted-foreground">
                {w.ganNhat ? `Sự kiện gần nhất: ${w.ganNhat}` : "Chưa từng nhận sự kiện"}
              </span>
            </div>
            <div className="flex items-center gap-2">
              <code className="min-w-0 flex-1 truncate rounded bg-background px-2 py-1 text-xs text-muted-foreground">
                {w.url}
              </code>
              <Button type="button" variant="outline" size="xs" className="shrink-0" onClick={() => copy(w.url)}>
                Copy
              </Button>
            </div>
          </div>
        ))}
      </div>
      <p className="text-xs text-muted-foreground">
        Khi cần cấu hình lại: vào Pancake của ĐÚNG shop → Cấu hình → Nâng cao → Kết nối bên thứ 3 → Webhook, dán URL
        trên và bật đủ 4 loại sự kiện (đơn hàng, khách hàng, sản phẩm, tồn kho). Không có khóa nào phải điền ở đây.
      </p>
    </div>
  );
}
