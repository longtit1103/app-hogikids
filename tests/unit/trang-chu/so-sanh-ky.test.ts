import { format } from "date-fns";
import { describe, expect, it } from "vitest";

import { lastMonthToSameDay, resolveRangePreset, type DateRange } from "@/lib/date-range";
import {
  ghepKyTruoc,
  kySoSanh,
  nhanKySoSanh,
  phanTramThayDoi,
  rangeBieuDo,
} from "@/lib/trang-chu/so-sanh-ky";

// 31/10/2026 10:00 giờ VN (setup ép TZ=Asia/Ho_Chi_Minh).
const NOW = new Date("2026-10-31T10:00:00+07:00");
const ngay = (r: DateRange) => `${format(r.from, "yyyy-MM-dd HH:mm")} → ${format(r.to, "yyyy-MM-dd HH:mm")}`;

describe("phanTramThayDoi", () => {
  it("tăng / giảm / kỳ trước 0 ⇒ null (Mới) / lỗ giảm = cải thiện", () => {
    expect(phanTramThayDoi(120, 100)).toBe(20);
    expect(phanTramThayDoi(80, 100)).toBe(-20);
    expect(phanTramThayDoi(5, 0)).toBeNull();
    expect(phanTramThayDoi(0, 0)).toBeNull();
    expect(phanTramThayDoi(-50, -100)).toBe(50);
  });
});

describe("nhanKySoSanh", () => {
  it("Hôm nay ⇒ hôm qua", () => {
    expect(nhanKySoSanh(resolveRangePreset("today", NOW), NOW)).toBe("hôm qua");
  });
  it("Hôm qua ⇒ hôm kia", () => {
    expect(nhanKySoSanh(resolveRangePreset("yesterday", NOW), NOW)).toBe("hôm kia");
  });
  it("Tháng này (chưa kẹp, to = cuối tháng) ⇒ cùng kỳ tháng trước", () => {
    expect(nhanKySoSanh(resolveRangePreset("this_month", NOW), NOW)).toBe("cùng kỳ tháng trước");
  });
  it("7 ngày ⇒ <N> ngày trước đó", () => {
    expect(nhanKySoSanh(resolveRangePreset("7d", NOW), NOW)).toBe("7 ngày trước đó");
  });
  it("Tháng trước (trọn một tháng dương lịch đã qua) ⇒ tháng trước đó", () => {
    expect(nhanKySoSanh(resolveRangePreset("last_month", NOW), NOW)).toBe("tháng trước đó");
  });
  it("Tùy chọn đúng 1 ngày xa hơn hôm kia ⇒ 'hôm trước' (không phải '1 ngày trước đó'); N>1 ngày giữ nguyên", () => {
    const motNgay: DateRange = { from: new Date("2026-10-10T00:00:00+07:00"), to: new Date("2026-10-10T23:59:59.999+07:00") };
    expect(nhanKySoSanh(motNgay, NOW)).toBe("hôm trước");
    const baNgay: DateRange = { from: new Date("2026-10-10T00:00:00+07:00"), to: new Date("2026-10-12T23:59:59.999+07:00") };
    expect(nhanKySoSanh(baNgay, NOW)).toBe("3 ngày trước đó");
  });
});

describe("kySoSanh", () => {
  it("Hôm nay ⇒ TRỌN hôm qua; Tháng này ⇒ lastMonthToSameDay", () => {
    expect(ngay(kySoSanh(resolveRangePreset("today", NOW), NOW))).toBe("2026-10-30 00:00 → 2026-10-30 23:59");
    expect(kySoSanh(resolveRangePreset("this_month", NOW), NOW)).toEqual(lastMonthToSameDay(NOW));
  });
  // Ngày 01: "Hôm nay" và "Tháng này" kẹp ra CÙNG một kỳ 1 ngày — phải phân biệt bằng range GỐC.
  const MUNG_1 = new Date("2026-11-01T10:00:00+07:00");
  it("ngày 01, Hôm nay ⇒ TRỌN 31/10, nhãn 'hôm qua', biểu đồ 7 ngày", () => {
    const homNay = resolveRangePreset("today", MUNG_1);
    expect(ngay(kySoSanh(homNay, MUNG_1))).toBe("2026-10-31 00:00 → 2026-10-31 23:59");
    expect(nhanKySoSanh(homNay, MUNG_1)).toBe("hôm qua");
    expect(rangeBieuDo(homNay, MUNG_1).motNgay).toBe(true);
  });
  it("ngày 01, Tháng này (gốc trọn tháng 11) ⇒ lastMonthToSameDay = 01/10, nhãn 'cùng kỳ tháng trước', motNgay false", () => {
    const thangNay = resolveRangePreset("this_month", MUNG_1);
    expect(kySoSanh(thangNay, MUNG_1)).toEqual(lastMonthToSameDay(MUNG_1));
    expect(ngay(kySoSanh(thangNay, MUNG_1))).toBe("2026-10-01 00:00 → 2026-10-01 23:59");
    expect(nhanKySoSanh(thangNay, MUNG_1)).toBe("cùng kỳ tháng trước");
    expect(rangeBieuDo(thangNay, MUNG_1).motNgay).toBe(false);
  });
});

describe("kySoSanh — trọn một tháng dương lịch đã qua", () => {
  it("Tháng trước (T9/2026, now 31/10) ⇒ trọn T8 (01/08–31/08), KHÔNG phải 31 ngày trượt", () => {
    const t9 = resolveRangePreset("last_month", NOW);
    expect(ngay(t9)).toBe("2026-09-01 00:00 → 2026-09-30 23:59");
    expect(ngay(kySoSanh(t9, NOW))).toBe("2026-08-01 00:00 → 2026-08-31 23:59");
  });
  it("Tùy chọn trọn T10/2026 xem ngày 05/11 ⇒ trọn T9 (01/09–30/09), nhãn 'tháng trước đó'", () => {
    const now = new Date("2026-11-05T10:00:00+07:00");
    const t10: DateRange = { from: new Date("2026-10-01T00:00:00+07:00"), to: new Date("2026-10-31T23:59:59.999+07:00") };
    expect(ngay(kySoSanh(t10, now))).toBe("2026-09-01 00:00 → 2026-09-30 23:59");
    expect(nhanKySoSanh(t10, now)).toBe("tháng trước đó");
  });
  it("T3/2027 ⇒ trọn T2 (28 ngày, ngắn hơn) và T1/2027 ⇒ trọn T12/2026 (qua ranh giới năm)", () => {
    const now = new Date("2027-04-10T10:00:00+07:00");
    const t3: DateRange = { from: new Date("2027-03-01T00:00:00+07:00"), to: new Date("2027-03-31T23:59:59.999+07:00") };
    expect(ngay(kySoSanh(t3, now))).toBe("2027-02-01 00:00 → 2027-02-28 23:59");
    const t1: DateRange = { from: new Date("2027-01-01T00:00:00+07:00"), to: new Date("2027-01-31T23:59:59.999+07:00") };
    expect(ngay(kySoSanh(t1, now))).toBe("2026-12-01 00:00 → 2026-12-31 23:59");
  });
  it("Tháng ĐANG CHẠY (trọn tháng 10 xem 31/10, hoặc giữa tháng) KHÔNG rẽ nhánh này: vẫn cùng kỳ tháng trước", () => {
    const giuaThang = new Date("2026-10-20T10:00:00+07:00");
    expect(kySoSanh(resolveRangePreset("this_month", giuaThang), giuaThang)).toEqual(lastMonthToSameDay(giuaThang));
    expect(nhanKySoSanh(resolveRangePreset("this_month", giuaThang), giuaThang)).toBe("cùng kỳ tháng trước");
    expect(kySoSanh(resolveRangePreset("this_month", NOW), NOW)).toEqual(lastMonthToSameDay(NOW));
  });
  it("tháng chưa trọn (01/09–29/09) không phải tháng dương lịch ⇒ trượt 29 ngày như cũ", () => {
    const r: DateRange = { from: new Date("2026-09-01T00:00:00+07:00"), to: new Date("2026-09-29T23:59:59.999+07:00") };
    expect(ngay(kySoSanh(r, NOW))).toBe("2026-08-03 00:00 → 2026-08-31 23:59");
    expect(nhanKySoSanh(r, NOW)).toBe("29 ngày trước đó");
  });
});

describe("rangeBieuDo", () => {
  it("Hôm nay ⇒ 7 ngày 25/10–31/10, motNgay true", () => {
    const bd = rangeBieuDo(resolveRangePreset("today", NOW), NOW);
    expect(bd.motNgay).toBe(true);
    expect(ngay(bd.range)).toBe("2026-10-25 00:00 → 2026-10-31 23:59");
  });
  it("7 ngày ⇒ giữ nguyên, motNgay false", () => {
    const r = resolveRangePreset("7d", NOW);
    expect(rangeBieuDo(r, NOW)).toEqual({ range: r, motNgay: false });
  });
  it("Tháng này ⇒ kẹp về hôm nay", () => {
    const bd = rangeBieuDo(resolveRangePreset("this_month", NOW), NOW);
    expect(bd.motNgay).toBe(false);
    expect(ngay(bd.range)).toBe("2026-10-01 00:00 → 2026-10-31 23:59");
  });
});

describe("ghepKyTruoc", () => {
  it("kỳ trước ngắn hơn (tháng 31 ngày so 30 ngày) ⇒ đuôi null", () => {
    expect(ghepKyTruoc([1, 2, 3], [9, 8])).toEqual([
      { hienTai: 1, kyTruoc: 9 },
      { hienTai: 2, kyTruoc: 8 },
      { hienTai: 3, kyTruoc: null },
    ]);
  });
  it("kỳ trước null ⇒ toàn null; kỳ trước dài hơn ⇒ cắt theo kỳ này", () => {
    expect(ghepKyTruoc([1, 2], null)).toEqual([
      { hienTai: 1, kyTruoc: null },
      { hienTai: 2, kyTruoc: null },
    ]);
    expect(ghepKyTruoc([1], [7, 8])).toEqual([{ hienTai: 1, kyTruoc: 7 }]);
  });
});
