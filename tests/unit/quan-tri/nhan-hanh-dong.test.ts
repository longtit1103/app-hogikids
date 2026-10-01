import { describe, expect, it } from "vitest";

import { nhanHanhDong, nhanKhoaGhiChu, nhanLyDo } from "@/components/quan-tri/nhan-hanh-dong";
import { HANH_DONG } from "@/lib/nhat-ky/hanh-dong";

describe("nhãn nhật ký", () => {
  it("mọi mã hành động đã khai đều có nhãn tiếng Việt khác mã thô", () => {
    for (const ma of Object.values(HANH_DONG)) expect(nhanHanhDong(ma)).not.toBe(ma);
  });

  it("mã chưa có nhãn hiện mã thô, kể cả tên trùng thuộc tính Object", () => {
    expect(nhanHanhDong("MA_MOI_CHUA_CO")).toBe("MA_MOI_CHUA_CO");
    expect(nhanHanhDong("toString")).toBe("toString");
  });

  it("khoá ghi chú lạ hiện khoá thô", () => {
    expect(nhanKhoaGhiChu("lyDo")).toBe("Lý do");
    expect(nhanKhoaGhiChu("khoaLa")).toBe("khoaLa");
  });

  it("mã lý do cố định (phục hồi chưa thu hồi phiên, bỏ qua kỳ) có nhãn; mã động hiện nguyên văn", () => {
    expect(nhanLyDo("CHUA_THU_HOI_PHIEN_LOI")).toMatch(/KHÔNG thu hồi được phiên/);
    expect(nhanLyDo("CHUA_THU_HOI_PHIEN_MAT_KHOA")).toMatch(/mất khoá/);
    expect(nhanLyDo("BO_QUA_KY")).toBe("Bỏ qua kỳ trả nợ");
    expect(nhanLyDo("P2025")).toBe("P2025");
    expect(nhanLyDo("toString")).toBe("toString");
  });
});
