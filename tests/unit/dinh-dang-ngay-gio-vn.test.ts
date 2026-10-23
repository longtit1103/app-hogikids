import { describe, expect, it } from "vitest";

import { formatNgayVn } from "@/lib/dinh-dang-ngay-gio-vn";

/**
 * `formatNgayVn` neo giờ Việt Nam bằng `Intl` — kết quả KHÔNG được phụ thuộc múi giờ của máy
 * (trình duyệt của chủ shop có thể đặt TZ khác khi đi nước ngoài).
 */
describe("formatNgayVn", () => {
  // 17:30 UTC ngày 14/10 = 00:30 ngày 15/10 giờ VN (UTC+7, không có DST).
  const qua0hVn = new Date("2026-10-14T17:30:00Z");

  it("sang ngày mới theo giờ VN dù thời điểm UTC còn ở ngày trước", () => {
    expect(formatNgayVn(qua0hVn, "dd/MM/yyyy HH:mm")).toBe("15/10/2026 00:30");
    expect(formatNgayVn(qua0hVn, "dd/MM/yyyy")).toBe("15/10/2026");
    expect(formatNgayVn(qua0hVn, "dd/MM")).toBe("15/10");
    expect(formatNgayVn(qua0hVn, "HH:mm")).toBe("00:30");
  });

  it("đủ các mẫu đang dùng", () => {
    expect(formatNgayVn(qua0hVn, "dd")).toBe("15");
    expect(formatNgayVn(qua0hVn, "MM/yyyy")).toBe("10/2026");
    expect(formatNgayVn(qua0hVn, "yyyy-MM")).toBe("2026-10");
    expect(formatNgayVn(qua0hVn, "yyyy-MM-dd")).toBe("2026-10-15");
    expect(formatNgayVn(qua0hVn, "dd/MM HH:mm")).toBe("15/10 00:30");
    expect(formatNgayVn(qua0hVn, "HH:mm dd/MM")).toBe("00:30 15/10");
    expect(formatNgayVn(qua0hVn, "HH:mm dd/MM/yyyy")).toBe("00:30 15/10/2026");
  });

  it("giờ nửa đêm in 00 (không phải 24) và phút cuối ngày vẫn ở ngày cũ", () => {
    expect(formatNgayVn(new Date("2026-12-31T17:00:00Z"), "dd/MM/yyyy HH:mm")).toBe("01/01/2027 00:00");
    expect(formatNgayVn(new Date("2026-12-31T16:59:00Z"), "dd/MM/yyyy HH:mm")).toBe("31/12/2026 23:59");
  });

  it("nhận cả mốc ms dạng số", () => {
    expect(formatNgayVn(qua0hVn.getTime(), "dd/MM/yyyy HH:mm")).toBe("15/10/2026 00:30");
  });

  it("Date không hợp lệ ném RangeError như format() của date-fns, không in NaN", () => {
    expect(() => formatNgayVn(new Date("không phải ngày"), "dd/MM/yyyy")).toThrow(RangeError);
  });

  it("cùng kết quả bất kể múi giờ của tiến trình", () => {
    const truoc = process.env.TZ;
    try {
      for (const tz of ["America/Los_Angeles", "Pacific/Auckland", "UTC", "Asia/Ho_Chi_Minh"]) {
        process.env.TZ = tz;
        expect(formatNgayVn(qua0hVn, "dd/MM/yyyy HH:mm")).toBe("15/10/2026 00:30");
      }
    } finally {
      if (truoc === undefined) delete process.env.TZ;
      else process.env.TZ = truoc;
    }
  });
});
