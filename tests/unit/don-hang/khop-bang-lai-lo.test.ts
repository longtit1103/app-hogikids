import { describe, expect, it } from "vitest";

import type { BoLocDonHang } from "@/lib/orders/don-hang-kieu-du-lieu";
import { chuThichKhopBangLaiLo, khopBangLaiLo } from "@/lib/orders/khop-bang-lai-lo";

/**
 * Chú thích dưới bốn thẻ số chỉ được nói "khớp bảng Lãi/Lỗ" khi tập đơn đúng bằng tập bảng Lãi/Lỗ cộng
 * (trọn một tháng dương lịch, không kênh, không tìm, không chip), và phải nói ĐÚNG thẻ nào khớp dòng nào:
 *  - đúng tập đơn hợp lệ ⇒ khớp trọn (Lãi đơn = "LN gộp");
 *  - mọi trạng thái ⇒ vẫn khớp, nhưng Lãi đơn = "LN gộp" − "Phí sàn đơn hoàn/hủy" (nêu số);
 *  - đúng tập hoàn/hủy ⇒ chỉ phí sàn đơn hoàn/hủy khớp dòng cùng tên;
 *  - còn lại ⇒ không khớp.
 * Sai một điều kiện mà vẫn khẳng định "khớp" là trấn an sai.
 */
const thangMuoiMot = {
  loai: "khoang" as const,
  from: new Date(2026, 10, 1, 0, 0, 0, 0),
  to: new Date(2026, 10, 30, 23, 59, 59, 999),
  nguon: "mac_dinh" as const,
};

function boLoc(doi: Partial<BoLocDonHang> = {}): BoLocDonHang {
  return { ky: thangMuoiMot, statuses: [], channels: [], q: "", loc: [], sx: "moi", trang: 1, don: null, ...doi };
}

const kieu = (b: BoLocDonHang) => khopBangLaiLo(b).kieu;

describe("khopBangLaiLo", () => {
  it("trọn tháng + đúng tập trạng thái hợp lệ (mọi thứ tự) ⇒ khớp trọn, kèm nhãn tháng", () => {
    expect(khopBangLaiLo(boLoc({ statuses: ["PENDING", "SHIPPING", "COMPLETED"] }))).toEqual({
      kieu: "khop_tron",
      thang: "11/2026",
    });
    expect(kieu(boLoc({ statuses: ["COMPLETED", "PENDING", "SHIPPING"] }))).toBe("khop_tron");
  });

  it("trọn tháng + không lọc trạng thái, hoặc chọn đủ năm ⇒ khớp nhưng Lãi trừ phí sàn đơn hoàn/hủy", () => {
    expect(khopBangLaiLo(boLoc())).toEqual({ kieu: "khop_tru_phi_hoan_huy", thang: "11/2026" });
    expect(kieu(boLoc({ statuses: ["COMPLETED", "SHIPPING", "PENDING", "RETURNED", "CANCELLED"] }))).toBe(
      "khop_tru_phi_hoan_huy",
    );
  });

  it("trọn tháng + đúng tập hoàn/hủy (đường bấm dòng 'Phí sàn đơn hoàn/hủy') ⇒ khớp riêng phí sàn hoàn/hủy", () => {
    expect(kieu(boLoc({ statuses: ["RETURNED", "CANCELLED"] }))).toBe("khop_phi_hoan_huy");
    expect(kieu(boLoc({ statuses: ["CANCELLED", "RETURNED"] }))).toBe("khop_phi_hoan_huy");
  });

  it("một phần tập hợp lệ / một phần tập hoàn-hủy / trộn ⇒ không khớp", () => {
    expect(kieu(boLoc({ statuses: ["COMPLETED"] }))).toBe("khong_khop");
    expect(kieu(boLoc({ statuses: ["RETURNED"] }))).toBe("khong_khop");
    expect(kieu(boLoc({ statuses: ["PENDING", "SHIPPING", "COMPLETED", "RETURNED"] }))).toBe("khong_khop");
  });

  it("có chip / đang tìm / lọc kênh ⇒ không khớp ở cả bốn dạng trạng thái", () => {
    for (const statuses of [[], ["PENDING", "SHIPPING", "COMPLETED"], ["RETURNED", "CANCELLED"]] as BoLocDonHang["statuses"][]) {
      expect(kieu(boLoc({ statuses, loc: ["phi_tam"] }))).toBe("khong_khop");
      expect(kieu(boLoc({ statuses, q: "a" }))).toBe("khong_khop");
      expect(kieu(boLoc({ statuses, channels: ["tiktok"] }))).toBe("khong_khop");
    }
  });

  it("tất cả thời gian / kỳ 7 ngày ⇒ không khớp", () => {
    expect(kieu(boLoc({ ky: { loai: "tat_ca" } }))).toBe("khong_khop");
    const ky = {
      loai: "khoang" as const,
      from: new Date(2026, 10, 21, 0, 0, 0, 0),
      to: new Date(2026, 10, 27, 23, 59, 59, 999),
      nguon: "url" as const,
    };
    expect(kieu(boLoc({ ky }))).toBe("khong_khop");
  });

  it("sắp xếp, trang, đơn đang mở không ảnh hưởng", () => {
    expect(kieu(boLoc({ sx: "tien_cao", trang: 3, don: "x" }))).toBe("khop_tru_phi_hoan_huy");
  });
});

describe("chuThichKhopBangLaiLo — nói đúng thẻ nào khớp dòng nào của bảng Lãi/Lỗ", () => {
  const tron = khopBangLaiLo(boLoc({ statuses: ["PENDING", "SHIPPING", "COMPLETED"] }));
  const macDinh = khopBangLaiLo(boLoc());
  const hoanHuy = khopBangLaiLo(boLoc({ statuses: ["RETURNED", "CANCELLED"] }));

  it("khớp trọn, có quyền giá vốn: Tiền hàng − voucher = Doanh thu · Phí sàn · Tiền sau voucher và phí sàn · Lãi đơn = LN gộp", () => {
    expect(chuThichKhopBangLaiLo(tron, 26_000, true)).toBe(
      "Số trên thẻ khớp bảng Lãi/Lỗ tháng 11/2026: Tiền hàng − voucher = “Doanh thu” · phí sàn = “Phí sàn” · Tiền sau voucher và phí sàn = “Thực nhận từ sàn” · Lãi đơn = “LN gộp”.",
    );
  });

  it("khớp trọn, không quyền giá vốn: không nhắc Lãi đơn / LN gộp", () => {
    const chu = chuThichKhopBangLaiLo(tron, 0, false);
    expect(chu).toBe(
      "Số trên thẻ khớp bảng Lãi/Lỗ tháng 11/2026: Tiền hàng − voucher = “Doanh thu” · phí sàn = “Phí sàn” · Tiền sau voucher và phí sàn = “Thực nhận từ sàn”.",
    );
    expect(chu).not.toMatch(/Lãi đơn|LN gộp/);
  });

  it("mọi trạng thái, có quyền: nêu khoản chênh bằng số", () => {
    expect(chuThichKhopBangLaiLo(macDinh, 26_000, true)).toBe(
      "Số trên thẻ khớp bảng Lãi/Lỗ tháng 11/2026: Tiền hàng − voucher = “Doanh thu” · phí sàn = “Phí sàn” · Tiền sau voucher và phí sàn = “Thực nhận từ sàn” · Lãi đơn = “LN gộp” − “Phí sàn đơn hoàn/hủy” (26.000 ₫).",
    );
  });

  it("mọi trạng thái, không quyền: phí sàn đơn hoàn/hủy khớp dòng cùng tên, không nhắc Lãi", () => {
    const chu = chuThichKhopBangLaiLo(macDinh, 26_000, false);
    expect(chu).toBe(
      "Số trên thẻ khớp bảng Lãi/Lỗ tháng 11/2026: Tiền hàng − voucher = “Doanh thu” · phí sàn = “Phí sàn” · Tiền sau voucher và phí sàn = “Thực nhận từ sàn” · phí sàn đơn hoàn/hủy (26.000 ₫) = “Phí sàn đơn hoàn/hủy”.",
    );
    expect(chu).not.toMatch(/Lãi đơn|LN gộp/);
  });

  it("đúng tập hoàn/hủy: phí sàn đơn hoàn/hủy khớp dòng cùng tên (cả hai nhánh quyền)", () => {
    const mong =
      "Phí sàn đơn hoàn/hủy tháng 11/2026 (26.000 ₫) khớp dòng “Phí sàn đơn hoàn/hủy” của bảng Lãi/Lỗ. Đơn hoàn/hủy không tính vào thẻ Tiền hàng và thẻ Tiền sau voucher và phí sàn.";
    expect(chuThichKhopBangLaiLo(hoanHuy, 26_000, true)).toBe(mong);
    expect(chuThichKhopBangLaiLo(hoanHuy, 26_000, false)).toBe(mong);
  });

  it("không khớp ⇒ null (thẻ dùng câu cảnh báo 'Đang lọc')", () => {
    expect(chuThichKhopBangLaiLo({ kieu: "khong_khop" }, 26_000, true)).toBeNull();
  });
});
