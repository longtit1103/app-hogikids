import { format, parse } from "date-fns";

/** `MonthlyTrendRow.month` ("yyyy-MM") → nhãn hiển thị "MM/yyyy". Dùng chung bởi trend-tab/trend-chart/export. */
export function monthLabel(monthStr: string): string {
  const d = parse(monthStr, "yyyy-MM", new Date());
  return format(d, "MM/yyyy");
}
