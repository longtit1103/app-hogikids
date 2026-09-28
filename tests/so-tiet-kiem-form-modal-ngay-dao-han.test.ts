import { describe, expect, it } from "vitest";

import { ngayDaoHanMacDinh } from "@/components/finance/so-tiet-kiem-form-modal";

/**
 * Ngày đáo hạn ĐỀ XUẤT = ngày gửi + kỳ hạn (spec §5.1) — form điền sẵn, chủ shop sửa được (ngân hàng
 * có thể chốt ngày khác). Đây là điểm bắt buộc "auto-fill CHO ĐÚNG một lần" — sai công thức này là
 * mọi sổ tạo mới đều sai ngày đáo hạn đề xuất.
 */
describe("ngayDaoHanMacDinh", () => {
  it("6 tháng từ 05/09/2026 → 05/03/2027", () => {
    expect(ngayDaoHanMacDinh("2026-09-05", "6")).toBe("2027-03-05");
  });

  it("12 tháng từ 15/01/2026 → 15/01/2027 (qua năm)", () => {
    expect(ngayDaoHanMacDinh("2026-01-15", "12")).toBe("2027-01-15");
  });

  it("thiếu ngày gửi → rỗng", () => {
    expect(ngayDaoHanMacDinh("", "6")).toBe("");
  });

  it("thiếu kỳ hạn → rỗng", () => {
    expect(ngayDaoHanMacDinh("2026-09-05", "")).toBe("");
  });

  it("kỳ hạn 0 (đang gõ dở) → rỗng, không tính ra ngày vô nghĩa", () => {
    expect(ngayDaoHanMacDinh("2026-09-05", "0")).toBe("");
  });
});
