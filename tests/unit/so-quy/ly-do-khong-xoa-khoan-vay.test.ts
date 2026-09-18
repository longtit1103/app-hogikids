import { describe, expect, it } from "vitest";

import {
  LY_DO_CO_TIEN_GUI,
  lyDoKhongXoaKhoanVay,
  type TrangThaiKhoaXoa,
} from "@/lib/so-quy/ly-do-khong-xoa-khoan-vay";

/**
 * Vị từ này là NGUỒN DUY NHẤT cho cả hai phía: `xoaKhoanVay` ném đúng câu nó trả, và menu ⋯ đọc nó
 * để quyết định mở hộp phá huỷ hay hộp giải thích. Lệch một ca là chủ shop thấy hộp hứa "xoá được —
 * không hoàn tác", bấm xong mới ăn toast đỏ.
 *
 * Ngõ cụt thật đã xảy ra: khoản trả gốc cuối kỳ có kỳ 1 `goc = 0` nên duyệt kỳ 1 KHÔNG sinh dòng trả
 * gốc — chỉ con dấu kỳ. Lưới dưới khoá đúng bốn trạng thái đó.
 */

const NEN: TrangThaiKhoaXoa = {
  coTraGoc: false,
  daDuyetKy: false,
  mangSang: false,
  coTienGui: false,
};

describe("lyDoKhongXoaKhoanVay — một câu duy nhất cho cả server lẫn menu ⋯", () => {
  it("chưa vướng gì → xoá được", () => {
    expect(lyDoKhongXoaKhoanVay(NEN)).toBeNull();
  });

  it("đã trả gốc → chặn, và câu KHÔNG nói 'đã duyệt kỳ' (khoản có thể chưa duyệt kỳ nào)", () => {
    const lyDo = lyDoKhongXoaKhoanVay({ ...NEN, coTraGoc: true });
    expect(lyDo).toContain("dòng trả gốc");
    expect(lyDo).not.toContain("con dấu kỳ");
  });

  it("duyệt kỳ lãi của khoản trả gốc cuối kỳ (chưa trả đồng gốc nào) → câu nói ĐÚNG sự thật + chỉ đường gỡ", () => {
    const lyDo = lyDoKhongXoaKhoanVay({ ...NEN, daDuyetKy: true });
    // Câu cũ nói "Đã ghi kỳ trả … chỉ tất toán", mà tất toán lại đòi dư nợ 0 ⇒ hai câu vòng vào nhau.
    expect(lyDo).toContain("chưa trả đồng gốc nào");
    expect(lyDo).toContain("Sổ chi phí");
    expect(lyDo).toContain("Tất toán");
  });

  it("khoản mang sang đã duyệt kỳ → thú nhận thẳng là chưa có đường gỡ sạch, KHÔNG bịa lối thoát", () => {
    const lyDo = lyDoKhongXoaKhoanVay({ ...NEN, daDuyetKy: true, mangSang: true });
    expect(lyDo).toContain("chưa có đường gỡ sạch");
    expect(lyDo).not.toContain("dòng giải ngân để xoá ⇒ dư nợ về 0");
  });

  it("chỉ có dòng tiền gửi ghi tay (chưa duyệt kỳ, chưa trả gốc) → chặn bằng ĐÚNG chuỗi server ném", () => {
    expect(lyDoKhongXoaKhoanVay({ ...NEN, coTienGui: true })).toBe(LY_DO_CO_TIEN_GUI);
  });

  it("thứ tự cổng khớp server: đã trả gốc THẮNG cổng tiền gửi", () => {
    // `xoaKhoanVay` xét coTraGoc/daDuyetKy trước, tiền gửi sau. Đảo thứ tự ở đây là hộp nói một câu
    // còn toast đỏ nói câu khác cho cùng một khoản.
    const lyDo = lyDoKhongXoaKhoanVay({ ...NEN, coTraGoc: true, coTienGui: true });
    expect(lyDo).toContain("dòng trả gốc");
    expect(lyDo).not.toBe(LY_DO_CO_TIEN_GUI);
  });

  it("gửi rồi nhận lại HẾT (Σ = 0 nhưng dòng vẫn còn) vẫn chặn — vị từ đếm DÒNG, không cộng tiền", () => {
    expect(lyDoKhongXoaKhoanVay({ ...NEN, coTienGui: true })).not.toBeNull();
  });
});
