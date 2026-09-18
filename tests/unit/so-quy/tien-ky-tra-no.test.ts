import { describe, expect, it } from "vitest";

import { gocDeXuatKep, tienGuiSeNhanLai, tongChuyenNganHang } from "@/lib/so-quy/tien-ky-tra-no";

/**
 * Ca THẬT của chủ shop: 200.000.000đ giải ngân 12/05/2026, 36 kỳ, kỳ đầu 10/06/2026, lãi CỐ ĐỊNH 1.121.096đ/kỳ, gửi tiết kiệm 300.000đ/kỳ,
 * Σ 36 kỳ = 10.800.000đ. Mọi số dưới đây tính TAY từ giấy ngân hàng — không suy lại bằng chính công
 * thức đang kiểm.
 *
 * Vì sao có lưới này: cùng một kỳ cuối từng in HAI con số lệch nhau đúng 10.800.000đ trên CÙNG một
 * màn hình (ô nhập in 201.421.096, thẻ in 190.621.096) — chủ shop không có cách nào biết tin số nào.
 */
const LAI = 1_121_096;
const GUI = 300_000;
const SO_KY = 36;
const GUI_35_KY = 10_500_000;
const GUI_36_KY = 10_800_000;

describe("tienGuiSeNhanLai", () => {
  it("kỳ thường → 0 (chưa tất toán thì ngân hàng chưa trả lại đồng nào)", () => {
    expect(
      tienGuiSeNhanLai({
        termMonths: SO_KY,
        tienGuiDangGiu: 300_000,
        kyThuMay: 2,
        tienGuiKyNay: GUI,
      })
    ).toBe(0);
  });

  it("kỳ CUỐI → Σ đang giữ + phần gửi của chính kỳ này = 10.800.000", () => {
    expect(
      tienGuiSeNhanLai({
        termMonths: SO_KY,
        tienGuiDangGiu: GUI_35_KY,
        kyThuMay: SO_KY,
        tienGuiKyNay: GUI,
      })
    ).toBe(GUI_36_KY);
  });

  it("khoản không có kỳ hạn (thấu chi, vay người thân) → không có kỳ cuối ⇒ 0", () => {
    expect(
      tienGuiSeNhanLai({
        termMonths: null,
        tienGuiDangGiu: GUI_35_KY,
        kyThuMay: SO_KY,
        tienGuiKyNay: GUI,
      })
    ).toBe(0);
  });
});

describe("tongChuyenNganHang — tiền THẬT chuyển cho ngân hàng", () => {
  it("kỳ thường: 1.121.096 + 0 + 300.000 − 0 = 1.421.096", () => {
    expect(
      tongChuyenNganHang({ lai: LAI, goc: 0, tienGui: GUI, tienGuiSeNhanLai: 0 })
    ).toBe(1_421_096);
  });

  it("kỳ 36 (chưa trả gốc tay): 1.121.096 + 200.000.000 + 300.000 − 10.800.000 = 190.621.096", () => {
    const hoan = tienGuiSeNhanLai({
      termMonths: SO_KY,
      tienGuiDangGiu: GUI_35_KY,
      kyThuMay: SO_KY,
      tienGuiKyNay: GUI,
    });
    expect(
      tongChuyenNganHang({
        lai: LAI,
        goc: 200_000_000,
        tienGui: GUI,
        tienGuiSeNhanLai: hoan,
      })
    ).toBe(190_621_096);
  });

  /**
   * Đúng ca comment ở `ky-tra-no-card.tsx` dặn: trả bớt 50.000.000 bằng tay GIỮA kỳ cuối ⇒ dư nợ
   * thật còn 150.000.000 (dư nợ ĐẦU kỳ vẫn là 200.000.000). Gõ Gốc theo dư nợ đầu kỳ là trả thừa
   * đúng 50 triệu.
   */
  it("kỳ 36 sau khi đã trả tay 50.000.000 giữa chừng → 140.621.096", () => {
    const hoan = tienGuiSeNhanLai({
      termMonths: SO_KY,
      tienGuiDangGiu: GUI_35_KY,
      kyThuMay: SO_KY,
      tienGuiKyNay: GUI,
    });
    expect(
      tongChuyenNganHang({
        lai: LAI,
        goc: 150_000_000,
        tienGui: GUI,
        tienGuiSeNhanLai: hoan,
      })
    ).toBe(140_621_096);
  });
});

/**
 * Ô Gốc điền sẵn phải bằng dư nợ THẬT còn lại, không phải dư nợ ĐẦU kỳ. Bốn con số của cùng màn hình
 * kỳ cuối (ô Gốc · chữ hướng dẫn · dòng tổng · hộp xác nhận) từng đá nhau đúng 50.000.000đ vì chỉ
 * mỗi ô Gốc đọc `duNoDauKy`.
 */
describe("gocDeXuatKep — ô Gốc điền sẵn kẹp về dư nợ hiện tại", () => {
  it("kỳ cuối, chưa trả tay đồng nào → giữ nguyên đề xuất 200.000.000", () => {
    expect(gocDeXuatKep({ gocDeXuat: 200_000_000, duNoHienTai: 200_000_000 })).toBe(200_000_000);
  });

  it("kỳ cuối sau khi đã trả tay 50.000.000 giữa chừng → 150.000.000, và tổng ra 140.621.096", () => {
    const goc = gocDeXuatKep({ gocDeXuat: 200_000_000, duNoHienTai: 150_000_000 });
    expect(goc).toBe(150_000_000);

    const hoan = tienGuiSeNhanLai({
      termMonths: SO_KY,
      tienGuiDangGiu: GUI_35_KY,
      kyThuMay: SO_KY,
      tienGuiKyNay: GUI,
    });
    expect(tongChuyenNganHang({ lai: LAI, goc, tienGui: GUI, tienGuiSeNhanLai: hoan })).toBe(
      140_621_096
    );
  });

  it("kỳ THƯỜNG của khoản trả gốc cuối kỳ (đề xuất gốc = 0) → phép kẹp không đổi gì", () => {
    expect(gocDeXuatKep({ gocDeXuat: 0, duNoHienTai: 200_000_000 })).toBe(0);
  });

  it("dư nợ đã về 0 (trả trọn gốc sớm) → ô Gốc điền sẵn 0, không đề xuất trả thêm", () => {
    expect(gocDeXuatKep({ gocDeXuat: 200_000_000, duNoHienTai: 0 })).toBe(0);
  });
});
