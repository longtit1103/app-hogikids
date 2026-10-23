import { RefreshCw } from "lucide-react";
import { formatNgayVn } from "@/lib/dinh-dang-ngay-gio-vn";

/** Banner đầu /don-hang: thời điểm sync Pancake gần nhất (hoặc cảnh báo chưa sync). */
export function SyncBanner({ lastSyncAt }: { lastSyncAt: Date | null }) {
  if (!lastSyncAt) {
    return (
      <div className="rounded-lg bg-warning/10 px-4 py-2 text-sm text-ink">
        Chưa đồng bộ lần nào — bấm «Đồng bộ ngay» trên thanh công cụ.
      </div>
    );
  }

  return (
    <p className="flex items-center gap-1.5 text-sm text-muted-foreground">
      <RefreshCw className="size-3.5" />
      Đồng bộ Pancake lúc {formatNgayVn(lastSyncAt, "dd/MM HH:mm")}
    </p>
  );
}
