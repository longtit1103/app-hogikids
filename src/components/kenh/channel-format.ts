/**
 * Format helpers riêng cho các chỉ số /kenh không thuộc `formatVnd`/`formatVndShort`
 * (đã có ở `@/lib/format`) — dùng chung giữa `channel-card-grid.tsx` và
 * `channel-compare-table.tsx` để không lặp code format.
 */

import { formatPercent } from "@/lib/format";

/** "3,2x" — ROAS 1 chữ số thập phân kiểu Việt + hậu tố "x". */
export function formatRoas(n: number): string {
  return `${n.toFixed(1).replace(".", ",")}x`;
}

/** "Phí sàn 6,5%" — cùng kiểu tỷ lệ với toàn app (`formatPercent`: bỏ ",0" thừa, không hữu hạn thì "—"). */
export function feeBadgeLabel(pct: number): string {
  return `Phí sàn ${formatPercent(pct)}`;
}
