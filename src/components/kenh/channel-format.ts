/**
 * Format helpers riêng cho các chỉ số /kenh không thuộc `formatVnd`/`formatVndShort`
 * (đã có ở `@/lib/format`) — dùng chung giữa `channel-card-grid.tsx` và
 * `channel-compare-table.tsx` để không lặp code format.
 */

/** "6,5%" — 1 chữ số thập phân kiểu Việt (dấu phẩy). Dùng cho Hoàn/Bom, Tỷ suất LN. */
export function formatPct1(n: number): string {
  return `${n.toFixed(1).replace(".", ",")}%`;
}

/** "3,2x" — ROAS 1 chữ số thập phân kiểu Việt + hậu tố "x". */
export function formatRoas(n: number): string {
  return `${n.toFixed(1).replace(".", ",")}x`;
}

/** "Phí sàn 6,5%" — số nguyên bỏ thập phân, số lẻ 1 chữ số kiểu Việt (dấu phẩy). */
export function feeBadgeLabel(pct: number): string {
  const rounded = Number.isInteger(pct) ? String(pct) : pct.toFixed(1).replace(".", ",");
  return `Phí sàn ${rounded}%`;
}
