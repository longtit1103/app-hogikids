import { describe, expect, it } from "vitest";

import type { DongDonHang } from "@/lib/orders/don-hang-kieu-du-lieu";
import { laDongLo, oLaiDon, oPhiSan, oSanPham, phanTramCoDau } from "@/lib/orders/o-dong-don-hang";

const NOW = new Date(2026, 10, 27);

/** Một dòng đơn hợp lệ Shopee: tiền hàng 200.000, phí 42.800, lãi 30.000. */
function dong(o: Partial<DongDonHang> = {}): DongDonHang {
  return {
    id: "o1",
    code: "HK-1",
    maSan: "251125P3VX7N1R",
    orderedAt: new Date(2026, 10, 25, 9, 0),
    statusChangedAt: new Date(2026, 10, 26, 9, 0),
    channelId: "shopee",
    channelName: "Shopee",
    channelColor: "#cc785c",
    tenKhach: null,
    sanPhamDau: { ten: "Váy hoa nhí", soLuong: 2 },
    soDongHang: 1,
    tongSoLuong: 2,
    itemsTotal: 200_000,
    discount: 0,
    platformFeeEst: 42_800,
    returnedFee: 0,
    status: "COMPLETED",
    phiTamTinh: false,
    laiDon: 30_000,
    thieuGiaVon: false,
    ...o,
  };
}

describe("oPhiSan", () => {
  it("đơn hợp lệ: số âm + tỉ lệ", () => {
    const o = oPhiSan(dong(), NOW);
    expect(o.so).toBe("−42.800 ₫");
    expect(o.phu).toBe("21,4%");
  });

  it("cờ tạm tính lấy NGUYÊN từ phiTamTinh của server, hàm không tự tính", () => {
    // Phí 1% rõ ràng dưới ngưỡng, nhưng cờ server = false ⇒ vẫn false.
    expect(oPhiSan(dong({ platformFeeEst: 2_000, phiTamTinh: false }), NOW).tamTinh).toBe(false);
    expect(oPhiSan(dong({ phiTamTinh: true }), NOW).tamTinh).toBe(true);
  });

  it("đơn bán trực tiếp phí 0 ⇒ '—'", () => {
    const o = oPhiSan(dong({ channelId: "direct", platformFeeEst: 0, maSan: null }), NOW);
    expect(o.so).toBe("—");
    expect(o.phu).toBe("không phí sàn");
  });

  it("đơn hoàn/hủy sàn giữ phí ⇒ số thực returnedFee", () => {
    const o = oPhiSan(dong({ status: "RETURNED", returnedFee: 12_000 }), NOW);
    expect(o.so).toBe("−12.000 ₫");
    expect(o.phu).toBe("sàn giữ");
  });

  it("đơn hoàn/hủy TikTok returnedFee 0 nhưng sàn còn treo phí ⇒ '0 ₫' + sàn giữ, cờ theo fixture", () => {
    const co = oPhiSan(
      dong({ status: "RETURNED", channelId: "tiktok", orderedAt: new Date(2026, 10, 20), returnedFee: 0, platformFeeEst: 30_000, phiTamTinh: true }),
      NOW,
    );
    expect(co.so).toBe("0 ₫");
    expect(co.phu).toContain("sàn giữ");
    expect(co.tamTinh).toBe(true);

    const khong = oPhiSan(
      dong({ status: "CANCELLED", channelId: "tiktok", orderedAt: new Date(2026, 10, 20), returnedFee: 0, platformFeeEst: 30_000, phiTamTinh: false }),
      NOW,
    );
    expect(khong.tamTinh).toBe(false);
  });

  it("đơn hoàn/hủy không có phí nào ⇒ '—'", () => {
    const o = oPhiSan(dong({ status: "CANCELLED", returnedFee: 0, platformFeeEst: 0 }), NOW);
    expect(o.so).toBe("—");
  });

  it("đơn hủy kênh không phí thật mà returnedFee > 0 ⇒ ô Phí sàn hiện đúng số ô Lãi trừ", () => {
    const d = dong({ status: "CANCELLED", channelId: "facebook", maSan: null, returnedFee: 4_000, platformFeeEst: 0, laiDon: -4_000 });
    expect(oPhiSan(d, NOW)).toMatchObject({ so: "−4.000 ₫", phu: "sàn giữ" });
    expect(oLaiDon(d)).toEqual({ so: "−4.000 ₫", phu: "phí sàn giữ", kieu: "xam" });
  });
});

describe("phanTramCoDau", () => {
  it("âm ⇒ dấu trừ U+2212; ~0 âm ⇒ '0%' (không '−0%'); mẫu 0 ⇒ '—'", () => {
    expect(phanTramCoDau(-12_500, 100_000)).toBe("−12,5%");
    expect(phanTramCoDau(-1, 1_000_000)).toBe("0%");
    expect(phanTramCoDau(15_000, 100_000)).toBe("15%");
    expect(phanTramCoDau(5, 0)).toBe("—");
  });
});

describe("oLaiDon", () => {
  it("lãi dương: số + biên, kiểu thường", () => {
    expect(oLaiDon(dong())).toEqual({ so: "30.000 ₫", phu: "biên 15%", kieu: "thuong" });
  });

  it("lỗ: dấu − trong chữ, kiểu lo, biên âm", () => {
    const o = oLaiDon(dong({ laiDon: -20_000 }));
    expect(o.so).toContain("−20.000");
    expect(o.kieu).toBe("lo");
    expect(o.phu).toBe("biên −10%");
  });

  it("thiếu giá vốn ⇒ cảnh báo, không biên", () => {
    const o = oLaiDon(dong({ thieuGiaVon: true, laiDon: 50_000 }));
    expect(o.kieu).toBe("canh-bao");
    expect(o.phu).toBe("thiếu giá vốn");
    expect(o.so.startsWith("⚠")).toBe(true);
  });

  it("đơn hoàn sàn giữ phí ⇒ xám, không bao giờ đỏ", () => {
    const d = dong({ status: "RETURNED", returnedFee: 12_000, laiDon: -12_000 });
    expect(oLaiDon(d)).toEqual({ so: "−12.000 ₫", phu: "phí sàn giữ", kieu: "xam" });
    expect(laDongLo(d)).toBe(false);
  });

  it("đơn hủy không giữ phí ⇒ '—' + không tính", () => {
    const o = oLaiDon(dong({ status: "CANCELLED", returnedFee: 0, laiDon: 0 }));
    expect(o).toEqual({ so: "—", phu: "không tính", kieu: "xam" });
  });

  it("tiền hàng 0 ⇒ không chia 0, không biên", () => {
    const o = oLaiDon(dong({ itemsTotal: 0, laiDon: 0 }));
    expect(o.phu).toBeNull();
  });
});

describe("laDongLo", () => {
  it("hợp lệ ∧ lãi < 0 ⇒ lỗ", () => {
    expect(laDongLo(dong({ laiDon: -1 }))).toBe(true);
    expect(laDongLo(dong({ laiDon: 0 }))).toBe(false);
    expect(laDongLo(dong({ laiDon: 5_000 }))).toBe(false);
  });
});

describe("oSanPham", () => {
  it("nhiều dòng hàng ⇒ '+N sản phẩm khác'", () => {
    const o = oSanPham(dong({ soDongHang: 3 }));
    expect(o.ten).toBe("Váy hoa nhí");
    expect(o.soLuong).toBe("×2");
    expect(o.phu).toContain("+2 sản phẩm khác");
  });

  it("bán trực tiếp có tên khách ⇒ phụ chứa tên", () => {
    const o = oSanPham(dong({ channelId: "direct", tenKhach: "Chị Hồng", soDongHang: 2 }));
    expect(o.phu).toBe("+1 sản phẩm khác · Chị Hồng");
  });

  it("một dòng, không tên khách ⇒ không dòng phụ", () => {
    expect(oSanPham(dong()).phu).toBeNull();
  });

  it("đơn không có dòng hàng ⇒ '—', không ném lỗi", () => {
    const o = oSanPham(dong({ sanPhamDau: null, soDongHang: 0 }));
    expect(o).toEqual({ ten: "—", soLuong: "", phu: null });
  });
});
