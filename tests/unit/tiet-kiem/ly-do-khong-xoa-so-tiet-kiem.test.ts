import { describe, expect, it } from "vitest";

import {
  LY_DO_CO_DONG_GHI_TAY,
  lyDoKhongXoaSoTietKiem,
  type TrangThaiKhoaXoa,
} from "@/lib/tiet-kiem/ly-do-khong-xoa-so-tiet-kiem";

/**
 * Vị từ này là NGUỒN DUY NHẤT cho cả hai phía: `xoaSoTietKiem` ném đúng câu nó trả, và menu ⋯ đọc nó
 * để quyết định mở hộp phá huỷ hay hộp giải thích. Lệch một ca là chủ shop thấy hộp hứa "xoá được —
 * không hoàn tác", bấm xong mới ăn toast đỏ.
 */

const NEN: TrangThaiKhoaXoa = { daTatToan: false, coThuNhap: false, coDongGhiTay: false };

describe("lyDoKhongXoaSoTietKiem — một câu duy nhất, thứ tự KHỚP cổng server", () => {
  it("sổ đang gửi, chỉ có dòng gửi do app sinh → xoá được", () => {
    expect(lyDoKhongXoaSoTietKiem(NEN)).toBeNull();
  });

  it("đã tất toán → chặn, và chỉ đúng đường: mở lại sổ trước", () => {
    const lyDo = lyDoKhongXoaSoTietKiem({ ...NEN, daTatToan: true });
    expect(lyDo).toContain("đã tất toán");
    expect(lyDo).toContain("Mở lại");
  });

  it("đã ghi lãi vào Sổ thu nhập → chặn, nói rõ lãi đang nằm trong Lãi/Lỗ", () => {
    const lyDo = lyDoKhongXoaSoTietKiem({ ...NEN, coThuNhap: true });
    expect(lyDo).toContain("Thu nhập tài chính");
    expect(lyDo).not.toContain("Khoản tiền khác");
  });

  it("có dòng ghi tay → chặn bằng ĐÚNG chuỗi server ném, và CHỈ ĐƯỜNG sang bảng Khoản tiền khác", () => {
    expect(lyDoKhongXoaSoTietKiem({ ...NEN, coDongGhiTay: true })).toBe(LY_DO_CO_DONG_GHI_TAY);
    expect(LY_DO_CO_DONG_GHI_TAY).toContain("Khoản tiền khác");
  });

  it("thứ tự cổng: đã tất toán THẮNG cả hai cổng còn lại", () => {
    const lyDo = lyDoKhongXoaSoTietKiem({
      daTatToan: true,
      coThuNhap: true,
      coDongGhiTay: true,
    });
    expect(lyDo).toContain("đã tất toán");
    expect(lyDo).not.toBe(LY_DO_CO_DONG_GHI_TAY);
  });

  it("thứ tự cổng: có thu nhập THẮNG cổng dòng ghi tay", () => {
    const lyDo = lyDoKhongXoaSoTietKiem({ ...NEN, coThuNhap: true, coDongGhiTay: true });
    expect(lyDo).toContain("Thu nhập tài chính");
    expect(lyDo).not.toBe(LY_DO_CO_DONG_GHI_TAY);
  });
});
