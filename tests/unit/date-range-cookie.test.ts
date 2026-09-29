import { describe, expect, it } from "vitest";

import {
  MAX_RANGE_DAYS,
  resolveRangeFromParams,
  resolveRangePreset,
  serializeDateRange,
  type DateRange,
} from "@/lib/date-range";
import { chuanHoaLuaChonDaLuu, docLuaChonTuCookie } from "@/lib/date-range-cookie";

/**
 * Hợp đồng #254 (chủ shop chốt 29/09): server dựng khoảng theo URL → cookie hợp lệ → "Tháng này";
 * cookie sai hình / ngày không hợp lệ / khoảng đảo ngược bị BỎ QUA an toàn (như chưa có).
 */

const NOW = new Date(2026, 8, 29, 14, 0, 0); // 29/09/2026 14:00 giờ VN (TZ ghim ở tests/setup.ts)
const khoang = (r: DateRange) => {
  const { tu, den } = serializeDateRange(r);
  return `${tu}..${den}`;
};

describe("docLuaChonTuCookie — đọc có kiểm", () => {
  it.each(["today", "yesterday", "7d", "30d", "this_month", "last_month"] as const)(
    "preset hợp lệ '%s' ⇒ đúng khoảng của preset đó",
    (preset) => {
      const sel = docLuaChonTuCookie(preset, NOW);
      expect(sel?.preset).toBe(preset);
      expect(khoang(sel!.range)).toBe(khoang(resolveRangePreset(preset, NOW)));
    },
  );

  it("khoảng tuỳ chọn hợp lệ ⇒ custom đúng ngày", () => {
    const sel = docLuaChonTuCookie("2026-06-01..2026-06-30", NOW);
    expect(sel?.preset).toBe("custom");
    expect(khoang(sel!.range)).toBe("2026-06-01..2026-06-30");
  });

  it.each([
    ["rỗng", ""],
    ["undefined", undefined],
    ["null", null],
    ["preset lạ", "tuan_nay"],
    ["preset sai hoa-thường", "7D"],
    ["khoảng đảo ngược", "2026-06-30..2026-06-01"],
    ["ngày không tồn tại", "2026-02-30..2026-03-05"],
    ["tháng 13", "2026-13-01..2026-13-05"],
    ["sai khuôn thiếu chữ số", "2026-6-1..2026-6-30"],
    ["năm 2 chữ số", "26-06-01..26-06-30"],
    ["thiếu nửa sau", "2026-06-01.."],
    ["thiếu nửa đầu", "..2026-06-30"],
    ["ba đoạn", "2026-06-01..2026-06-15..2026-06-30"],
    ["JSON dạng cũ", '{"preset":"7d"}'],
    ["chuỗi rác dài", "7d".repeat(40)],
    ["dấu cách thừa", " 7d"],
  ])("sai hình (%s) ⇒ bỏ qua (null), không ném lỗi", (_mo_ta, giaTri) => {
    expect(docLuaChonTuCookie(giaTri as string | null | undefined, NOW)).toBeNull();
  });

  it("khoảng dài quá trần ⇒ kẹp y hệt khi khoảng đó nằm trên URL (một luật cho cả hai)", () => {
    const qua = "2024-01-01..2026-06-30";
    const tuCookie = docLuaChonTuCookie(qua, NOW)!.range;
    const tuUrl = resolveRangeFromParams({ tu: "2024-01-01", den: "2026-06-30" }, NOW);
    expect(khoang(tuCookie)).toBe(khoang(tuUrl));
    const soNgay = Math.round((tuCookie.to.getTime() - tuCookie.from.getTime()) / 86_400_000);
    expect(soNgay).toBeLessThanOrEqual(MAX_RANGE_DAYS);
  });

  it("chuanHoaLuaChonDaLuu ⇒ dạng chuẩn gửi xuống client, không mang Date", () => {
    expect(chuanHoaLuaChonDaLuu(docLuaChonTuCookie("last_month", NOW)!)).toEqual({ preset: "last_month" });
    expect(chuanHoaLuaChonDaLuu(docLuaChonTuCookie("2026-06-01..2026-06-30", NOW)!)).toEqual({
      preset: "custom",
      tu: "2026-06-01",
      den: "2026-06-30",
    });
  });
});

describe("resolveRangeFromParams — URL → cookie hợp lệ → 'Tháng này'", () => {
  const daLuu7d = docLuaChonTuCookie("7d", NOW);

  it("URL tu/den thắng cookie", () => {
    const r = resolveRangeFromParams({ tu: "2026-06-01", den: "2026-06-30" }, NOW, daLuu7d);
    expect(khoang(r)).toBe("2026-06-01..2026-06-30");
  });

  it("URL ?range= thắng cookie", () => {
    const r = resolveRangeFromParams({ range: "last_month" }, NOW, daLuu7d);
    expect(khoang(r)).toBe(khoang(resolveRangePreset("last_month", NOW)));
  });

  it("URL sạch ⇒ dùng cookie", () => {
    expect(khoang(resolveRangeFromParams({}, NOW, daLuu7d))).toBe(khoang(resolveRangePreset("7d", NOW)));
  });

  it("URL mang tham số HỎNG ⇒ bỏ qua URL, rơi về cookie (không rơi thẳng về 'Tháng này')", () => {
    const r = resolveRangeFromParams({ tu: "2026-06-30", den: "2026-06-01", range: "xx" }, NOW, daLuu7d);
    expect(khoang(r)).toBe(khoang(resolveRangePreset("7d", NOW)));
  });

  it("URL sạch + không cookie (hoặc cookie hỏng đã thành null) ⇒ 'Tháng này'", () => {
    expect(khoang(resolveRangeFromParams({}, NOW, null))).toBe(khoang(resolveRangePreset("this_month", NOW)));
    expect(khoang(resolveRangeFromParams({}, NOW, docLuaChonTuCookie("rac", NOW)))).toBe(
      khoang(resolveRangePreset("this_month", NOW)),
    );
  });

  it("gọi như cũ (không truyền cookie) ⇒ hành vi cũ: URL → 'Tháng này'", () => {
    expect(khoang(resolveRangeFromParams({}, NOW))).toBe(khoang(resolveRangePreset("this_month", NOW)));
    expect(khoang(resolveRangeFromParams({ range: "7d" }, NOW))).toBe(khoang(resolveRangePreset("7d", NOW)));
  });
});
