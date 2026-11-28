import { describe, expect, it } from "vitest";

import { daySoTrang } from "@/lib/orders/day-so-trang";

describe("daySoTrang", () => {
  it("một trang ⇒ chỉ [1]", () => {
    expect(daySoTrang(1, 1)).toEqual([1]);
  });

  it("đầu danh sách: có trang cuối, khoảng hở thành …", () => {
    expect(daySoTrang(1, 5)).toEqual([1, 2, "…", 5]);
  });

  it("giữa danh sách: ±1 quanh trang hiện tại, hai đầu luôn có", () => {
    expect(daySoTrang(5, 63)).toEqual([1, "…", 4, 5, 6, "…", 63]);
  });

  it("trang cuối", () => {
    expect(daySoTrang(63, 63)).toEqual([1, "…", 62, 63]);
  });

  it("ít trang ⇒ liệt kê đủ, không …", () => {
    expect(daySoTrang(2, 3)).toEqual([1, 2, 3]);
  });

  it("thiếu đúng một trang giữa hai mốc vẫn là …", () => {
    expect(daySoTrang(4, 10)).toEqual([1, "…", 3, 4, 5, "…", 10]);
  });

  it("đầu vào ngoài khoảng bị kẹp, không ném lỗi", () => {
    expect(daySoTrang(99, 3)).toEqual([1, 2, 3]);
    expect(daySoTrang(0, 3)).toEqual([1, 2, 3]);
    expect(daySoTrang(Number.NaN, Number.NaN)).toEqual([1]);
    expect(daySoTrang(1, 0)).toEqual([1]);
  });
});
