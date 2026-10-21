import { describe, expect, it } from "vitest";

import { deXuatTatToan } from "@/lib/so-quy/lai-thau-chi";
import {
  deXuatKy,
  duKienNKy,
  duNoTai,
  kyChoDuyet,
  laiTheoNgay,
  laLaiNhapGoc,
  type KhoanVayLich,
} from "@/lib/so-quy/lich-tra-no";
import { tongChuyenNganHang } from "@/lib/so-quy/tien-ky-tra-no";

/**
 * Thấu chi "lãi nhập gốc" — phần THUẦN (không DB): ngân hàng CỘNG lãi kỳ vào dư nợ thay vì trừ tài khoản,
 * lãi các kỳ sau tính trên dư nợ đã cộng (lãi kép, theo ngày trên dư nợ từng đoạn).
 *
 * Khoản mẫu: rút 100.000.000 ngày 10/09/2026, 11,75%/năm (1175 bp), thu lãi mùng 1 hàng tháng. Mọi con số
 * là LITERAL tính tay theo `Σ(dư nợ × ngày) × bp / 3.650.000`, làm tròn nửa lên MỘT lần:
 *  - kỳ 01/10: 100.000.000 × 21 ngày × 1175 / 3.650.000 = 676.027,40 ⇒ 676.027
 *  - dư nợ sau kỳ 01/10 (nhập gốc) = 100.676.027
 *  - kỳ 01/11: 100.676.027 × 31 × 1175 / 3.650.000 = 1.004.691,58 ⇒ 1.004.692
 *    (KHÔNG nhập gốc: 100.000.000 × 31 × 1175 / 3.650.000 = 997.945,21 ⇒ 997.945)
 *  - dư nợ sau kỳ 01/11 = 101.680.719; tất toán 15/11: 101.680.719 × 14 × 1175 / 3.650.000 = 458.259,68 ⇒ 458.260
 */

const vn = (ngay: string) => new Date(`${ngay}T00:00:00+07:00`);

const THAU_CHI: KhoanVayLich = {
  kind: "OVERDRAFT",
  startDate: vn("2026-09-10"),
  firstDueDate: vn("2026-10-01"),
  termMonths: null,
  annualRateBp: 1175,
  duNoMoSo: 0,
  giaiNgan: 100_000_000,
  giaiNganNgay: vn("2026-09-10"),
  laiCoDinhMoiKy: null,
  tienGuiBatBuocMoiKy: 0,
  laiNhapGoc: true,
  nhapGoc: [],
};

/** Đã duyệt kỳ 01/10 theo kiểu nhập gốc: dòng `LAI_NHAP_GOC` 676.027 đề 01/10. */
const SAU_KY_1: KhoanVayLich = { ...THAU_CHI, nhapGoc: [{ ngay: vn("2026-10-01"), soTien: 676_027 }] };

describe("laLaiNhapGoc", () => {
  it("chỉ thấu chi bật cờ — cờ trên loại khác bị bỏ qua", () => {
    expect(laLaiNhapGoc(THAU_CHI)).toBe(true);
    expect(laLaiNhapGoc({ ...THAU_CHI, laiNhapGoc: false })).toBe(false);
    expect(laLaiNhapGoc({ kind: "TERM", laiNhapGoc: true })).toBe(false);
  });
});

describe("dư nợ + lãi theo ngày có dòng lãi nhập gốc", () => {
  it("kỳ 01/10 = 676.027 (21 ngày trên 100tr)", () => {
    expect(kyChoDuyet(THAU_CHI, [], null, vn("2026-10-05"))?.lai).toBe(676_027);
  });

  it("dư nợ TĂNG đúng số lãi từ CUỐI ngày kỳ: 30/09 = 100tr, 01/10 = 100.676.027", () => {
    expect(duNoTai(SAU_KY_1, [], vn("2026-09-30"))).toBe(100_000_000);
    expect(duNoTai(SAU_KY_1, [], vn("2026-10-01"))).toBe(100_676_027);
  });

  it("kỳ 01/11 tính lãi trên dư nợ ĐÃ cộng lãi: 1.004.692 (không nhập gốc: 997.945)", () => {
    expect(deXuatKy(SAU_KY_1, [], 2, vn("2026-10-01")).lai).toBe(1_004_692);
    expect(deXuatKy(SAU_KY_1, [], 2, vn("2026-10-01")).duNoDauKy).toBe(100_676_027);
    expect(deXuatKy({ ...THAU_CHI, laiNhapGoc: false }, [], 2, vn("2026-10-01")).lai).toBe(997_945);
  });

  it("dòng lãi nhập gốc GIỮA đoạn là mốc chia đoạn: [25/09, 05/10) = 6 ngày × 100tr + 4 ngày × 100.676.027", () => {
    // (600.000.000 + 402.704.108) × 1175 / 3.650.000 = 322.788,31 ⇒ 322.788
    expect(laiTheoNgay(SAU_KY_1, [], vn("2026-09-25"), vn("2026-10-05"))).toBe(322_788);
  });

  it("tất toán 15/11 sau hai kỳ nhập gốc: gốc = 101.680.719 (gồm lãi đã nhập), lãi đoạn cuối 458.260", () => {
    const sauKy2: KhoanVayLich = {
      ...SAU_KY_1,
      nhapGoc: [...SAU_KY_1.nhapGoc, { ngay: vn("2026-11-01"), soTien: 1_004_692 }],
    };
    const dx = deXuatTatToan(sauKy2, [], vn("2026-11-01"), vn("2026-11-15"));
    expect(dx.goc).toBe(101_680_719);
    expect(dx.soNgay).toBe(14);
    expect(dx.lai).toBe(458_260);
  });

  it("trả bớt gốc cũng trừ vào phần lãi đã nhập: trả 676.027 ngày 01/10 ⇒ dư nợ lại 100tr", () => {
    expect(duNoTai(SAU_KY_1, [{ ngay: vn("2026-10-01"), soTien: 676_027 }], vn("2026-10-02"))).toBe(100_000_000);
  });
});

describe("duKienNKy — bảng dự kiến của khoản nhập gốc", () => {
  const goi = (lich: KhoanVayLich) =>
    duKienNKy({
      lich,
      traGoc: [],
      lastDueHandled: null,
      homNay: vn("2026-09-15"),
      soKy: 3,
      duNoHienTai: 100_000_000,
      tienGuiDangGiu: 0,
      closedAt: null,
    });

  it("lãi cộng vào dư nợ (lãi kép), KHÔNG là tiền chuyển ngân hàng", () => {
    const ky = goi(THAU_CHI);
    expect(ky.map((k) => k.lai)).toEqual([676_027, 1_004_692, 981_985]);
    expect(ky.map((k) => k.laiVaoGoc)).toEqual([676_027, 1_004_692, 981_985]);
    expect(ky.map((k) => k.tongChuyen)).toEqual([0, 0, 0]);
    expect(ky.map((k) => k.duNoSauKy)).toEqual([100_676_027, 101_680_719, 102_662_704]);
  });

  it("khoản KHÔNG nhập gốc giữ y hành vi cũ: lãi trên 100tr, tiền chuyển = lãi, dư nợ đứng yên", () => {
    const ky = goi({ ...THAU_CHI, laiNhapGoc: false });
    expect(ky.map((k) => k.lai)).toEqual([676_027, 997_945, 965_753]);
    expect(ky.map((k) => k.laiVaoGoc)).toEqual([0, 0, 0]);
    expect(ky.map((k) => k.tongChuyen)).toEqual([676_027, 997_945, 965_753]);
    expect(ky.map((k) => k.duNoSauKy)).toEqual([100_000_000, 100_000_000, 100_000_000]);
  });

  it("KHÔNG đụng mảng `nhapGoc` của caller (bản sao)", () => {
    const lich: KhoanVayLich = { ...THAU_CHI, nhapGoc: [] };
    goi(lich);
    expect(lich.nhapGoc).toEqual([]);
  });
});

describe("tongChuyenNganHang", () => {
  it("lãi nhập gốc ⇒ lãi KHÔNG nằm trong tiền chuyển; gốc trả bớt vẫn tính", () => {
    expect(tongChuyenNganHang({ lai: 676_027, goc: 0, tienGui: 0, tienGuiSeNhanLai: 0, laiNhapGoc: true })).toBe(0);
    expect(
      tongChuyenNganHang({ lai: 676_027, goc: 10_000_000, tienGui: 0, tienGuiSeNhanLai: 0, laiNhapGoc: true })
    ).toBe(10_000_000);
    expect(tongChuyenNganHang({ lai: 676_027, goc: 0, tienGui: 0, tienGuiSeNhanLai: 0, laiNhapGoc: false })).toBe(
      676_027
    );
  });
});
