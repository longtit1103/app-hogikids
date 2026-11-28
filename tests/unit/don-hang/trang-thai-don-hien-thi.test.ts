import { describe, expect, it } from "vitest";

import { ORDER_STATUS_META } from "@/lib/orders/order-status-meta";
import { TRANG_THAI_HIEN_THI, trangThaiHienThi } from "@/lib/orders/trang-thai-don-hien-thi";
import { MAU_TRANG_THAI } from "@/components/trang-chu/mau-trang-chu";

/** Nhãn + màu trạng thái trang Đơn hàng phải cùng bộ với trang chủ; slug phải khớp bộ đọc URL. */
describe("trạng thái đơn hiển thị", () => {
  it("thứ tự tab: Thành công, Đang giao, Chờ xử lý, Hoàn, Hủy", () => {
    expect(TRANG_THAI_HIEN_THI.map((t) => [t.status, t.nhan])).toEqual([
      ["COMPLETED", "Thành công"],
      ["SHIPPING", "Đang giao"],
      ["PENDING", "Chờ xử lý"],
      ["RETURNED", "Hoàn"],
      ["CANCELLED", "Hủy"],
    ]);
  });

  it("slug lấy từ ORDER_STATUS_META, chấm màu lấy từ MAU_TRANG_THAI", () => {
    for (const t of TRANG_THAI_HIEN_THI) {
      expect(t.slug).toBe(ORDER_STATUS_META[t.status].slug);
      expect(t.mau).toBe(MAU_TRANG_THAI[t.status]);
    }
  });

  it("màu viên thuốc theo bản mẫu đã duyệt", () => {
    expect(trangThaiHienThi("COMPLETED")).toMatchObject({ nen: "#e3f5ea", chu: "#0c5132" });
    expect(trangThaiHienThi("SHIPPING")).toMatchObject({ nen: "#e6effb", chu: "#1d4f91" });
    expect(trangThaiHienThi("PENDING")).toMatchObject({ nen: "#fdf0de", chu: "#7a4f01" });
    expect(trangThaiHienThi("RETURNED")).toMatchObject({ nen: "#f4ebe1", chu: "#6b4420" });
    expect(trangThaiHienThi("CANCELLED")).toMatchObject({ nen: "#fdeaea", chu: "#8e1f0b" });
  });
});
