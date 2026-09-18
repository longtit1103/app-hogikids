import { format } from "date-fns";
import type { SyncKind, SyncLog, SyncStatus } from "@prisma/client";

import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

export const KIND_LABEL: Record<SyncKind, string> = {
  PANCAKE: "Pancake POS",
  META_ADS: "Meta Ads",
  TIKTOK_ADS: "TikTok Ads",
  // Luồng PHÍ/ĐỐI SOÁT (TikTok Shop Open API) — KHÔNG phải doanh thu, KHÔNG phải ads.
  TIKTOK_SHOP: "TikTok Shop (phí/đối soát)",
  // Nhãn phải KHÁC HẲN dòng trên: hai luồng này đứng cạnh nhau trên cùng màn hình, đọc nhầm là
  // tưởng luồng tiền vẫn xanh trong khi chỉ có lượt chỉ số marketing chạy được.
  TIKTOK_SHOP_ANALYTICS: "TikTok Shop (chỉ số marketing)",
  BACKUP: "Sao lưu",
};

// stats Json = {...result, warnings} (PANCAKE/ads đi qua withSyncLog) hoặc
// {file, sizeBytes, drivePath} (BACKUP ghi thẳng, không warnings) — chỉ hiện
// khoá đã biết, bỏ qua khoá lạ (không tin cấu trúc Json tuỳ ý).
const STAT_LABEL: Record<string, string> = {
  landed: "dòng raw",
  ordersUpserted: "đơn",
  productsUpserted: "SP",
  variantsUpserted: "SKU",
  rowsUpserted: "dòng",
  adRows: "dòng ads",
};

function formatStats(stats: unknown): string {
  if (!stats || typeof stats !== "object") return "—";
  const s = stats as Record<string, unknown>;
  const parts: string[] = [];

  for (const key of Object.keys(STAT_LABEL)) {
    const v = s[key];
    if (typeof v === "number") parts.push(`${v} ${STAT_LABEL[key]}`);
  }
  // Chế độ chỉ-land: người xem PHẢI thấy vì sao đơn không tăng, nếu không sẽ tưởng đồng bộ hỏng.
  if (s.mode === "bronze-only") parts.push("chỉ Bronze — chưa dựng Silver");
  if (typeof s.file === "string") parts.push(s.file);
  // Mã trạng thái LẠ → đơn bị loại như CANCELLED, có thể mất doanh thu → HIỆN NỔI BẬT (không chìm
  // trong "N cảnh báo"). Nội dung cảnh báo chi tiết xem qua <SyncWarnings/>.
  if (typeof s.unknownStatusOrders === "number" && s.unknownStatusOrders > 0) {
    parts.push(`⚠️ ${s.unknownStatusOrders} đơn mã trạng thái lạ`);
  }

  return parts.length > 0 ? parts.join(" · ") : "—";
}

/** Lấy mảng warnings từ stats Json (không tin cấu trúc tuỳ ý). */
function getWarnings(stats: unknown): string[] {
  if (!stats || typeof stats !== "object") return [];
  const w = (stats as Record<string, unknown>).warnings;
  return Array.isArray(w) ? w.filter((x): x is string => typeof x === "string") : [];
}

/** Cho XEM nội dung cảnh báo (trước đây chỉ đếm "N cảnh báo" → không đọc được). */
function SyncWarnings({ stats }: { stats: unknown }) {
  const warnings = getWarnings(stats);
  if (warnings.length === 0) return null;
  return (
    <details className="mt-1">
      <summary className="cursor-pointer text-xs text-amber-700">{warnings.length} cảnh báo</summary>
      <ul className="mt-1 list-disc space-y-0.5 pl-4 text-xs text-muted-foreground">
        {warnings.map((w, i) => (
          <li key={i} className="whitespace-pre-wrap break-words">
            {w}
          </li>
        ))}
      </ul>
    </details>
  );
}

function StatusBadge({ status }: { status: SyncStatus }) {
  if (status === "OK") return <Badge className="bg-success/15 text-success">OK</Badge>;
  if (status === "ERROR") return <Badge className="bg-error/15 text-error">Lỗi</Badge>;
  return <Badge className="bg-surface-soft text-ink">Đang chạy</Badge>;
}

function formatWhen(startedAt: Date, finishedAt: Date | null): string {
  const start = format(startedAt, "dd/MM HH:mm");
  const end = finishedAt ? format(finishedAt, "dd/MM HH:mm") : "—";
  return `${start} → ${end}`;
}

function ErrorDetails({ log }: { log: SyncLog }) {
  if (log.status !== "ERROR" || !log.error) return <span className="text-muted-foreground">—</span>;
  return (
    <details>
      <summary className="cursor-pointer text-error">Xem lỗi</summary>
      <p className="mt-1 whitespace-pre-wrap break-words text-xs text-muted-foreground">{log.error}</p>
    </details>
  );
}

/**
 * Bảng SyncLog gần nhất: desktop = `<table>`, mobile (<768px) = card dọc —
 * cùng pattern responsive với `channel-orders-tab.tsx`. Tách khỏi
 * `sync-section.tsx` để giữ file đó dưới 200 dòng (khối kết nối n8n + banner
 * lỗi liên tiếp).
 */
export function SyncLogTable({ logs }: { logs: SyncLog[] }) {
  return (
    <div className="rounded-xl border border-hairline">
      {/* Desktop: bảng */}
      <Table className="hidden md:table">
        <TableHeader>
          <TableRow>
            <TableHead>Nguồn</TableHead>
            <TableHead>Trạng thái</TableHead>
            <TableHead>Thời gian</TableHead>
            <TableHead>Kết quả</TableHead>
            <TableHead>Lỗi</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {logs.map((log) => (
            <TableRow key={log.id}>
              <TableCell className="text-sm text-ink">{KIND_LABEL[log.kind]}</TableCell>
              <TableCell>
                <StatusBadge status={log.status} />
              </TableCell>
              <TableCell className="text-sm text-muted-foreground">
                {formatWhen(log.startedAt, log.finishedAt)}
              </TableCell>
              <TableCell className="text-sm text-muted-foreground">
                {formatStats(log.stats)}
                <SyncWarnings stats={log.stats} />
              </TableCell>
              <TableCell className="max-w-xs text-sm">
                <ErrorDetails log={log} />
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>

      {/* Mobile: card dọc */}
      <div className="flex flex-col gap-2 p-3 md:hidden">
        {logs.map((log) => (
          <div key={log.id} className="flex flex-col gap-1 rounded-lg border border-hairline p-3">
            <div className="flex items-center justify-between">
              <span className="text-sm text-ink">{KIND_LABEL[log.kind]}</span>
              <StatusBadge status={log.status} />
            </div>
            <div className="text-xs text-muted-foreground">{formatWhen(log.startedAt, log.finishedAt)}</div>
            <div className="text-xs text-muted-foreground">{formatStats(log.stats)}</div>
            <SyncWarnings stats={log.stats} />
            {log.status === "ERROR" && log.error && (
              <details>
                <summary className="cursor-pointer text-xs text-error">Xem lỗi</summary>
                <p className="mt-1 whitespace-pre-wrap break-words text-xs text-muted-foreground">{log.error}</p>
              </details>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
