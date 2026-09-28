import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  endOfDay,
  endOfMonth,
  getDate,
  getDaysInMonth,
  setDate,
  startOfDay,
  startOfMonth,
  subDays,
  subMonths,
} from "date-fns";

import {
  MAX_RANGE_DAYS,
  clampDateRange,
  clampRangeEndToNow,
  isRangePreset,
  lastMonthToSameDay,
  normalizeCustomRange,
  parseDateRange,
  previousComparableRange,
  previousRange,
  resolveRangeFromParams,
  resolveRangePreset,
  serializeDateRange,
  type DateRange,
} from "@/lib/date-range";

// Fixed reference instant: Wed 2026-07-15, 12:30 local time. Picked mid-month
// (not the 1st/last day) so month-boundary presets aren't accidentally
// correct by coincidence.
const NOW = new Date(2026, 6, 15, 12, 30, 0);

describe("resolveRangePreset", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("today: start of today to end of today", () => {
    const range = resolveRangePreset("today");
    expect(range.from.getTime()).toBe(startOfDay(NOW).getTime());
    expect(range.to.getTime()).toBe(endOfDay(NOW).getTime());
  });

  it("yesterday: start to end of the previous calendar day", () => {
    const range = resolveRangePreset("yesterday");
    expect(range.from.getTime()).toBe(startOfDay(subDays(NOW, 1)).getTime());
    expect(range.to.getTime()).toBe(endOfDay(subDays(NOW, 1)).getTime());
  });

  it("7d: the 7 calendar days ending today (today - 6 to today)", () => {
    const range = resolveRangePreset("7d");
    expect(range.from.getTime()).toBe(startOfDay(subDays(NOW, 6)).getTime());
    expect(range.to.getTime()).toBe(endOfDay(NOW).getTime());
  });

  it("30d: the 30 calendar days ending today (today - 29 to today)", () => {
    const range = resolveRangePreset("30d");
    expect(range.from.getTime()).toBe(startOfDay(subDays(NOW, 29)).getTime());
    expect(range.to.getTime()).toBe(endOfDay(NOW).getTime());
  });

  it("this_month: the full current calendar month", () => {
    const range = resolveRangePreset("this_month");
    expect(range.from.getTime()).toBe(startOfMonth(NOW).getTime());
    expect(range.to.getTime()).toBe(endOfMonth(NOW).getTime());
  });

  it("last_month: the full previous calendar month", () => {
    const range = resolveRangePreset("last_month");
    const lastMonth = subMonths(NOW, 1);
    expect(range.from.getTime()).toBe(startOfMonth(lastMonth).getTime());
    expect(range.to.getTime()).toBe(endOfMonth(lastMonth).getTime());
  });

  it("accepts an injected `now` instead of relying on the system clock", () => {
    const injectedNow = new Date(2025, 0, 10, 8, 0, 0);
    const range = resolveRangePreset("today", injectedNow);
    expect(range.from.getTime()).toBe(startOfDay(injectedNow).getTime());
    expect(range.to.getTime()).toBe(endOfDay(injectedNow).getTime());
  });
});

describe("clampDateRange", () => {
  it("leaves a range exactly at MAX_RANGE_DAYS unchanged", () => {
    const to = new Date(2026, 6, 15);
    const from = startOfDay(subDays(to, MAX_RANGE_DAYS - 1)); // exactly 366-day span
    const clamped = clampDateRange({ from, to });
    expect(clamped.from.getTime()).toBe(from.getTime());
    expect(clamped.to.getTime()).toBe(to.getTime());
  });

  it("clamps a range wider than MAX_RANGE_DAYS, pulling `from` forward and keeping `to` fixed", () => {
    const to = new Date(2026, 6, 15);
    const from = subDays(to, 400); // 401-day span, over the cap
    const clamped = clampDateRange({ from, to });
    expect(clamped.to.getTime()).toBe(to.getTime());
    expect(clamped.from.getTime()).toBe(startOfDay(subDays(to, MAX_RANGE_DAYS - 1)).getTime());
  });

  it("passes an inverted range (from > to) through unchanged, since its span is <= MAX_RANGE_DAYS", () => {
    const from = new Date(2026, 6, 20);
    const to = new Date(2026, 6, 10);
    const clamped = clampDateRange({ from, to });
    expect(clamped.from.getTime()).toBe(from.getTime());
    expect(clamped.to.getTime()).toBe(to.getTime());
  });
});

describe("normalizeCustomRange", () => {
  it("expands a midnight-to-midnight pair to start-of-day/end-of-day, matching parseDateRange for the same calendar dates", () => {
    // Mirrors what date-range-picker.tsx builds from `<input type="date">`
    // values: `new Date(\`${draftFrom}T00:00:00\`)` for BOTH from and to.
    const from = new Date(`2026-07-01T00:00:00`);
    const to = new Date(`2026-07-15T00:00:00`);

    const normalized = normalizeCustomRange({ from, to });

    expect(normalized.from.getTime()).toBe(startOfDay(new Date(2026, 6, 1)).getTime());
    expect(normalized.to.getTime()).toBe(endOfDay(new Date(2026, 6, 15)).getTime());

    // Same calendar dates through the URL round-trip must land on the exact
    // same instants — this is the bug this function fixes: pre-fix, `to`
    // stayed at 00:00:00.000 instead of matching this 23:59:59.999.
    const viaUrl = parseDateRange({ tu: "2026-07-01", den: "2026-07-15" });
    expect(viaUrl).not.toBeNull();
    expect(normalized.from.getTime()).toBe(viaUrl?.from.getTime());
    expect(normalized.to.getTime()).toBe(viaUrl?.to.getTime());
  });

  it("is idempotent on already-normalized boundaries", () => {
    const range: DateRange = {
      from: startOfDay(new Date(2026, 6, 1)),
      to: endOfDay(new Date(2026, 6, 15)),
    };
    const normalized = normalizeCustomRange(range);
    expect(normalized.from.getTime()).toBe(range.from.getTime());
    expect(normalized.to.getTime()).toBe(range.to.getTime());
  });
});

describe("clampRangeEndToNow (chống so kỳ trước lệch khi preset 'Tháng này')", () => {
  it("kẹp biên phải của 'this_month' về cuối hôm nay khi đang giữa tháng", () => {
    const clamped = clampRangeEndToNow(resolveRangePreset("this_month", NOW), NOW);
    // from giữ nguyên đầu tháng; to bị kéo về cuối ngày HÔM NAY (không còn cuối tháng tương lai).
    expect(clamped.from.getTime()).toBe(startOfMonth(NOW).getTime());
    expect(clamped.to.getTime()).toBe(endOfDay(NOW).getTime());
  });

  it("no-op với 'last_month' (đã nằm trọn trong quá khứ)", () => {
    const input = resolveRangePreset("last_month", NOW);
    const clamped = clampRangeEndToNow(input, NOW);
    expect(clamped.from.getTime()).toBe(input.from.getTime());
    expect(clamped.to.getTime()).toBe(input.to.getTime());
  });

  it("no-op với 'today' và '7d' (biên phải vốn đã là cuối hôm nay)", () => {
    for (const preset of ["today", "7d"] as const) {
      const input = resolveRangePreset(preset, NOW);
      const clamped = clampRangeEndToNow(input, NOW);
      expect(clamped.to.getTime()).toBe(input.to.getTime());
      expect(clamped.from.getTime()).toBe(input.from.getTime());
    }
  });

  it("no-op với range 'Tùy chọn' hoàn toàn ở quá khứ", () => {
    const input = parseDateRange({ tu: "2026-06-01", den: "2026-06-30" })!;
    const clamped = clampRangeEndToNow(input, NOW);
    expect(clamped.from.getTime()).toBe(input.from.getTime());
    expect(clamped.to.getTime()).toBe(input.to.getTime());
  });

  it("no-op với range hoàn toàn ở tương lai (URL bịa) — không tạo range đảo from>to", () => {
    const input = parseDateRange({ tu: "2026-08-01", den: "2026-08-31" })!; // cả hai biên > NOW (15/07)
    const clamped = clampRangeEndToNow(input, NOW);
    expect(clamped.from.getTime()).toBe(input.from.getTime());
    expect(clamped.to.getTime()).toBe(input.to.getTime());
    expect(clamped.from.getTime()).toBeLessThanOrEqual(clamped.to.getTime());
  });

  it("kẹp rồi previousRange (trượt) = số ngày đã trôi liền trước đầu tháng — nền cho 7d/custom", () => {
    // NOW = 15/07 → tháng này mới chạy 15 ngày (01/07 → 15/07). previousRange
    // trượt: [16/06 → 30/06]. (Riêng ca "Tháng này", /kenh dùng
    // previousComparableRange → same-days, xem block dưới.)
    const clamped = clampRangeEndToNow(resolveRangePreset("this_month", NOW), NOW);
    const prev = previousRange(clamped);
    expect(prev.from.getTime()).toBe(startOfDay(new Date(2026, 5, 16)).getTime());
    expect(prev.to.getTime()).toBe(endOfDay(new Date(2026, 5, 30)).getTime());
  });
});

describe("lastMonthToSameDay (nguồn duy nhất so 'Tháng này vs tháng trước')", () => {
  it("cùng số ngày đầu tháng trước, căn theo now giữa tháng", () => {
    // NOW = 15/07 → [01/06 → hết 15/06].
    const r = lastMonthToSameDay(NOW);
    expect(r.from.getTime()).toBe(startOfMonth(new Date(2026, 5, 15)).getTime());
    expect(r.to.getTime()).toBe(endOfDay(new Date(2026, 5, 15)).getTime());
  });

  it("khớp CHÍNH XÁC công thức inline cũ của Dashboard (chống drift sau refactor DRY)", () => {
    for (const now of [new Date(2026, 6, 15, 12, 30), new Date(2026, 2, 30), new Date(2026, 0, 31)]) {
      const lastMonthStart = startOfMonth(subMonths(now, 1));
      const clampedDay = Math.min(getDate(now), getDaysInMonth(lastMonthStart));
      const expected = { from: lastMonthStart, to: endOfDay(setDate(lastMonthStart, clampedDay)) };
      const r = lastMonthToSameDay(now);
      expect(r.from.getTime()).toBe(expected.from.getTime());
      expect(r.to.getTime()).toBe(expected.to.getTime());
    }
  });

  it("kẹp ngày 29–31 về ngày cuối tháng trước ngắn hơn (31/03 → 28/02 năm thường)", () => {
    const r = lastMonthToSameDay(new Date(2026, 2, 31)); // 31/03/2026, tháng 2 có 28 ngày
    expect(r.from.getTime()).toBe(startOfMonth(new Date(2026, 1, 1)).getTime());
    expect(r.to.getTime()).toBe(endOfDay(new Date(2026, 1, 28)).getTime());
  });
});

describe("previousComparableRange (đồng bộ so-kỳ-trước /kenh với Dashboard)", () => {
  it("ca 'Tháng này (đến hôm nay)' → same-days đầu tháng trước, KHỚP lastMonthToSameDay/Dashboard", () => {
    const range = clampRangeEndToNow(resolveRangePreset("this_month", NOW), NOW);
    const prev = previousComparableRange(range, NOW);
    const dashboard = lastMonthToSameDay(NOW); // đúng thứ hàng KPI Dashboard dùng
    expect(prev.from.getTime()).toBe(dashboard.from.getTime());
    expect(prev.to.getTime()).toBe(dashboard.to.getTime());
    // = [01/06 → hết 15/06], KHÔNG phải trượt [16/06 → 30/06].
    expect(prev.from.getTime()).toBe(startOfMonth(new Date(2026, 5, 1)).getTime());
    expect(prev.to.getTime()).toBe(endOfDay(new Date(2026, 5, 15)).getTime());
  });

  it("preset '7d' → giữ previousRange (trượt cùng span), KHÔNG dùng same-days", () => {
    const range = clampRangeEndToNow(resolveRangePreset("7d", NOW), NOW);
    const prev = previousComparableRange(range, NOW);
    expect(prev.from.getTime()).toBe(previousRange(range).from.getTime());
    expect(prev.to.getTime()).toBe(previousRange(range).to.getTime());
  });

  it("preset 'last_month' → previousRange (trượt), KHÔNG nhầm thành same-days", () => {
    const range = clampRangeEndToNow(resolveRangePreset("last_month", NOW), NOW);
    const prev = previousComparableRange(range, NOW);
    expect(prev.from.getTime()).toBe(previousRange(range).from.getTime());
    expect(prev.to.getTime()).toBe(previousRange(range).to.getTime());
  });

  it("range 'Tùy chọn' bắt đầu đầu tháng nhưng KHÔNG tới hôm nay → vẫn previousRange (không misfire same-days)", () => {
    // [01/07 → 10/07], to != cuối ngày hôm nay (15/07) → không phải 'đến hôm nay'.
    const range = parseDateRange({ tu: "2026-07-01", den: "2026-07-10" })!;
    const prev = previousComparableRange(range, NOW);
    expect(prev.from.getTime()).toBe(previousRange(range).from.getTime());
    expect(prev.to.getTime()).toBe(previousRange(range).to.getTime());
  });
});

describe("serializeDateRange / parseDateRange round-trip", () => {
  it("round-trips a range through serialize -> parse unchanged", () => {
    const range: DateRange = {
      from: startOfDay(new Date(2026, 0, 5)),
      to: endOfDay(new Date(2026, 0, 20)),
    };

    const query = serializeDateRange(range);
    expect(query).toEqual({ tu: "2026-01-05", den: "2026-01-20" });

    const parsed = parseDateRange(query);
    expect(parsed).not.toBeNull();
    expect(parsed?.from.getTime()).toBe(range.from.getTime());
    expect(parsed?.to.getTime()).toBe(range.to.getTime());
  });
});

describe("parseDateRange failure modes (fails closed)", () => {
  it("returns null when `tu` is missing", () => {
    expect(parseDateRange({ den: "2026-07-15" })).toBeNull();
  });

  it("returns null when `den` is missing", () => {
    expect(parseDateRange({ tu: "2026-07-01" })).toBeNull();
  });

  it("returns null when both params are missing", () => {
    expect(parseDateRange({})).toBeNull();
  });

  it("returns null for a non-date string", () => {
    expect(parseDateRange({ tu: "not-a-date", den: "2026-07-15" })).toBeNull();
  });

  it("returns null for an out-of-range calendar date (Feb 30)", () => {
    expect(parseDateRange({ tu: "2026-02-30", den: "2026-07-15" })).toBeNull();
  });

  it("returns null for a 2-digit year that date-fns would accept as year 0026", () => {
    expect(parseDateRange({ tu: "26-07-01", den: "26-07-15" })).toBeNull();
  });

  it("returns null for a month/day missing its leading zero", () => {
    expect(parseDateRange({ tu: "2026-7-1", den: "2026-07-15" })).toBeNull();
  });

  it("returns null for an inverted range (tu after den)", () => {
    expect(parseDateRange({ tu: "2026-07-20", den: "2026-07-10" })).toBeNull();
  });

  it("clamps an overly-wide but otherwise valid range instead of returning it raw", () => {
    const den = "2026-07-15";
    const parsed = parseDateRange({ tu: "2020-01-01", den });
    expect(parsed).not.toBeNull();

    const to = endOfDay(new Date(2026, 6, 15));
    const expectedFrom = startOfDay(subDays(to, MAX_RANGE_DAYS - 1));
    expect(parsed?.to.getTime()).toBe(to.getTime());
    expect(parsed?.from.getTime()).toBe(expectedFrom.getTime());
  });
});

describe("isRangePreset", () => {
  it("nhận preset hợp lệ", () => {
    expect(isRangePreset("today")).toBe(true);
    expect(isRangePreset("yesterday")).toBe(true);
    expect(isRangePreset("7d")).toBe(true);
    expect(isRangePreset("30d")).toBe(true);
    expect(isRangePreset("this_month")).toBe(true);
    expect(isRangePreset("last_month")).toBe(true);
  });

  it("từ chối giá trị lạ / 'custom' / undefined / null", () => {
    expect(isRangePreset("custom")).toBe(false);
    expect(isRangePreset("xxx")).toBe(false);
    expect(isRangePreset(undefined)).toBe(false);
    expect(isRangePreset(null)).toBe(false);
  });
});

describe("resolveRangeFromParams (nguồn range trang server)", () => {
  it("tu/den (Tùy chọn) THẮNG cả preset", () => {
    const r = resolveRangeFromParams({ tu: "2026-06-01", den: "2026-06-30", range: "today" }, NOW);
    const expected = parseDateRange({ tu: "2026-06-01", den: "2026-06-30" })!;
    expect(r.from.getTime()).toBe(expected.from.getTime());
    expect(r.to.getTime()).toBe(expected.to.getTime());
  });

  it("dùng ?range=<preset> khi KHÔNG có tu/den — đây là điểm sửa bug preset", () => {
    const r = resolveRangeFromParams({ range: "last_month" }, NOW);
    const expected = resolveRangePreset("last_month", NOW);
    expect(r.from.getTime()).toBe(expected.from.getTime());
    expect(r.to.getTime()).toBe(expected.to.getTime());
  });

  it("mặc định this_month khi không có tham số nào", () => {
    const r = resolveRangeFromParams({}, NOW);
    const expected = resolveRangePreset("this_month", NOW);
    expect(r.from.getTime()).toBe(expected.from.getTime());
    expect(r.to.getTime()).toBe(expected.to.getTime());
  });

  it("range bịa/không hợp lệ → this_month (chống URL tampering)", () => {
    const r = resolveRangeFromParams({ range: "xxx" }, NOW);
    const expected = resolveRangePreset("this_month", NOW);
    expect(r.from.getTime()).toBe(expected.from.getTime());
    expect(r.to.getTime()).toBe(expected.to.getTime());
  });

  it("tu/den hỏng nhưng range hợp lệ → rơi về range", () => {
    const r = resolveRangeFromParams({ tu: "bad", den: "bad", range: "today" }, NOW);
    const expected = resolveRangePreset("today", NOW);
    expect(r.from.getTime()).toBe(expected.from.getTime());
    expect(r.to.getTime()).toBe(expected.to.getTime());
  });
});

describe("chốt biên múi giờ VN (bất biến #3 — TZ pin ở tests/setup.ts, assert boot ở src/instrumentation.ts)", () => {
  // Range tháng 7 & tháng 8 theo giờ VN (resolveRangePreset dùng local time).
  const july = resolveRangePreset("this_month", new Date(2026, 6, 15));
  const august = resolveRangePreset("this_month", new Date(2026, 7, 15));

  it("process test đang chạy đúng múi giờ VN (ICU có thể canonicalize về alias cũ Asia/Saigon)", () => {
    // "Asia/Saigon" = alias tzdb cũ của CÙNG zone Asia/Ho_Chi_Minh — ICU trả
    // tên này dù TZ env đặt Asia/Ho_Chi_Minh. instrumentation.ts chấp nhận cả 2.
    expect(["Asia/Ho_Chi_Minh", "Asia/Saigon"]).toContain(
      Intl.DateTimeFormat().resolvedOptions().timeZone,
    );
  });

  it("đơn 23:30 VN đêm 31/07 vẫn thuộc this_month tháng 7 (không tràn sang tháng 8 nếu TZ trôi về phía đông)", () => {
    const at = new Date("2026-07-31T23:30:00+07:00"); // = 16:30Z cùng ngày
    expect(at >= july.from && at <= july.to).toBe(true);
    expect(at < august.from).toBe(true);
  });

  it("đơn 06:00 VN sáng 01/08 (= 23:00Z 31/07) thuộc tháng 8, KHÔNG rơi ngược về tháng 7 nếu TZ trôi về UTC", () => {
    const at = new Date("2026-08-01T06:00:00+07:00");
    // Nếu process chạy UTC: endOfMonth(tháng 7) = 23:59:59.999Z 31/07 > 23:00Z
    // → đơn này bị đếm nhầm vào tháng 7. TZ VN thì phải nằm NGOÀI tháng 7.
    expect(at > july.to).toBe(true);
    expect(at >= august.from && at <= august.to).toBe(true);
  });
});
