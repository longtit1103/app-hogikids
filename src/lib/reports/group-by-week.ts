/**
 * Gộp chuỗi điểm THEO NGÀY thành bucket 7-ngày cho biểu đồ kỳ dài — cộng dồn
 * các khoá số, giữ nguyên các field còn lại của điểm đầu bucket (nhãn ngày…).
 *
 * Module RIÊNG, THUẦN (không import gì): các chart Client Component
 * (`channel-revenue-ads-chart.tsx`, `channel-trend-chart.tsx`) gọi trực tiếp —
 * đặt trong `daily-series.ts` là kéo cả `@/lib/prisma` + `pnl.ts` vào browser
 * bundle của /kenh (cùng lý do `pnl-percent-base.ts` tách khỏi `pnl.ts`).
 */
export function groupByWeek<T extends { date: string }>(points: T[], sumKeys: (keyof T)[]): T[] {
  const weeks: T[] = [];
  for (let i = 0; i < points.length; i += 7) {
    const bucket = points.slice(i, i + 7);
    const merged = { ...bucket[0] };
    for (const key of sumKeys) {
      merged[key] = bucket.reduce((acc, p) => acc + (p[key] as number), 0) as T[keyof T];
    }
    weeks.push(merged);
  }
  return weeks;
}
