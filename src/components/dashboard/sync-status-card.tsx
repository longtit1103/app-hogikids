import Link from "next/link";
import { formatDistanceToNow } from "date-fns";
import { vi } from "date-fns/locale";

import { Badge } from "@/components/ui/badge";
import { SyncNowButton } from "@/components/shell/sync-now-button";

import type { SyncKind, SyncStatus } from "@prisma/client";

export type SyncStatusRow = {
  kind: SyncKind;
  log: { status: SyncStatus; startedAt: Date; finishedAt: Date | null; error: string | null } | null;
};

const KIND_LABEL: Record<SyncKind, string> = {
  PANCAKE: "Pancake POS",
  META_ADS: "Meta Ads",
  TIKTOK_ADS: "TikTok Ads",
  TIKTOK_SHOP: "TikTok Shop (phí/đối soát)",
  TIKTOK_SHOP_ANALYTICS: "TikTok Shop (chỉ số marketing)",
  BACKUP: "Sao lưu",
};

// Cùng bộ tone với `order-status-badge.tsx` (neutral = bg-surface-soft text-ink)
// để badge trạng thái nhất quán toàn app.
function StatusBadge({ log }: { log: SyncStatusRow["log"] }) {
  if (!log) {
    return <Badge className="bg-surface-soft text-muted-foreground">Chưa chạy</Badge>;
  }
  if (log.status === "OK") {
    return <Badge className="bg-success/15 text-success">OK</Badge>;
  }
  if (log.status === "ERROR") {
    return (
      <Badge className="bg-error/15 text-error" title={log.error ?? undefined}>
        Lỗi
      </Badge>
    );
  }
  return <Badge className="bg-surface-soft text-ink">Đang chạy</Badge>;
}

/**
 * THAY card "Đơn chờ xử lý" (design spec pre-pivot) — Task 4 brief: dashboard
 * lớp P&L quan tâm "dữ liệu đã đồng bộ chưa" hơn là vận hành đơn (Pancake POS
 * giữ toàn bộ vận hành). Mỗi kind lấy SyncLog gần nhất (`page.tsx` fetch sẵn).
 */
export function SyncStatusCard({ rows }: { rows: SyncStatusRow[] }) {
  return (
    <div className="rounded-xl bg-surface-card p-4">
      <h3 className="font-serif text-lg text-ink">Tình trạng đồng bộ</h3>

      <div className="mt-3 flex flex-col gap-2">
        {rows.map(({ kind, log }) => {
          const when = log?.finishedAt ?? log?.startedAt;
          return (
            <div key={kind} className="flex items-center justify-between gap-2 text-sm">
              <span className="text-ink">{KIND_LABEL[kind]}</span>
              <span className="flex items-center gap-2">
                <span className="text-xs text-muted-foreground">
                  {when ? formatDistanceToNow(when, { addSuffix: true, locale: vi }) : "—"}
                </span>
                <StatusBadge log={log} />
              </span>
            </div>
          );
        })}
      </div>

      <div className="mt-4 flex items-center justify-between gap-2 border-t border-hairline pt-3">
        <SyncNowButton />
        <Link href="/cai-dat" className="text-xs text-primary hover:underline">
          Cài đặt kết nối
        </Link>
      </div>
    </div>
  );
}
