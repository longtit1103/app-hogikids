import { eachDayOfInterval, endOfDay, format, startOfDay } from "date-fns";

import type { DateRange } from "@/lib/date-range";

/**
 * Ba phép dùng chung của mọi reader Marketing đọc SỐ SÀN theo chuỗi ngày. Để ở một chỗ vì cả ba
 * đều là chỗ dễ trôi khác nhau giữa các file: một reader cộng-bỏ-qua-null còn reader kia
 * cộng-lan-null thì hai bảng cạnh nhau trên cùng màn hình sẽ nói hai chuyện khác nhau về cùng một kỳ.
 */

/**
 * Danh sách ngày (giờ VN, khuôn YYYY-MM-DD) của kỳ — đúng tập ngày mà reader phải soi xem Bronze
 * có số hay không. Đi qua date-fns theo giờ ĐỊA PHƯƠNG (app neo Asia/Ho_Chi_Minh, bất biến #3),
 * KHÔNG dùng toISOString (UTC) — mốc 00:00+07 sẽ lùi thành ngày hôm trước.
 */
export function ngayTrongKy(range: DateRange): string[] {
  return eachDayOfInterval({ start: startOfDay(range.from), end: endOfDay(range.to) }).map((d) =>
    format(d, "yyyy-MM-dd"),
  );
}

/**
 * Cộng LAN NULL: một ngày đọc không ra số thì tổng của kỳ là "không biết", không phải "cộng phần
 * đọc được". Cộng thiếu ra một con số trông hợp lý mà sai — đúng lớp lỗi không ai phát hiện.
 */
export function cong(a: number | null, b: number | null): number | null {
  return a === null || b === null ? null : a + b;
}

/** Chia an toàn: mẫu 0 hoặc thiếu vế thì null, KHÔNG trả 0 (0 đọc ra là "đo được và bằng 0"). */
export function chia(tu: number | null, mau: number | null, heSo = 1): number | null {
  if (tu === null || mau === null || mau === 0) return null;
  return (tu / mau) * heSo;
}

/** Truy một khoá lồng nhau trong payload jsonb đã ra JS. Không phải object ⇒ undefined. */
export function khoi(payload: unknown, ...duong: string[]): Record<string, unknown> | undefined {
  let cur: unknown = payload;
  for (const k of duong) {
    if (typeof cur !== "object" || cur === null) return undefined;
    cur = (cur as Record<string, unknown>)[k];
  }
  return typeof cur === "object" && cur !== null ? (cur as Record<string, unknown>) : undefined;
}
