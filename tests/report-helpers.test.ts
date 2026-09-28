import { endOfDay, startOfDay } from "date-fns";
import { describe, expect, it } from "vitest";

import { previousRange, type DateRange } from "@/lib/date-range";
import { type DailyPoint } from "@/lib/reports/daily-series";
import { groupByWeek } from "@/lib/reports/group-by-week";

/**
 * Guard cho 2 helper THUẦN của Task 3 (không đụng DB). Các aggregator còn lại
 * dùng lại `calcPnlCore` (đã có test cố định) + được e2e phase phủ.
 */

describe("previousRange", () => {
  it("30-day range → previous 30 days ending the day before `from`", () => {
    const range: DateRange = {
      from: startOfDay(new Date(2026, 6, 1)), // 01/07
      to: endOfDay(new Date(2026, 6, 30)), // 30/07 (span 30 ngày)
    };
    const prev = previousRange(range);
    expect(prev.from.getTime()).toBe(startOfDay(new Date(2026, 5, 1)).getTime()); // 01/06
    expect(prev.to.getTime()).toBe(endOfDay(new Date(2026, 5, 30)).getTime()); // 30/06
  });

  it("single-day range → the prior day", () => {
    const range: DateRange = {
      from: startOfDay(new Date(2026, 6, 15)),
      to: endOfDay(new Date(2026, 6, 15)),
    };
    const prev = previousRange(range);
    expect(prev.from.getTime()).toBe(startOfDay(new Date(2026, 6, 14)).getTime());
    expect(prev.to.getTime()).toBe(endOfDay(new Date(2026, 6, 14)).getTime());
  });

  it("previous range has the same inclusive day-span and abuts `from`", () => {
    const range: DateRange = {
      from: startOfDay(new Date(2026, 0, 10)),
      to: endOfDay(new Date(2026, 0, 16)), // 7-day span
    };
    const prev = previousRange(range);
    // 7 ngày: 03/01 → 09/01, kết thúc sát trước 10/01.
    expect(prev.from.getTime()).toBe(startOfDay(new Date(2026, 0, 3)).getTime());
    expect(prev.to.getTime()).toBe(endOfDay(new Date(2026, 0, 9)).getTime());
  });
});

describe("groupByWeek", () => {
  const point = (date: string, revenue: number, netProfit: number): DailyPoint => ({
    date,
    revenue,
    netProfit,
  });

  it("groups exactly 7-day buckets, summing the given keys and keeping the first date", () => {
    const points: DailyPoint[] = Array.from({ length: 14 }, (_, i) =>
      point(`2026-07-${String(i + 1).padStart(2, "0")}`, 10, 5)
    );
    const weeks = groupByWeek(points, ["revenue", "netProfit"]);
    expect(weeks).toHaveLength(2);
    expect(weeks[0].date).toBe("2026-07-01"); // ngày đầu bucket 1
    expect(weeks[0].revenue).toBe(70); // 7 × 10
    expect(weeks[0].netProfit).toBe(35); // 7 × 5
    expect(weeks[1].date).toBe("2026-07-08"); // ngày đầu bucket 2
    expect(weeks[1].revenue).toBe(70);
    expect(weeks[1].netProfit).toBe(35);
  });

  it("handles a partial trailing week (fewer than 7 days)", () => {
    const points: DailyPoint[] = [
      point("2026-07-01", 1, 1),
      point("2026-07-02", 2, 2),
      point("2026-07-03", 3, 3),
      point("2026-07-04", 4, 4),
      point("2026-07-05", 5, 5),
      point("2026-07-06", 6, 6),
      point("2026-07-07", 7, 7),
      point("2026-07-08", 100, 50), // tuần 2 chỉ 1 ngày
    ];
    const weeks = groupByWeek(points, ["revenue", "netProfit"]);
    expect(weeks).toHaveLength(2);
    expect(weeks[0].revenue).toBe(28); // 1+2+…+7
    expect(weeks[0].netProfit).toBe(28);
    expect(weeks[1].date).toBe("2026-07-08");
    expect(weeks[1].revenue).toBe(100); // tuần lẻ giữ nguyên
    expect(weeks[1].netProfit).toBe(50);
  });

  it("returns an empty array for empty input", () => {
    expect(groupByWeek([] as DailyPoint[], ["revenue"])).toEqual([]);
  });

  it("only sums the requested keys, leaving others taken from the bucket's first point", () => {
    const points = [
      { date: "2026-07-01", revenue: 10, label: "a" },
      { date: "2026-07-02", revenue: 20, label: "b" },
    ];
    const weeks = groupByWeek(points, ["revenue"]);
    expect(weeks).toHaveLength(1);
    expect(weeks[0].revenue).toBe(30);
    expect(weeks[0].label).toBe("a"); // khóa ngoài sumKeys giữ theo point đầu
    expect(weeks[0].date).toBe("2026-07-01");
  });
});
