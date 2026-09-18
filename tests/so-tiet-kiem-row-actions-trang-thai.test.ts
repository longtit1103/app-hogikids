import { describe, expect, it } from "vitest";

import { soDaDenHan, trangThaiKhoaXoaTuRow } from "@/components/finance/so-tiet-kiem-row-actions";

/**
 * Map `SoTietKiemRow` → `TrangThaiKhoaXoa` (đầu vào của `lyDoKhongXoaSoTietKiem`, Phase 02). Đây là
 * cầu nối DUY NHẤT giữa dữ liệu hiển thị và vị từ xoá dùng chung với server (`xoaSoTietKiem`) — sai
 * một nhánh là menu ⋯ hứa xoá được trong khi server từ chối, hoặc ngược lại.
 */
describe("trangThaiKhoaXoaTuRow", () => {
  it("đang gửi, chưa có lãi, không dòng ghi tay → cả ba false", () => {
    expect(trangThaiKhoaXoaTuRow({ closedAt: null, laiThucNhan: null, coDongGhiTay: false })).toEqual({
      daTatToan: false,
      coThuNhap: false,
      coDongGhiTay: false,
    });
  });

  it("đã tất toán, lãi > 0 → daTatToan và coThuNhap true", () => {
    expect(
      trangThaiKhoaXoaTuRow({ closedAt: new Date(2027, 2, 5), laiThucNhan: 5_157_260, coDongGhiTay: false })
    ).toEqual({ daTatToan: true, coThuNhap: true, coDongGhiTay: false });
  });

  it("đã tất toán nhưng lãi = 0 → coThuNhap FALSE (không có bản ghi ThuNhap nào để mất)", () => {
    expect(
      trangThaiKhoaXoaTuRow({ closedAt: new Date(2027, 2, 5), laiThucNhan: 0, coDongGhiTay: false })
    ).toEqual({ daTatToan: true, coThuNhap: false, coDongGhiTay: false });
  });

  it("có dòng ghi tay → coDongGhiTay true, độc lập với daTatToan/coThuNhap", () => {
    expect(trangThaiKhoaXoaTuRow({ closedAt: null, laiThucNhan: null, coDongGhiTay: true })).toEqual({
      daTatToan: false,
      coThuNhap: false,
      coDongGhiTay: true,
    });
  });
});

/**
 * Mục "Tất toán" trong menu ⋯ CHỈ hiện khi sổ đã tới ngày đáo hạn — lúc đó `laiDuKien` (lãi TRỌN
 * KỲ) mới là số ngân hàng thật sự trả. Review đối kháng 17/09 bắt được: bản cũ luôn hiện mục này và
 * điền sẵn lãi trọn kỳ vào ngày HÔM NAY, nên bấm nhầm trên sổ còn 4 tháng nữa mới đáo hạn là ghi
 * thẳng ~4,8 triệu tiền chưa hề nhận vào dòng "Thu nhập tài chính" của P&L lẫn thẻ Quỹ — không cổng
 * nào đỏ vì `ThuNhap` chỉ cần > 0.
 */
describe("soDaDenHan", () => {
  it("đáo hạn ĐÚNG hôm nay → đã tới hạn (không phải 'còn vài tiếng nữa')", () => {
    expect(soDaDenHan(new Date(2027, 2, 5), new Date(2027, 2, 5, 23, 59))).toBe(true);
  });

  it("đáo hạn NGÀY MAI → chưa tới hạn, mục Tất toán phải ẩn", () => {
    expect(soDaDenHan(new Date(2027, 2, 6), new Date(2027, 2, 5))).toBe(false);
  });

  it("quá hạn chưa tất toán → vẫn là đã tới hạn", () => {
    expect(soDaDenHan(new Date(2027, 2, 1), new Date(2027, 2, 5))).toBe(true);
  });
});
