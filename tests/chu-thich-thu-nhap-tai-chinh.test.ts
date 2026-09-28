import { describe, expect, it } from "vitest";

import {
  chuThichBienRongCoThuNhap,
  chuThichBienRongTheoKenh,
} from "@/lib/reports/chu-thich-thu-nhap-tai-chinh";

/**
 * Chú thích biên ròng khi kỳ có thu nhập tài chính. Công thức biên ròng GIỮ NGUYÊN (quyết định
 * chủ shop #10), nên chữ là thứ DUY NHẤT ngăn tháng đáo hạn sổ bị đọc thành "bán hàng đột nhiên
 * lãi hơn". Gom về một module thuần vì ba màn dùng chung (KPI Dashboard, Xu hướng, Kênh) — ba nơi
 * tự viết là ba câu khác nhau cho cùng một chuyện.
 */
describe("chuThichBienRongCoThuNhap", () => {
  it("có thu nhập → câu ngắn kèm số tiền đã format", () => {
    expect(chuThichBienRongCoThuNhap(2_000_000)).toBe("có gồm thu nhập tài chính 2.000.000 ₫");
  });

  it("bằng 0 → null (không hiện chữ thừa mỗi tháng)", () => {
    expect(chuThichBienRongCoThuNhap(0)).toBeNull();
  });

  it("số âm (dữ liệu dị) → null, không in câu ngược nghĩa", () => {
    expect(chuThichBienRongCoThuNhap(-1_000)).toBeNull();
  });
});

describe("chuThichBienRongTheoKenh", () => {
  it("nói ngược lại: biên ròng TỪNG KÊNH không gồm khoản này", () => {
    const s = chuThichBienRongTheoKenh(2_000_000)!;
    expect(s).toContain("KHÔNG gồm");
    expect(s).toContain("2.000.000");
    expect(s).toContain("Lãi/Lỗ");
  });

  it("bằng 0 → null", () => {
    expect(chuThichBienRongTheoKenh(0)).toBeNull();
  });
});
