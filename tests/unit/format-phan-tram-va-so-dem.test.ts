import { describe, expect, it } from "vitest";

import { formatPercent, formatSoDem, formatVnd } from "@/lib/format";

describe("formatPercent — một kiểu duy nhất cho mọi tỷ lệ", () => {
  it("tối đa 1 chữ số thập phân, bỏ ',0' thừa", () => {
    expect(formatPercent(12)).toBe("12%");
    expect(formatPercent(12.0)).toBe("12%");
    expect(formatPercent(12.5)).toBe("12,5%");
    expect(formatPercent(6.54)).toBe("6,5%");
    expect(formatPercent(0)).toBe("0%");
  });

  it("số âm giữ dấu", () => {
    expect(formatPercent(-3.2)).toBe("-3,2%");
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    "không hữu hạn (%s) in '—' chứ không ném — một ô hỏng không được sập cả tab",
    (v) => {
      expect(formatPercent(v)).toBe("—");
    },
  );
});

describe("formatSoDem — số đếm có dấu chấm ngăn nghìn", () => {
  it("ngăn nghìn kiểu Việt, không ký hiệu tiền", () => {
    expect(formatSoDem(0)).toBe("0");
    expect(formatSoDem(999)).toBe("999");
    expect(formatSoDem(1234567)).toBe("1.234.567");
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY])("không hữu hạn (%s) in '—'", (v) => {
    expect(formatSoDem(v)).toBe("—");
  });
});

describe("hàm tiền vẫn ném khi không hữu hạn", () => {
  it("formatVnd(NaN) ném RangeError — sai số tiền phải to tiếng", () => {
    expect(() => formatVnd(Number.NaN)).toThrow(RangeError);
  });
});
