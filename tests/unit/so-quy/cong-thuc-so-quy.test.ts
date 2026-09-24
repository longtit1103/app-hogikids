import { describe, expect, it } from "vitest";

import {
  ghepSoQuyThang,
  thuChiTuTong,
  tinhQuyTuTong,
  TONG_RONG,
  type TongNguon,
  nhanCuoiKySoQuy,
} from "@/lib/so-quy/cong-thuc-so-quy";

// Fixture mẫu (đơn vị đồng): góp 100tr + vay 200tr = vào 300tr · rút vốn 10tr · TikTok PAID 30tr ·
// Shopee WITHDRAWAL −5tr · chi phí 2tr (ads TikTok) + 1tr (ads Meta) + 40tr (Nhập hàng) = 43tr ·
// TiktokAdsSettlement −1,5tr ⇒ QUY = 300 − 10 + 30 + 5 − 43 + 1,5 = 283,5tr.
const T: TongNguon = {
  ghiTayVao: 300_000_000,
  ghiTayRa: 10_000_000,
  tiktokVeBank: 30_000_000,
  shopeeRutViCoDau: -5_000_000,
  chiPhi: 43_000_000,
  adsTiktokViCoDau: -1_500_000,
  thuNhap: 0,
  banTrucTiep: 0,
};

/** Cùng fixture mẫu nhưng CÓ 8,5tr lãi sổ tiết kiệm đã nhận trong kỳ (bảng `ThuNhap`). */
const T_CO_LAI: TongNguon = { ...T, thuNhap: 8_500_000 };

describe("tinhQuyTuTong", () => {
  it("fixture mẫu ⇒ 283.500.000", () => expect(tinhQuyTuTong(T)).toBe(283_500_000));

  // KHÔNG viết `-10_000_000 + 10_000_000`: TS gộp thành hằng 0 ngay lúc biên dịch nên phép kiểm
  // "rút rồi đảo rút tự triệt tiêu" thành vô nghĩa. Kiểm từng dấu riêng — dấu là thứ dễ sai.
  it("Shopee: rút mang dấu âm ⇒ cộng vào quỹ; dòng đảo rút dương tự trừ lại (không abs)", () => {
    expect(tinhQuyTuTong({ ...TONG_RONG, shopeeRutViCoDau: -5_000_000 })).toBe(5_000_000);
    expect(tinhQuyTuTong({ ...TONG_RONG, shopeeRutViCoDau: 6_000_000 })).toBe(-6_000_000);
  });

  it("ads TikTok trừ ví được CỘNG LẠI: chi phí 2tr, ví trả 1,5tr ⇒ quỹ −0,5tr", () =>
    expect(tinhQuyTuTong({ ...TONG_RONG, chiPhi: 2_000_000, adsTiktokViCoDau: -1_500_000 })).toBe(
      -500_000
    ));

  it("tiền khách trả tại shop (bán trực tiếp) CỘNG vào quỹ, xếp vế THU", () => {
    const t = { ...TONG_RONG, banTrucTiep: 930_000 };
    expect(tinhQuyTuTong(t)).toBe(930_000);
    expect(thuChiTuTong(t)).toEqual({ thu: 930_000, chi: 0 });
  });

  it("thu − chi ≡ số dư", () => {
    const { thu, chi } = thuChiTuTong(T);
    expect(thu - chi).toBe(tinhQuyTuTong(T));
    expect(thu).toBe(336_500_000);
    expect(chi).toBe(53_000_000);
  });
});

describe("ghepSoQuyThang", () => {
  it("ĐẦU KỲ + THU − CHI = CUỐI KỲ", () => {
    const r = ghepSoQuyThang(
      new Date(2026, 9, 1),
      { ...TONG_RONG, ghiTayVao: 50_000_000 },
      T,
      T,
      false
    );
    expect(r.dauKy).toBe(50_000_000);
    expect(r.cuoiKy).toBe(50_000_000 + 283_500_000);
  });

  it("tháng trước D0: mọi số 0, truocMoSo=true", () => {
    const r = ghepSoQuyThang(new Date(2026, 9, 1), TONG_RONG, TONG_RONG, T, true);
    expect(r).toMatchObject({ dauKy: 0, thu: 0, chi: 0, cuoiKy: 0, truocMoSo: true });
  });
});

describe("nguồn thu nhập ngoài bán hàng (ThuNhap)", () => {
  it("lãi tiết kiệm 8.500.000 ⇒ quỹ tăng ĐÚNG 8.500.000 (nguồn dương)", () => {
    expect(tinhQuyTuTong({ ...TONG_RONG, thuNhap: 8_500_000 })).toBe(8_500_000);
  });

  it("fixture mẫu + lãi 8,5tr ⇒ 292.000.000", () => {
    expect(tinhQuyTuTong(T_CO_LAI)).toBe(292_000_000);
  });

  it("ĐẦU KỲ + THU − CHI = CUỐI KỲ vẫn đúng khi có nguồn mới (tách theo DẤU, không theo tên nguồn)", () => {
    const { thu, chi } = thuChiTuTong(T_CO_LAI);
    expect(thu).toBe(345_000_000); // 336,5tr + 8,5tr lãi rơi vào vế THU
    expect(chi).toBe(53_000_000); // vế CHI không đổi
    expect(thu - chi).toBe(tinhQuyTuTong(T_CO_LAI));

    const r = ghepSoQuyThang(
      new Date(2026, 9, 1),
      { ...TONG_RONG, ghiTayVao: 50_000_000 },
      T_CO_LAI,
      T_CO_LAI,
      false
    );
    expect(r.dauKy + r.thu - r.chi).toBe(r.cuoiKy);
    expect(r.cuoiKy).toBe(342_000_000); // 50tr đầu kỳ + 292tr trong kỳ
  });
});

/**
 * Nhãn "Cuối kỳ" dùng chung cho thẻ Quỹ và tab Sổ quỹ. Ca quan trọng là ca nhãn PHẢI đổi: tháng đang
 * chạy mà có khoản ghi ngày sau hôm nay — bỏ vế so hai số hoặc gắn cứng nhãn là ca này đỏ.
 */
describe("nhanCuoiKySoQuy", () => {
  it("tháng hiện tại, cuối kỳ ≠ quỹ hôm nay ⇒ nhãn DỰ KIẾN hết tháng + ghi chú", () => {
    expect(nhanCuoiKySoQuy({ cuoiKy: 90_000_000, quyHomNay: 100_000_000 }, true)).toEqual({
      duKien: true,
      nhan: "Cuối kỳ (dự kiến hết tháng)",
      ghiChu: "đã tính khoản ghi ngày sau hôm nay",
    });
  });

  it("tháng hiện tại nhưng hai số bằng nhau ⇒ nhãn trơn", () => {
    expect(nhanCuoiKySoQuy({ cuoiKy: 100_000_000, quyHomNay: 100_000_000 }, true)).toEqual({
      duKien: false,
      nhan: "Cuối kỳ",
      ghiChu: undefined,
    });
  });

  it("tháng đã qua dù hai số khác nhau ⇒ nhãn trơn (quỹ hôm nay không liên quan kỳ cũ)", () => {
    expect(nhanCuoiKySoQuy({ cuoiKy: 90_000_000, quyHomNay: 100_000_000 }, false).duKien).toBe(false);
  });
});
