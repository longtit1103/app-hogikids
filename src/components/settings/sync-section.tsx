import type { SyncLog } from "@prisma/client";

import { Badge } from "@/components/ui/badge";
import { hasBronzeBacklog } from "@/lib/bronze/bronze-only";
import { giaiUrlSyncNow } from "@/lib/n8n/giai-url-sync-now";
import { ERROR_WINDOW_HOURS, getRecentDataErrorKinds } from "@/lib/queries/sync-health";
import { KIND_LABEL, SyncLogTable } from "./sync-log-table";

/** Che secret: KHÔNG BAO GIỜ trả full giá trị — chỉ 4 ký tự cuối. */
function maskIngestSecret(secret: string | undefined): string {
  if (!secret) return "Chưa cấu hình";
  return `••••${secret.slice(-4)}`;
}

/**
 * Section 5 "Kết nối & Đồng bộ": khối endpoint n8n (secret CHE, không bao giờ
 * xuống client dạng đầy đủ) + bảng 10 SyncLog gần nhất (đã fetch ở `page.tsx`,
 * KHÔNG refetch, xem `sync-log-table.tsx`) + banner backlog Bronze (dính) +
 * cảnh báo kind có lỗi trong cửa sổ gần đây.
 *
 * Cảnh báo theo kind dùng CÙNG nguồn với banner toàn app (`getRecentDataErrorKinds`) — cố ý, để
 * hai chỗ không bao giờ nói ngược nhau. Nghĩa là BACKUP KHÔNG xuất hiện ở đây: thẻ "Sao lưu" ở
 * section Dữ liệu ngay bên dưới sở hữu trọn cảnh báo sao lưu (nó đọc dòng BACKUP MỚI NHẤT nên
 * nói đúng trạng thái hiện tại, còn câu "thường do token hết hạn / kiểm credentials n8n" dưới đây
 * vốn sai với backup — backup chạy `pg_dump` trên host, không qua n8n).
 *
 * Bảng nhật ký cuối section KHÔNG phải chỗ dựa cho tín hiệu đó: nó chỉ giữ 10 dòng mới nhất của
 * mọi kind, mà mỗi đêm sinh hơn 400 dòng ⇒ dòng backup lỗi trôi mất trong chưa tới 24h. Nơi giữ
 * tín hiệu bền là thẻ "Sao lưu" + nhánh riêng của banner toàn app (xem `NON_DATA_SYNC_KINDS`).
 */
export async function SyncSection({ syncLogs }: { syncLogs: SyncLog[] }) {
  const [errorKinds, bronzeBacklog] = await Promise.all([
    getRecentDataErrorKinds(),
    hasBronzeBacklog(),
  ]);

  const appUrl = process.env.NEXT_PUBLIC_APP_URL;
  const pancakeEndpoint = appUrl ? `${appUrl}/api/ingest/raw` : "/api/ingest/raw";
  const adsEndpoint = appUrl ? `${appUrl}/api/ingest/ads` : "/api/ingest/ads";
  const maskedSecret = maskIngestSecret(process.env.INGEST_SECRET);
  // CÙNG nguồn giải URL với nút "Đồng bộ ngay" — badge tự soi env riêng thì nói "Chưa cấu hình"
  // trong khi nút chạy được bằng Setting.n8nBaseUrl (bản clone không đặt env override).
  const syncNow = await giaiUrlSyncNow();

  return (
    <div className="flex flex-col gap-5">
      {/*
        Cảnh báo DÍNH: còn backlog Bronze ⇒ Silver đang tụt lại (dòng đã land ở chế
        độ chỉ-land KHÔNG tự lên Silver vì dedupe theo hash). Đây là kịch bản mất số
        ÂM THẦM mà CLAUDE.md sợ nhất — banner đỏ đậm, dính, không cho trôi.
        Cờ này bật được từ NHIỀU nguồn, không chỉ đơn hàng: cổng đối soát soi cả
        3 stream tiền-đã-về (statement/payment TikTok + ví Shopee) — settlement độc
        lập P&L (bất biến #7) nên chữ phải nêu cả hai, khẳng định riêng "doanh thu"
        là nói sai trong đúng ca đó.
        Chữ phải khớp HÀNH VI THẬT: nút "Dựng lại từ kho thô" TẮT được cảnh báo này,
        nhưng chỉ khi lượt chạy sạch hoàn toàn — còn record kẹt, còn sản phẩm chưa lên
        Silver, hoặc cờ vừa bật lại giữa chừng thì nó giữ cờ và nói rõ lý do trong
        cảnh báo của lượt (xem `dungLaiGiaoDichTuKhoTho`). Nên chữ ở đây KHÔNG hứa
        "bấm là tắt", mà nêu cả đường chắc chắn nhất là lệnh trên minipc.
      */}
      {bronzeBacklog && (
        <div className="sticky top-2 z-10 flex flex-col gap-1 rounded-lg border border-error bg-error p-3 text-sm text-white shadow-sm">
          <p className="font-semibold">
            Bronze còn backlog — Silver CHƯA đuổi kịp, số liệu có thể thiếu (doanh thu hoặc &quot;Tiền đã về&quot;).
          </p>
          <p className="text-white/90">
            Do đợt chỉ-Bronze chưa dựng lại, hoặc có dòng land xong mà không lên được Silver. Bấm &quot;Dựng lại từ
            kho thô&quot; ở mục Dữ liệu — chạy sạch thì cảnh báo này tự tắt; còn kẹt thì lượt đó nói rõ vướng ở đâu.
            Vướng phần sản phẩm/tồn kho thì chạy{" "}
            <code className="font-mono">npx tsx scripts/rebuild-from-raw.ts</code> trên minipc (dựng nốt phần sản
            phẩm) — xong rồi hãy tin số P&amp;L.
          </p>
        </div>
      )}

      {errorKinds.length > 0 && (
        <div className="flex flex-col gap-1 rounded-lg bg-error/10 p-3 text-sm text-error">
          {errorKinds.map((kind) => (
            <p key={kind}>
              Đồng bộ {KIND_LABEL[kind]} có lỗi trong {ERROR_WINDOW_HOURS} giờ gần đây — thường do token hết hạn.
              Kiểm tra credentials trong n8n và xem log bên dưới.
            </p>
          ))}
        </div>
      )}

      <div className="flex flex-col gap-3 rounded-lg bg-surface-soft p-4">
        <h3 className="text-sm font-medium text-ink">Kết nối n8n</h3>

        <div className="flex flex-col gap-1">
          <code className="w-fit rounded bg-surface-card px-2 py-1 font-mono text-xs text-ink">
            POST {pancakeEndpoint}
          </code>
          <code className="w-fit rounded bg-surface-card px-2 py-1 font-mono text-xs text-ink">
            POST {adsEndpoint}
          </code>
        </div>

        <p className="text-xs text-muted-foreground">
          Header: <code className="font-mono">Authorization: Bearer {maskedSecret}</code> — giá trị thật lưu trong{" "}
          <code className="font-mono">.env</code> trên minipc.
        </p>

        <div className="flex items-center gap-2 text-sm">
          <span className="text-ink">Webhook &quot;Đồng bộ ngay&quot;:</span>
          {syncNow ? (
            <Badge className="bg-success/15 text-success">
              {syncNow.nguon === "env" ? "Đã cấu hình (env override)" : "Đã cấu hình (Kết nối n8n)"}
            </Badge>
          ) : (
            <Badge className="bg-warning/15 text-warning">Chưa cấu hình — điền n8n URL ở khối Kết nối n8n</Badge>
          )}
        </div>
      </div>

      {syncLogs.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          Chưa có lần đồng bộ nào. Import workflows trong <code className="font-mono">n8n/</code> và bấm Đồng bộ
          ngay.
        </p>
      ) : (
        <SyncLogTable logs={syncLogs} />
      )}
    </div>
  );
}
