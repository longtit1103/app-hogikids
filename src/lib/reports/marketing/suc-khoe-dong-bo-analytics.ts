import { prisma } from "@/lib/prisma";

/**
 * BẰNG CHỨNG THẬT cho cổng ĐỘ TƯƠI của mục Marketing (ruling P2-R35, tách theo stream ở P2-R40) —
 * lượt `SyncLog` **OK** gần nhất của kind `TIKTOK_SHOP_ANALYTICS`, TÁCH RIÊNG cho từng
 * `tiktok/analytics_*` stream.
 *
 * Vì sao KHÔNG được gộp chung một mốc cho cả 4 stream: workflow đêm `tiktokshop-analytics-nightly`
 * gọi `POST /api/ingest/raw` NHIỀU LƯỢT — mỗi stream một lượt ⇒ mỗi lượt một dòng SyncLog riêng
 * (`withSyncLog` ghi `stats = {...result, warnings}`, route trả `{stream, shopId, landed, ...}` nên
 * `stats->>'stream'` giữ đúng tên stream của lượt đó). Nếu chỉ lấy MỘT dòng OK gần nhất chung cho cả
 * kind: `analytics_shop` OK trong khi `analytics_products` ERROR vẫn khiến cổng thấy "có lượt OK" ⇒
 * đổ lỗi cho SÀN đúng lúc APP đang hỏng riêng nhánh products — chệch đúng lớp lỗi ruling P2-R35 đã vá.
 *
 * `finishedAt` luôn được set khi `withSyncLog` ghi `status: "OK"` (xem `sync-log.ts`) — nullable ở
 * schema vì `RUNNING` chưa có, không phải vì OK có thể thiếu.
 *
 * SERVER-ONLY (đụng Prisma) — chỉ gọi từ `page.tsx`, KHÔNG import vào các component "use client"
 * (đó là lý do hàm quyết định câu chữ tách riêng ra `cau-do-tuoi-du-lieu.ts`, thuần TS không Prisma).
 */

/** Bốn stream `tiktok/analytics_*` — khớp NGUYÊN VĂN giá trị `stream` mà route ghi vào `stats`
 *  (xem `src/app/api/ingest/raw/route.ts` + `src/lib/bronze/streams.ts`), KHÔNG phải tên bảng Bronze. */
export type StreamAnalytics =
  | "tiktok/analytics_shop"
  | "tiktok/analytics_products"
  | "tiktok/analytics_videos"
  | "tiktok/analytics_lives";

export type LanChayOkTheoStream = Record<StreamAnalytics, Date | null>;

const CAC_STREAM_ANALYTICS: readonly StreamAnalytics[] = [
  "tiktok/analytics_shop",
  "tiktok/analytics_products",
  "tiktok/analytics_videos",
  "tiktok/analytics_lives",
];

/**
 * Lượt OK gần nhất của MỖI stream (`Prisma` không lọc sâu được trong cột `Json` nên dùng
 * `$queryRaw` đọc `stats->>'stream'`; hằng số CỐ ĐỊNH trong code, không nội suy biến ngoài vào SQL).
 * `DISTINCT ON (stats->>'stream')` + `ORDER BY ... "startedAt" DESC, id DESC` lấy đúng MỘT dòng mới
 * nhất mỗi stream — `id` chốt cuối cho ca trùng mili-giây (cùng lý do các reader khác trong thư mục
 * này chốt bằng `id DESC`).
 */
export async function lanChayOkGanNhatAnalyticsTheoStream(): Promise<LanChayOkTheoStream> {
  const rows = await prisma.$queryRaw<{ stream: string | null; finishedAt: Date | null }[]>`
    SELECT DISTINCT ON (stats->>'stream') stats->>'stream' AS stream, "finishedAt"
    FROM "SyncLog"
    WHERE kind = 'TIKTOK_SHOP_ANALYTICS' AND status = 'OK'
    ORDER BY stats->>'stream', "startedAt" DESC, id DESC
  `;

  const ket: LanChayOkTheoStream = {
    "tiktok/analytics_shop": null,
    "tiktok/analytics_products": null,
    "tiktok/analytics_videos": null,
    "tiktok/analytics_lives": null,
  };
  for (const r of rows) {
    if (r.stream !== null && (CAC_STREAM_ANALYTICS as readonly string[]).includes(r.stream)) {
      ket[r.stream as StreamAnalytics] = r.finishedAt;
    }
  }
  return ket;
}
