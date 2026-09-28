import { format, parse } from "date-fns";

/** `MonthlyTrendRow.month` ("yyyy-MM") → nhãn hiển thị "MM/yyyy". Dùng chung bởi trend-tab/trend-chart/export. */
export function monthLabel(monthStr: string): string {
  const d = parse(monthStr, "yyyy-MM", new Date());
  return format(d, "MM/yyyy");
}

/** "12,3%" — 1 chữ số thập phân, phẩy kiểu Việt. */
export function formatPct1(n: number): string {
  return `${n.toLocaleString("vi-VN", { maximumFractionDigits: 1 })}%`;
}
