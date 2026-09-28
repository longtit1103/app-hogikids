import { describe, expect, it } from "vitest";

import {
  lyDoKhongKhoiPhuc,
  type TinhTrangKhoiPhuc,
} from "@/lib/thung-rac/ly-do-khong-khoi-phuc";

/**
 * 7 lý do từ chối khôi phục. Câu chữ là HỢP ĐỒNG với người dùng (màn thùng rác làm mờ nút bằng chính
 * vị từ này) nên so khớp CHÍNH XÁC: đổi câu mà không đổi test là hai nơi nói hai kiểu.
 */

const SACH: TinhTrangKhoiPhuc = {
  daKhoiPhuc: false,
  idDaTonTaiLai: false,
  refIdBiChiem: null,
  chaDaMat: null,
  chaDaTatToan: null,
  thangDaCoDinhKy: false,
  seLamAmSoDu: null,
};

describe("lyDoKhongKhoiPhuc", () => {
  it("không vướng gì → khôi phục được", () => {
    expect(lyDoKhongKhoiPhuc(SACH)).toBeNull();
  });

  it("đã khôi phục rồi", () => {
    expect(lyDoKhongKhoiPhuc({ ...SACH, daKhoiPhuc: true })).toBe("Mục này đã được khôi phục");
  });

  it("id cũ đã có chủ mới", () => {
    expect(lyDoKhongKhoiPhuc({ ...SACH, idDaTonTaiLai: true })).toBe(
      "Bản ghi này đã tồn tại lại trong sổ"
    );
  });

  it("khoá chống trùng đang thuộc dòng khác — câu báo phải NÊU ĐÍCH DANH khoá đó", () => {
    expect(lyDoKhongKhoiPhuc({ ...SACH, refIdBiChiem: "LOAN:loan-1:2026-06-12" })).toBe(
      'Khoá chống trùng "LOAN:loan-1:2026-06-12" đang thuộc một dòng khác'
    );
  });

  it.each([
    ["category", "Danh mục gốc đã bị xoá — khôi phục cái đó trước"],
    ["channel", "Kênh gốc đã bị xoá — khôi phục cái đó trước"],
    ["loan", "Khoản vay gốc đã bị xoá — khôi phục cái đó trước"],
    ["savings", "Sổ tiết kiệm gốc đã bị xoá — khôi phục cái đó trước"],
  ] as const)("cha %s đã mất → chỉ đúng cái phải khôi phục trước", (chaDaMat, cau) => {
    expect(lyDoKhongKhoiPhuc({ ...SACH, chaDaMat })).toBe(cau);
  });

  /**
   * Cha CÒN SỐNG nhưng đã chốt sổ. Mọi đường ghi khác đều chặn ca này; câu phải chỉ đúng đường gỡ
   * (mở lại cha) chứ không chỉ nói "không được".
   */
  it.each([
    ["loan", "Khoản vay đã tất toán — mở lại khoản vay trước khi khôi phục mục này"],
    ["savings", "Sổ tiết kiệm đã tất toán — mở lại sổ trước khi khôi phục mục này"],
  ] as const)("cha %s đã tất toán → bảo mở lại cha trước", (chaDaTatToan, cau) => {
    expect(lyDoKhongKhoiPhuc({ ...SACH, chaDaTatToan })).toBe(cau);
  });

  it("tháng đó đã có khoản định kỳ thay thế → chặn, nếu không là hai dòng cùng một khoản chi", () => {
    expect(lyDoKhongKhoiPhuc({ ...SACH, thangDaCoDinhKy: true })).toBe(
      "Tháng này đã có khoản định kỳ thay thế — xoá dòng đó trước khi khôi phục mục này"
    );
  });

  it.each([
    [
      "duNo",
      "Khôi phục sẽ làm dư nợ khoản vay âm — phần gốc này đã được trả bằng dòng khác, xoá dòng đó trước",
    ],
    [
      "tienGui",
      "Khôi phục sẽ làm tiền gửi ngân hàng đang giữ âm — phần gửi này đã được nhận lại bằng dòng khác, xoá dòng đó trước",
    ],
    [
      "soDuTietKiem",
      "Khôi phục sẽ làm số đang gửi ở sổ tiết kiệm âm — phần gốc này đã được nhận lại bằng dòng khác, xoá dòng đó trước",
    ],
  ] as const)("khôi phục sẽ làm trục %s âm", (seLamAmSoDu, cau) => {
    expect(lyDoKhongKhoiPhuc({ ...SACH, seLamAmSoDu })).toBe(cau);
  });

  /**
   * THỨ TỰ có nghĩa: mục đã khôi phục thì id cũ ĐƯƠNG NHIÊN tồn tại lại (chính bản ghi vừa dựng) —
   * báo "đã tồn tại lại trong sổ" ở ca đó là đổ lỗi cho người dùng về việc chính app vừa làm.
   */
  it("đã khôi phục thắng mọi lý do khác", () => {
    expect(
      lyDoKhongKhoiPhuc({
        daKhoiPhuc: true,
        idDaTonTaiLai: true,
        refIdBiChiem: "TIETKIEM:so-1",
        chaDaMat: "savings",
        chaDaTatToan: "savings",
        thangDaCoDinhKy: true,
        seLamAmSoDu: "duNo",
      })
    ).toBe("Mục này đã được khôi phục");
  });

  /** Cha MẤT HẲN thắng cha ĐÃ TẤT TOÁN: không có cha thì `closedAt` còn chẳng đọc được. */
  it("cha đã mất thắng cha đã tất toán", () => {
    expect(lyDoKhongKhoiPhuc({ ...SACH, chaDaMat: "loan", chaDaTatToan: "savings" })).toBe(
      "Khoản vay gốc đã bị xoá — khôi phục cái đó trước"
    );
  });
});
