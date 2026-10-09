import { describe, expect, it } from "vitest";

import { tinhSoDuViAds } from "@/lib/no-phai-tra/so-du-vi-ads";

/**
 * Số dư ví ads trả trước (S1, spec §5.9) — THUẦN: `soDuNeo + Σ nạp − Σ chi` của giao dịch có ngày VN
 * trong (ngày neo, t]. Neo là "số dư CUỐI NGÀY ngayNeo" nên giao dịch ĐÚNG ngày neo đã nằm trong neo.
 */
const vn = (iso: string) => new Date(`${iso}+07:00`);
const NEO = { soDuNeo: 0, ngayNeo: vn("2026-10-31T00:00:00") };
const NAP = [{ date: vn("2026-11-05T09:00:00"), amount: 10_000_000 }];
// 2tr chạy ads rải 06–10/11 (5 ngày × 400k).
const CHI = ["06", "07", "08", "09", "10"].map((d) => ({ date: vn(`2026-11-${d}T00:00:00`), amount: 400_000 }));

describe("tinhSoDuViAds", () => {
  it("nạp 10tr 05/11, chạy 2tr 06–10/11 ⇒ cuối 10/11 còn 8tr", () => {
    expect(tinhSoDuViAds(NEO, NAP, CHI, vn("2026-11-10T00:00:00"))).toBe(8_000_000);
  });

  it("theo ngày xem: 04/11 = 0 · 05/11 = 10tr · 07/11 = 9,2tr", () => {
    expect(tinhSoDuViAds(NEO, NAP, CHI, vn("2026-11-04T23:59:00"))).toBe(0);
    expect(tinhSoDuViAds(NEO, NAP, CHI, vn("2026-11-05T00:00:00"))).toBe(10_000_000);
    expect(tinhSoDuViAds(NEO, NAP, CHI, vn("2026-11-07T08:00:00"))).toBe(9_200_000);
  });

  it("giao dịch ĐÚNG ngày neo không đếm lại; giao dịch 23:59 VN ngày t có đếm", () => {
    const neo = { soDuNeo: 3_000_000, ngayNeo: vn("2026-10-31T00:00:00") };
    const nap = [
      { date: vn("2026-10-31T23:00:00"), amount: 1_000_000 }, // trong neo
      { date: vn("2026-11-02T23:59:00"), amount: 500_000 }, // cuối ngày t
    ];
    expect(tinhSoDuViAds(neo, nap, [], vn("2026-11-02T00:00:00"))).toBe(3_500_000);
  });
});
