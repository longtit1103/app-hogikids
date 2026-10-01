import { LinkNeuDuocVao } from "@/components/dashboard/link-neu-duoc-vao";
import { coTheVaoHref } from "@/components/shell/nav-config";
import { SyncNowButton } from "@/components/shell/sync-now-button";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const STEPS = [
  "Cấu hình n8n kết nối Pancake POS (mục Cài đặt → Kết nối)",
  "Bấm «Đồng bộ ngay» để kéo dữ liệu lần đầu",
  "Quay lại đây — Dashboard sẽ tự có số liệu",
];

/**
 * Trạng thái lần đầu mở app: chưa có SyncLog PANCAKE nào VÀ chưa có Order nào
 * (`page.tsx` guard). Thay toàn bộ nội dung Dashboard bằng onboarding 3 bước. `choPhepDongBo` =
 * `cai-dat:sua` (server tính) — thiếu thì không nút đồng bộ.
 */
export function ChuaSyncEmptyState({
  choPhepDongBo = false,
  hrefDuocPhep = [],
}: { choPhepDongBo?: boolean; hrefDuocPhep?: readonly string[] } = {}) {
  return (
    <div className="flex flex-col items-center gap-6 rounded-xl border border-hairline bg-canvas px-6 py-16 text-center">
      <h1 className="font-serif text-2xl text-ink">Chưa có dữ liệu từ Pancake</h1>
      <p className="max-w-md text-sm text-muted-foreground">
        App lấy đơn hàng, sản phẩm và giá vốn qua đồng bộ tự động từ Pancake POS — hãy thực hiện 3 bước sau để bắt đầu.
      </p>

      <ol className="flex w-full max-w-md flex-col gap-3 text-left">
        {STEPS.map((step, i) => (
          <li key={step} className="flex items-start gap-3 text-sm text-ink">
            <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-surface-card font-serif text-xs">
              {i + 1}
            </span>
            {step}
          </li>
        ))}
      </ol>

      <div className="flex items-center gap-4">
        {/* Nút chỉ dựng khi vào được /cai-dat — người không có quyền thấy 3 bước hướng dẫn, không thấy link gãy. */}
        {coTheVaoHref(hrefDuocPhep, "/cai-dat") && (
          <LinkNeuDuocVao href="/cai-dat" hrefDuocPhep={hrefDuocPhep} className={cn(buttonVariants({ size: "lg" }))}>
            Cấu hình kết nối n8n
          </LinkNeuDuocVao>
        )}
        <SyncNowButton choPhepDongBo={choPhepDongBo} />
      </div>
    </div>
  );
}
