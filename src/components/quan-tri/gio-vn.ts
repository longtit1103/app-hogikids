/** Định dạng thời điểm theo giờ Việt Nam (toàn app neo `Asia/Ho_Chi_Minh`), vd "30/09/2026 14:05". */
const DINH_DANG = new Intl.DateTimeFormat("vi-VN", {
  timeZone: "Asia/Ho_Chi_Minh",
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

export function formatGioVn(d: Date | string | null | undefined): string {
  if (!d) return "—";
  const date = d instanceof Date ? d : new Date(d);
  return Number.isNaN(date.getTime()) ? "—" : DINH_DANG.format(date);
}
