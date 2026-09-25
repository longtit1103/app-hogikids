import { describe, expect, it } from "vitest";

import {
  tinhViTiktokConLaiToiThieu,
  type LenhRutVi,
  type TienVaoVi,
} from "@/lib/vi-san/vi-tiktok-con-lai-toi-thieu";

/** Ngày giờ VN (setup ép TZ=Asia/Ho_Chi_Minh). */
const ngay = (d: number, m: number, gio = 12) => new Date(2026, m - 1, d, gio);
const vao = (d: number, m: number, soTien: number, gio?: number): TienVaoVi => ({
  thoiDiem: ngay(d, m, gio),
  soTien,
});
const rut = (d: number, m: number, soTien: number, trangThai = "PAID", gio?: number): LenhRutVi => ({
  thoiDiem: ngay(d, m, gio),
  soTien,
  trangThai,
});

describe("tinhViTiktokConLaiToiThieu — cận dưới số dư ví TikTok", () => {
  it("chưa có statement nào ⇒ null (ẩn ô, không in 0 ₫ như thật)", () => {
    expect(tinhViTiktokConLaiToiThieu([], [], null)).toBeNull();
    // Có lệnh rút mà không có tiền vào nào: vẫn là chưa đồng bộ statement, không suy số.
    expect(tinhViTiktokConLaiToiThieu([], [rut(2, 1, 5_000_000)], ngay(1, 1, 0))).toBeNull();
  });

  it("chuỗi luôn ≥ 0 ⇒ B0 = 0, ví = Σ vào − Σ rút", () => {
    const kq = tinhViTiktokConLaiToiThieu(
      [vao(1, 2, 10_000_000), vao(3, 2, 5_000_000)],
      [rut(4, 2, 12_000_000)],
      null
    );
    expect(kq).toEqual({ b0ToiThieu: 0, viHienTai: 3_000_000, tangTuD0: null });
  });

  it("đáy chuỗi âm ⇒ B0 = −đáy, ví hiện tại = B0 + cuối chuỗi (kẹp ≥ 0)", () => {
    // +10 → −20 (rút 30, đáy −20) → −15 → −25 (rút 10, đáy mới) → −5
    const kq = tinhViTiktokConLaiToiThieu(
      [vao(1, 1, 10_000_000), vao(5, 1, 5_000_000), vao(9, 1, 20_000_000)],
      [rut(2, 1, 30_000_000), rut(6, 1, 10_000_000)],
      null
    );
    expect(kq).toEqual({ b0ToiThieu: 25_000_000, viHienTai: 20_000_000, tangTuD0: null });
  });

  it("lệnh rút FAILED bị bỏ; lệnh đang xử lý (≠ FAILED) vẫn trừ", () => {
    const kq = tinhViTiktokConLaiToiThieu(
      [vao(1, 3, 8_000_000)],
      [rut(2, 3, 100_000_000, "FAILED"), rut(3, 3, 3_000_000, "PROCESSING")],
      null
    );
    expect(kq).toEqual({ b0ToiThieu: 0, viHienTai: 5_000_000, tangTuD0: null });
  });

  it("tangTuD0 chỉ cộng sự kiện từ D0 (tính cả đúng mốc D0); sự kiện trước D0 vẫn vào ví + đáy", () => {
    const d0 = ngay(12, 5, 0);
    const kq = tinhViTiktokConLaiToiThieu(
      [vao(1, 5, 50_000_000), vao(12, 5, 7_000_000, 0), vao(20, 5, 3_000_000)],
      [rut(2, 5, 60_000_000), rut(11, 5, 1_000_000, "PAID", 23), rut(25, 5, 4_000_000)],
      d0
    );
    // Chuỗi: +50 → −10 (đáy) → −11 (đáy) → −4 → −1 → −5 ⇒ B0 = 11, ví = 6.
    // Từ D0: +7 + 3 − 4 = +6 (lệnh rút 23h ngày 11/05 nằm TRƯỚC mốc D0).
    expect(kq).toEqual({ b0ToiThieu: 11_000_000, viHienTai: 6_000_000, tangTuD0: 6_000_000 });
  });

  it("tangTuD0 có thể âm (rút nhiều hơn chốt từ D0) — không kẹp", () => {
    const kq = tinhViTiktokConLaiToiThieu(
      [vao(1, 4, 20_000_000), vao(15, 5, 2_000_000)],
      [rut(20, 5, 9_000_000)],
      ngay(12, 5, 0)
    );
    expect(kq).toEqual({ b0ToiThieu: 0, viHienTai: 13_000_000, tangTuD0: -7_000_000 });
  });

  it("tự trộn + sắp theo thời gian hai chuỗi đưa vào lộn xộn — thứ tự đầu vào không đổi kết quả", () => {
    const vaoSapXep = [vao(1, 6, 10_000_000), vao(3, 6, 10_000_000), vao(5, 6, 10_000_000)];
    const rutSapXep = [rut(2, 6, 15_000_000), rut(4, 6, 15_000_000)];
    const chuan = tinhViTiktokConLaiToiThieu(vaoSapXep, rutSapXep, null);
    // +10 → −5 (đáy) → +5 → −10 (đáy) → 0 ⇒ B0 = 10, ví = 10.
    expect(chuan).toEqual({ b0ToiThieu: 10_000_000, viHienTai: 10_000_000, tangTuD0: null });

    const lonXon = tinhViTiktokConLaiToiThieu(
      [...vaoSapXep].reverse(),
      [...rutSapXep].reverse(),
      null
    );
    expect(lonXon).toEqual(chuan);
    // Cộng hai chuỗi NỐI TIẾP (mọi vào rồi mới rút) sẽ ra B0 = 0 — sai; ca này bắt lỗi quên trộn.
    expect(lonXon!.b0ToiThieu).not.toBe(0);
  });

  it("cùng thời điểm: tiền vào tính TRƯỚC lệnh rút (B0 nhỏ nhất vẫn hợp lệ)", () => {
    const kq = tinhViTiktokConLaiToiThieu([vao(1, 7, 5_000_000)], [rut(1, 7, 5_000_000)], null);
    expect(kq).toEqual({ b0ToiThieu: 0, viHienTai: 0, tangTuD0: null });
  });

  it("lô statement CÙNG một giây được gộp trước khi so đáy — thứ tự dòng trong lô không đổi B0", () => {
    // Lô 18/03 prod: dòng âm lẫn dương ghi có cùng giây. Xét từng dòng thì đáy tuỳ thứ tự DB trả về.
    const lo = [vao(1, 3, -3_000_000, 9), vao(1, 3, 5_000_000, 9)];
    const truocLo = [vao(28, 2, 1_000_000)];
    const amTruoc = tinhViTiktokConLaiToiThieu([...truocLo, ...lo], [], null);
    const duongTruoc = tinhViTiktokConLaiToiThieu([...truocLo, ...[...lo].reverse()], [], null);
    expect(amTruoc).toEqual({ b0ToiThieu: 0, viHienTai: 3_000_000, tangTuD0: null });
    expect(duongTruoc).toEqual(amTruoc);
  });

  it("statement net âm (phí/hoàn/ads sàn trừ ví) kéo đáy xuống như một khoản rút", () => {
    const kq = tinhViTiktokConLaiToiThieu(
      [vao(1, 8, -2_000_000), vao(2, 8, 5_000_000)],
      [],
      null
    );
    expect(kq).toEqual({ b0ToiThieu: 2_000_000, viHienTai: 5_000_000, tangTuD0: null });
  });
});
