import { describe, expect, it } from "vitest";

import {
  dungSheetXuatDonHang,
  HEADER_XUAT_DON_HANG_CHUNG,
  HEADER_XUAT_DON_HANG_GIA_VON,
} from "@/lib/orders/cot-xuat-excel-don-hang";
import type {
  DongDonHangChe,
  DongXuatDonHang,
  KetQuaXuatDonHang,
} from "@/lib/orders/don-hang-kieu-du-lieu";

/** Hàm ánh xạ dòng truy vấn → sheet Excel đơn hàng (thuần, không database). */

const DON_CHE: DongDonHangChe = {
  id: "o1",
  code: "SP-0001",
  maSan: "2611ABC",
  // 27/11/2026 09:05 giờ VN = 02:05 UTC.
  orderedAt: new Date("2026-11-27T02:05:00.000Z"),
  statusChangedAt: null,
  channelId: "shopee",
  channelName: "Shopee",
  channelColor: "#f60",
  tenKhach: "Nguyễn Văn Khách",
  sanPhamDau: { ten: "Áo thun bé trai", soLuong: 2 },
  soDongHang: 2,
  tongSoLuong: 3,
  itemsTotal: 200_000,
  discount: 10_000,
  platformFeeEst: 50_000,
  returnedFee: 0,
  status: "COMPLETED",
  phiTamTinh: false,
};

const DON_A: DongXuatDonHang = { ...DON_CHE, laiDon: 30_000, thieuGiaVon: false, giaVon: 110_000 };

const DON_HOAN: DongXuatDonHang = {
  ...DON_CHE,
  id: "o2",
  code: "SP-0002",
  status: "RETURNED",
  platformFeeEst: 40_000,
  returnedFee: 12_000,
  statusChangedAt: new Date("2026-11-28T17:30:00.000Z"), // 29/11 00:30 giờ VN
  laiDon: -12_000,
  thieuGiaVon: false,
  giaVon: 0,
};

function quyen(rows: DongXuatDonHang[], vuotTran = false): KetQuaXuatDonHang {
  return { coQuyenGiaVon: true, rows, vuotTran };
}

function che(rows: DongDonHangChe[]): KetQuaXuatDonHang {
  return { coQuyenGiaVon: false, rows, vuotTran: false };
}

describe("dungSheetXuatDonHang — nhánh che giá vốn", () => {
  it("header đúng 14 cột chung, không cột giá vốn/lãi/biên; dòng không mang khoá đó", () => {
    const sheet = dungSheetXuatDonHang(che([DON_CHE]));
    expect(sheet.name).toBe("Don hang");
    expect(sheet.header).toEqual([...HEADER_XUAT_DON_HANG_CHUNG]);
    expect(sheet.header).toHaveLength(14);
    const khoa = [...(sheet.header ?? []), ...sheet.rows.flatMap((r) => Object.keys(r))];
    expect(khoa.filter((k) => /Giá vốn|Lãi|Biên/.test(k))).toEqual([]);
  });

  it("không lọt trường lãi/giá vốn dù dòng đầu vào lỡ mang (đối chiếu giá trị)", () => {
    // Dòng "thừa" trường nhạy cảm — bộ ánh xạ nhánh che chỉ đọc cột chung nên không được in ra.
    const thua = { ...DON_A } as unknown as DongDonHangChe;
    const json = JSON.stringify(dungSheetXuatDonHang(che([thua])).rows);
    expect(json).not.toContain("30000");
    expect(json).not.toContain("110000");
  });

  it("không có tên khách trong file", () => {
    const json = JSON.stringify(dungSheetXuatDonHang(che([{ ...DON_CHE, channelId: "direct" }])).rows);
    expect(json).not.toContain("Nguyễn Văn Khách");
  });
});

describe("dungSheetXuatDonHang — nhánh có quyền giá vốn", () => {
  it("header = 14 cột chung + 4 cột giá vốn, đúng thứ tự", () => {
    const sheet = dungSheetXuatDonHang(quyen([DON_A]));
    expect(sheet.header).toEqual([...HEADER_XUAT_DON_HANG_CHUNG, ...HEADER_XUAT_DON_HANG_GIA_VON]);
    expect(HEADER_XUAT_DON_HANG_GIA_VON).toEqual(["Giá vốn", "Lãi đơn", "Biên %", "Thiếu giá vốn"]);
  });

  it("đơn hợp lệ: Tiền sau voucher và phí sàn = tiền hàng − voucher − phí sàn; lãi, biên, giá vốn đúng; tiền là SỐ", () => {
    const [r] = dungSheetXuatDonHang(quyen([DON_A])).rows;
    expect(r).toMatchObject({
      "Mã đơn": "SP-0001",
      "Mã sàn": "2611ABC",
      Kênh: "Shopee",
      "Trạng thái": "Thành công",
      "Sản phẩm": "Áo thun bé trai",
      "Số dòng hàng": 2,
      "Tổng SL": 3,
      "Tiền hàng": 200_000,
      Voucher: 10_000,
      "Phí sàn": 50_000,
      "Tiền sau voucher và phí sàn": 140_000,
      "Phí tạm tính": "",
      "Giá vốn": 110_000,
      "Lãi đơn": 30_000,
      "Biên %": 15,
      "Thiếu giá vốn": "",
    });
    for (const k of ["Tiền hàng", "Voucher", "Phí sàn", "Tiền sau voucher và phí sàn", "Giá vốn", "Lãi đơn", "Biên %"]) {
      expect(typeof r[k]).toBe("number");
    }
  });

  it("ngày theo giờ VN; Cập nhật null ⇒ chuỗi rỗng", () => {
    const [a, b] = dungSheetXuatDonHang(quyen([DON_A, DON_HOAN])).rows;
    expect(a["Ngày đặt"]).toBe("27/11/2026 09:05");
    expect(a["Cập nhật"]).toBe("");
    expect(b["Cập nhật"]).toBe("29/11/2026 00:30");
  });

  it("đơn RETURNED: Phí sàn = returnedFee, Tiền sau voucher và phí sàn và Biên % trống, Lãi đơn = −returnedFee", () => {
    const [r] = dungSheetXuatDonHang(quyen([DON_HOAN])).rows;
    expect(r).toMatchObject({
      "Trạng thái": "Hoàn",
      "Phí sàn": 12_000,
      "Tiền sau voucher và phí sàn": "",
      "Lãi đơn": -12_000,
      "Biên %": "",
    });
  });

  it("đơn CANCELLED cũng dùng returnedFee", () => {
    const [r] = dungSheetXuatDonHang(quyen([{ ...DON_HOAN, status: "CANCELLED" }])).rows;
    expect(r).toMatchObject({ "Trạng thái": "Hủy", "Phí sàn": 12_000, "Tiền sau voucher và phí sàn": "" });
  });

  it("thiếu giá vốn ⇒ cột Thiếu giá vốn = Có, Biên % trống", () => {
    const [r] = dungSheetXuatDonHang(quyen([{ ...DON_A, thieuGiaVon: true, giaVon: 0, laiDon: 140_000 }])).rows;
    expect(r).toMatchObject({ "Thiếu giá vốn": "Có", "Biên %": "", "Lãi đơn": 140_000 });
  });

  it("biên % làm tròn 1 số lẻ; tiền hàng 0 ⇒ biên trống (không chia 0)", () => {
    const [a, b] = dungSheetXuatDonHang(
      quyen([
        { ...DON_A, itemsTotal: 300_000, laiDon: 100_000 }, // 33,333… ⇒ 33,3
        { ...DON_A, itemsTotal: 0, discount: 0, platformFeeEst: 0, laiDon: 0, giaVon: 0 },
      ]),
    ).rows;
    expect(a["Biên %"]).toBe(33.3);
    expect(b["Biên %"]).toBe("");
  });

  it("biên % âm làm tròn ĐỐI XỨNG với dương; lỗ rất nhỏ ra 0, không ra −0", () => {
    const [duong, am, gan0] = dungSheetXuatDonHang(
      quyen([
        { ...DON_A, itemsTotal: 200_000, laiDon: 24_700 }, // 12,35 ⇒ 12,4
        { ...DON_A, itemsTotal: 200_000, laiDon: -24_700 }, // −12,35 ⇒ −12,4 (không −12,3)
        { ...DON_A, itemsTotal: 1_000_000, laiDon: -1 }, // −0,0001 ⇒ 0
      ]),
    ).rows;
    expect(duong["Biên %"]).toBe(12.4);
    expect(am["Biên %"]).toBe(-12.4);
    expect(Object.is(gan0["Biên %"], 0)).toBe(true);
  });

  it("phí tạm tính ⇒ Có", () => {
    const [r] = dungSheetXuatDonHang(quyen([{ ...DON_A, phiTamTinh: true }])).rows;
    expect(r["Phí tạm tính"]).toBe("Có");
  });

  it("mã sàn null ⇒ rỗng; không sản phẩm đầu ⇒ rỗng", () => {
    const [r] = dungSheetXuatDonHang(quyen([{ ...DON_A, maSan: null, sanPhamDau: null, soDongHang: 0, tongSoLuong: 0 }])).rows;
    expect(r).toMatchObject({ "Mã sàn": "", "Sản phẩm": "", "Số dòng hàng": 0, "Tổng SL": 0 });
  });
});

describe("dungSheetXuatDonHang — chống công thức bảng tính", () => {
  it.each(["=SUM(A1)", "+1", "-1", "@cmd", "\tx", "\rx"])("ô chữ bắt đầu %j được vô hiệu bằng dấu '", (xau) => {
    const [r] = dungSheetXuatDonHang(
      quyen([{ ...DON_A, code: xau, maSan: xau, channelName: xau, sanPhamDau: { ten: xau, soLuong: 1 } }]),
    ).rows;
    for (const k of ["Mã đơn", "Mã sàn", "Kênh", "Sản phẩm"]) expect(r[k]).toBe(`'${xau}`);
  });

  it("số âm KHÔNG bị thêm dấu '; chữ thường giữ nguyên", () => {
    const [r] = dungSheetXuatDonHang(quyen([DON_HOAN])).rows;
    expect(r["Lãi đơn"]).toBe(-12_000);
    expect(r["Mã đơn"]).toBe("SP-0002");
  });
});

describe("dungSheetXuatDonHang — rỗng", () => {
  it("nhánh quyền rows rỗng ⇒ vẫn có header, 0 dòng", () => {
    const sheet = dungSheetXuatDonHang(quyen([]));
    expect(sheet.header).toHaveLength(18);
    expect(sheet.rows).toHaveLength(0);
  });

  it("nhánh che rows rỗng ⇒ vẫn có header 14 cột, 0 dòng", () => {
    const sheet = dungSheetXuatDonHang(che([]));
    expect(sheet.header).toHaveLength(14);
    expect(sheet.rows).toHaveLength(0);
  });
});
