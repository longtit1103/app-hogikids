import {
  differenceInCalendarDays,
  endOfDay,
  endOfMonth,
  format,
  getDate,
  getDaysInMonth,
  isValid,
  parse,
  setDate,
  startOfDay,
  startOfMonth,
  subDays,
  subMonths,
} from "date-fns";

/**
 * A closed date interval [from, to] used by every report/list screen that
 * has the global date-range picker (Dashboard, Chi phí, Kênh, Báo cáo).
 *
 * The whole app anchors to Asia/Ho_Chi_Minh. In prod the container runs with
 * `TZ=Asia/Ho_Chi_Minh`, and dev is already UTC+7, so date-fns' local-time
 * boundary helpers (startOfDay/endOfDay/startOfMonth/endOfMonth) resolve to
 * the correct VN calendar boundaries without any manual offset math.
 */
export type DateRange = {
  from: Date;
  to: Date;
};

export type RangePreset = "today" | "yesterday" | "7d" | "30d" | "this_month" | "last_month";

/** Design spec cap for the custom range popover: "tối đa 366 ngày". */
export const MAX_RANGE_DAYS = 366;

const QUERY_DATE_FORMAT = "yyyy-MM-dd";

/** Khuôn cứng của `?tu=&den=` — chặn chuỗi thiếu chữ số mà date-fns vẫn nhận. */
const STRICT_QUERY_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Query param names for the global date-range picker: `?tu=&den=`. */
export type DateRangeQuery = { tu: string; den: string };

/**
 * Resolves a picker preset to a concrete [from, to] range, anchored on
 * `now` (defaults to the current instant, injectable for tests).
 *
 * - "today": start of today → end of today.
 * - "yesterday": the full previous calendar day.
 * - "7d" / "30d": the 7/30 calendar days ending today (today − N−1 days → today).
 * - "this_month" / "last_month": the FULL calendar month (start → end),
 *   matching the P&L month-navigator convention ("01/06 – 30/06").
 */
export function resolveRangePreset(preset: RangePreset, now: Date = new Date()): DateRange {
  switch (preset) {
    case "today":
      return { from: startOfDay(now), to: endOfDay(now) };
    case "yesterday": {
      const y = subDays(now, 1);
      return { from: startOfDay(y), to: endOfDay(y) };
    }
    case "7d":
      return { from: startOfDay(subDays(now, 6)), to: endOfDay(now) };
    case "30d":
      return { from: startOfDay(subDays(now, 29)), to: endOfDay(now) };
    case "this_month":
      return { from: startOfMonth(now), to: endOfMonth(now) };
    case "last_month": {
      const lastMonth = subMonths(now, 1);
      return { from: startOfMonth(lastMonth), to: endOfMonth(lastMonth) };
    }
    default: {
      const exhaustiveCheck: never = preset;
      throw new Error(`resolveRangePreset: unknown preset "${exhaustiveCheck}"`);
    }
  }
}

const ALL_PRESETS: RangePreset[] = ["today", "yesterday", "7d", "30d", "this_month", "last_month"];

/** Type guard: raw query value có phải một preset đã đặt tên không. */
export function isRangePreset(value: string | undefined | null): value is RangePreset {
  return value != null && (ALL_PRESETS as string[]).includes(value);
}

/**
 * Nguồn range DUY NHẤT cho mọi trang server có picker toàn cục. Thứ tự ưu tiên:
 *   1. `?tu=&den=` — range "Tùy chọn" (ngày cụ thể).
 *   2. `?range=<preset>` — preset today/yesterday/7d/30d/this_month/last_month (resolve theo `now`).
 *   3. Mặc định `this_month`.
 *
 * Preset đi qua URL (không chỉ localStorage) nên bấm preset LÀ re-render server. Thiếu
 * bước này thì mọi trang kẹt ở this_month dù client đổi lựa chọn — đúng bug đã gặp.
 */
export function resolveRangeFromParams(
  params: { tu?: string; den?: string; range?: string },
  now: Date = new Date(),
): DateRange {
  const custom = parseDateRange({ tu: params.tu, den: params.den });
  if (custom) return custom;
  if (isRangePreset(params.range)) return resolveRangePreset(params.range, now);
  return resolveRangePreset("this_month", now);
}

/**
 * Clamps a range to at most MAX_RANGE_DAYS (inclusive span), keeping `to`
 * fixed and pulling `from` forward when the range is too wide. Used to
 * enforce the custom-range popover's "không quá 366 ngày" validation.
 */
export function clampDateRange(range: DateRange): DateRange {
  const spanDays = differenceInCalendarDays(range.to, range.from) + 1;
  if (spanDays <= MAX_RANGE_DAYS) {
    return range;
  }

  return {
    from: startOfDay(subDays(range.to, MAX_RANGE_DAYS - 1)),
    to: range.to,
  };
}

/**
 * Normalizes an arbitrary [from, to] Date pair to the app's full-day-inclusive
 * contract: `from` = start of its calendar day, `to` = end of its calendar
 * day. Used by `applyCustomRange` (date-range-provider.tsx) so a freshly
 * applied custom range matches exactly what `parseDateRange` produces for the
 * same calendar dates after a page refresh — without this, a `to` built from
 * a plain `new Date(...)` (e.g. midnight from a date-only input) would sit at
 * the START of its last day instead of the end, silently excluding that day's
 * data from any `<= range.to` query.
 */
export function normalizeCustomRange(range: DateRange): DateRange {
  return { from: startOfDay(range.from), to: endOfDay(range.to) };
}

/**
 * Kẹp biên phải `to` không vượt quá "bây giờ" (cuối ngày hôm nay), giữ nguyên
 * `from`. Preset "this_month" resolve ra `to` = cuối THÁNG (ngày tương lai): khi
 * đó `previousRange(range)` lấy span = trọn tháng và so "tháng này mới chạy N
 * ngày" với TRỌN tháng trước → % so kỳ trước tụt giả tạo. Kẹp về hôm nay TRƯỚC
 * khi tính kỳ trước để hai kỳ cùng số ngày. No-op với today/7d/last_month (to đã
 * ≤ hôm nay) và range "Tùy chọn" nằm trong quá khứ, nên chỉ đổi hành vi đúng ca
 * "tháng này (một phần)". Chỉ dùng ở màn có so-kỳ-trước (`/kenh`) — không kẹp ở
 * `resolveRangeFromParams` để không đụng nhãn kỳ/biểu đồ của các trang khác.
 */
export function clampRangeEndToNow(range: DateRange, now: Date = new Date()): DateRange {
  const todayEnd = endOfDay(now);
  // Kẹp CHỈ khi `to` vượt hôm nay VÀ `from` chưa vượt. Range hoàn toàn ở tương
  // lai (from > hôm nay, chỉ đạt được qua URL bịa vì picker chặn ngày tương lai)
  // giữ nguyên để không tạo range đảo `from > to`.
  if (range.to <= todayEnd || range.from > todayEnd) {
    return range;
  }
  return { from: range.from, to: todayEnd };
}

/**
 * The period of the SAME number of days ending immediately before `range.from`.
 * Used for every "so kỳ trước" (vs previous period) delta on Dashboard/Kênh.
 *
 * Span = differenceInCalendarDays(to, from) + 1 (inclusive day count). The
 * previous range keeps day boundaries (start-of-day / end-of-day) like the rest
 * of this file, and is numerically identical to the prev-period math in
 * `getExpenseSummary`. E.g. a 30-day [01/07 → 30/07] → [01/06 → 30/06]; a
 * single day [15/07] → the prior day [14/07].
 */
export function previousRange(range: DateRange): DateRange {
  const spanDays = differenceInCalendarDays(range.to, range.from) + 1;
  return {
    from: startOfDay(subDays(range.from, spanDays)),
    to: endOfDay(subDays(range.from, 1)),
  };
}

/**
 * Cùng số ngày ĐẦU tháng TRƯỚC, căn theo `now` — nền của phép so "Tháng này vs
 * tháng trước" (hàng KPI Dashboard + so-kỳ-trước /kenh). Vd now=22/07 → [01/06 →
 * hết 22/06]. Ngày 29–31 kẹp về ngày cuối tháng trước (28/30/31) để tháng ngắn
 * không tràn. Là NGUỒN DUY NHẤT của công thức — Dashboard và /kenh cùng gọi để
 * KHÔNG lệch mốc so sánh cho cùng nhãn "Tháng này".
 */
export function lastMonthToSameDay(now: Date = new Date()): DateRange {
  const lastMonthStart = startOfMonth(subMonths(now, 1));
  const clampedDay = Math.min(getDate(now), getDaysInMonth(lastMonthStart));
  return { from: lastMonthStart, to: endOfDay(setDate(lastMonthStart, clampedDay)) };
}

/**
 * "Kỳ trước" để so sánh cho một range bất kỳ. Nếu range là "Tháng này (đến hôm
 * nay)" — from = đầu tháng hiện tại VÀ to = cuối ngày hôm nay (đúng dạng
 * `clampRangeEndToNow(resolveRangePreset("this_month"))`) — thì so với CÙNG số
 * ngày đầu tháng trước (`lastMonthToSameDay`, khớp Dashboard). Mọi range khác
 * (Hôm nay / 7 ngày / Tháng trước / Tùy chọn) dùng `previousRange` (trượt cùng
 * span) như cũ. Truyền `now` chung với lúc dựng range để so khớp chính xác.
 */
export function previousComparableRange(range: DateRange, now: Date = new Date()): DateRange {
  const isThisMonthToDate =
    range.from.getTime() === startOfMonth(now).getTime() &&
    range.to.getTime() === endOfDay(now).getTime();
  return isThisMonthToDate ? lastMonthToSameDay(now) : previousRange(range);
}

/** Serializes a range to the `?tu=&den=` query param shape (yyyy-MM-dd). */
export function serializeDateRange(range: DateRange): DateRangeQuery {
  return {
    tu: format(range.from, QUERY_DATE_FORMAT),
    den: format(range.to, QUERY_DATE_FORMAT),
  };
}

/**
 * Parses `?tu=&den=` query params back into a DateRange, expanding each
 * side to its full day boundary and clamping to MAX_RANGE_DAYS. Returns
 * `null` for missing/malformed/inverted input so callers can fall back to
 * a default preset instead of crashing on a tampered URL.
 */
export function parseDateRange(params: Partial<DateRangeQuery>): DateRange | null {
  if (!params.tu || !params.den) {
    return null;
  }

  // date-fns parse dễ tính với chuỗi thiếu chữ số: "26-07-01" ra năm 0026 mà vẫn
  // `isValid` → kỳ báo cáo sai câm lặng. Ép đúng khuôn yyyy-MM-dd trước.
  if (!STRICT_QUERY_DATE.test(params.tu) || !STRICT_QUERY_DATE.test(params.den)) {
    return null;
  }

  const from = parse(params.tu, QUERY_DATE_FORMAT, new Date());
  const to = parse(params.den, QUERY_DATE_FORMAT, new Date());

  if (!isValid(from) || !isValid(to)) {
    return null;
  }

  const expanded: DateRange = { from: startOfDay(from), to: endOfDay(to) };
  if (expanded.from > expanded.to) {
    return null;
  }

  return clampDateRange(expanded);
}
