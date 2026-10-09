import { describe, expect, it } from "vitest";

import {
  duNo,
  kyPhaiTraTai,
  kyTruoc,
  neoTai,
  ngayTrongThang,
  phaiTra,
  type GiaoDichThe,
  type KyNeo,
} from "@/lib/no-phai-tra/ky-sao-ke";

/**
 * Lõi THUẦN kỳ sao kê thẻ tín dụng — bảng số bắt buộc của phase P4 (spec §5.5 + §6, M = 01/11/2026).
 * Đơn vị: ĐỒNG nguyên (3,4 triệu = 3_400_000). Mọi số là LITERAL tính tay. Trọng tâm:
 *  - neo "dư nợ CUỐI NGÀY ngayChot": giao dịch ĐÚNG ngày chốt đã nằm trong neo, không đếm lại;
 *  - biên ngày theo giờ VN (23:59 VN ngày chốt KHÔNG đếm, 00:01 VN hôm sau ĐẾM);
 *  - phần phải trả FIFO: tiền trả ăn phần kỳ cũ trước; tổng hai phần KẸP ≤ trần nghĩa vụ kỳ mới nhất;
 *  - quá hạn so HẠN THẬT với ngày đang xem (đúng ngày hạn = "đến hạn hôm nay", chưa quá hạn).
 */

const vn = (ngay: string) => new Date(`${ngay}T00:00:00+07:00`);
const tr = (trieu: number) => Math.round(trieu * 1_000_000);

const ky = (
  ngayChot: string,
  soDuTrieu: number,
  hanTra: string | null,
  daTraTrieu = 0,
  laNeoMoSo = false,
): KyNeo => ({
  ngayChot: vn(ngayChot),
  soDu: tr(soDuTrieu),
  hanTra: hanTra ? vn(hanTra) : null,
  daTraTruocMoSo: tr(daTraTrieu),
  laNeoMoSo,
});

const chi = (ngay: string, trieu: number): GiaoDichThe => ({ ngay: vn(ngay), soTien: tr(trieu), loai: "CHI" });
const traThe = (ngay: string, trieu: number): GiaoDichThe => ({ ngay: vn(ngay), soTien: tr(trieu), loai: "TRA" });
const viTru = (ngay: string, trieu: number): GiaoDichThe => ({ ngay: vn(ngay), soTien: tr(trieu), loai: "VI_TRU" });

const khoa = (d: Date | null | undefined) => (d ? new Date(d.getTime() + 7 * 3600 * 1000).toISOString().slice(0, 10) : null);

/**
 * Thẻ A theo spec §6: sao kê 25/10 = 12 hạn 10/11, trả trước mở sổ 5; neo mở sổ cuối 31/10 = 9.
 * K1 là kỳ có hạn ⇒ `laNeoMoSo=false` (CHECK `KySaoKeThe_neo_mo_so_khong_han`: neo mở sổ không mang hạn).
 */
const K1 = ky("2026-10-25", 12, "2026-11-10", 5);
const N0 = ky("2026-10-31", 9, null, 0, true);
const K2 = ky("2026-11-25", 4.4, "2026-12-10");
const K3 = ky("2026-12-25", 3.8, "2027-01-10");

const gdDenCa1 = [chi("2026-11-02", 1)];
const gdDenCa2 = [...gdDenCa1, traThe("2026-11-08", 7)];
const gdDenCa3 = [
  ...gdDenCa2,
  chi("2026-11-03", 0.5),
  chi("2026-11-12", 1),
  chi("2026-11-24", 0.5),
  chi("2026-11-25", 1),
  traThe("2026-11-25", 2),
];
const gdDenCa5 = [...gdDenCa3, traThe("2026-11-26", 1)];
const gdDenCa6 = [...gdDenCa5, chi("2026-12-02", 0.4)];
const gdDenCa7 = [...gdDenCa6, traThe("2026-12-28", 2)];

describe("thẻ A — chuỗi spec §6", () => {
  it("ca 1: duNo(02/11) = neo 31/10 + CHI 02/11 = 10; phaiTra(01/11) = 7 toàn phần kỳ mới", () => {
    const kys = [K1, N0];
    expect(duNo(kys, gdDenCa1, vn("2026-11-02"))).toBe(tr(10));
    const p = phaiTra(kys, gdDenCa1, vn("2026-11-01"));
    expect(p?.nghiaVuKy).toBe(tr(7));
    expect(p?.phanTruoc).toBeNull();
    expect(p?.phanMoi?.soTien).toBe(tr(7));
    expect(khoa(p?.phanMoi?.hanTra)).toBe("2026-11-10");
    expect(p?.phanMoi?.quaHan).toBe(false);
  });

  it("ca 2: + TRA 08/11 7 ⇒ phaiTra(09/11) 0/0/0; duNo(09/11) = 3", () => {
    const kys = [K1, N0];
    expect(phaiTra(kys, gdDenCa2, vn("2026-11-09"))).toEqual({ nghiaVuKy: 0, phanTruoc: null, phanMoi: null });
    expect(duNo(kys, gdDenCa2, vn("2026-11-09"))).toBe(tr(3));
  });

  it("ca 3: duNo cuối 25/11 trước chốt = 4,0; sau chốt neo 25/11 = 4,4 (không cộng lại CHI/TRA ngày 25)", () => {
    expect(duNo([K1, N0], gdDenCa3, vn("2026-11-25"))).toBe(tr(4));
    expect(duNo([K1, N0, K2], gdDenCa3, vn("2026-11-25"))).toBe(tr(4.4));
  });

  it("ca 4: xem lại 02/11 sau khi có neo 25/11 vẫn = 10 (neo 31/10)", () => {
    expect(duNo([K1, N0, K2], gdDenCa3, vn("2026-11-02"))).toBe(tr(10));
  });

  it("ca 5: + TRA 26/11 1 ⇒ duNo(26/11) 3,4; phaiTra(26/11) 3,4 / phanTruoc null / phanMoi 3,4", () => {
    const kys = [K1, N0, K2];
    expect(duNo(kys, gdDenCa5, vn("2026-11-26"))).toBe(tr(3.4));
    const p = phaiTra(kys, gdDenCa5, vn("2026-11-26"));
    // kỳ 25/10 đã trả đủ trước chốt 25/11 (12 − 5 − 7 − 2 < 0 ⇒ 0) ⇒ không có phần kỳ cũ
    expect(p?.nghiaVuKy).toBe(tr(3.4));
    expect(p?.phanTruoc).toBeNull();
    expect(p?.phanMoi?.soTien).toBe(tr(3.4));
    expect(khoa(p?.phanMoi?.hanTra)).toBe("2026-12-10");
  });

  it("ca 13 trong chuỗi: chưa sao kê mới, t = 11/12 ⇒ phanMoi 3,4 QUÁ HẠN từ 10/12", () => {
    const p = phaiTra([K1, N0, K2], gdDenCa6, vn("2026-12-11"));
    expect(p?.phanTruoc).toBeNull();
    expect(p?.phanMoi).toMatchObject({ soTien: tr(3.4), quaHan: true, denHanHomNay: false });
    // dư nợ ước tính gồm cả phí 02/12 chưa sao kê: 3,4 + 0,4
    expect(duNo([K1, N0, K2], gdDenCa6, vn("2026-12-11"))).toBe(tr(3.8));
  });

  it("ca 6: chốt 25/12 soDu 3,8 ⇒ phanTruoc 3,4 (hạn 10/12, quá hạn) + phanMoi 0,4 (hạn 10/01)", () => {
    const kys = [K1, N0, K2, K3];
    const p = phaiTra(kys, gdDenCa6, vn("2026-12-26"));
    expect(p?.nghiaVuKy).toBe(tr(3.8));
    expect(p?.phanTruoc).toMatchObject({ soTien: tr(3.4), quaHan: true, denHanHomNay: false });
    expect(khoa(p?.phanTruoc?.hanTra)).toBe("2026-12-10");
    expect(p?.phanMoi).toMatchObject({ soTien: tr(0.4), quaHan: false, denHanHomNay: false });
    expect(khoa(p?.phanMoi?.hanTra)).toBe("2027-01-10");
  });

  it("ca 7: + TRA 28/12 2 ⇒ FIFO phanTruoc 1,4 · phanMoi 0,4 · duNo 1,8", () => {
    const kys = [K1, N0, K2, K3];
    const p = phaiTra(kys, gdDenCa7, vn("2026-12-28"));
    expect(p?.nghiaVuKy).toBe(tr(1.8));
    expect(p?.phanTruoc?.soTien).toBe(tr(1.4));
    expect(p?.phanMoi?.soTien).toBe(tr(0.4));
    expect(duNo(kys, gdDenCa7, vn("2026-12-28"))).toBe(tr(1.8));
  });
});

describe("phần phải trả FIFO + KẸP", () => {
  it("ca 8: kỳ cũ còn 4, kỳ mới gõ soDu 2 ⇒ nghiaVuKy 2, phanTruoc 2, phanMoi null (tổng 2, KHÔNG 4)", () => {
    const kys = [ky("2026-10-25", 4, "2026-11-10"), ky("2026-11-25", 2, "2026-12-10")];
    const p = phaiTra(kys, [], vn("2026-11-26"));
    expect(p?.nghiaVuKy).toBe(tr(2));
    expect(p?.phanTruoc?.soTien).toBe(tr(2));
    expect(p?.phanMoi).toBeNull();
  });

  it("ca 9: kỳ cũ còn 4 hạn 10/11 + kỳ mới 6 hạn 10/12 ⇒ 4 quá hạn + 2; trả 27/11 3 ⇒ 1 + 2", () => {
    const kys = [ky("2026-10-25", 4, "2026-11-10"), ky("2026-11-25", 6, "2026-12-10")];
    const p = phaiTra(kys, [], vn("2026-11-26"));
    expect(p?.phanTruoc).toMatchObject({ soTien: tr(4), quaHan: true });
    expect(p?.phanMoi).toMatchObject({ soTien: tr(2), quaHan: false });

    const sau = phaiTra(kys, [traThe("2026-11-27", 3)], vn("2026-11-27"));
    expect(sau?.nghiaVuKy).toBe(tr(3));
    expect(sau?.phanTruoc?.soTien).toBe(tr(1));
    expect(sau?.phanMoi?.soTien).toBe(tr(2));
  });

  it("ca 13: MỘT kỳ còn 3,4 hạn 10/12 — 09/12 chưa, 10/12 đến hạn hôm nay, 11/12 quá hạn", () => {
    const kys = [ky("2026-11-25", 4.4, "2026-12-10")];
    const gd = [traThe("2026-11-26", 1)];
    expect(phaiTra(kys, gd, vn("2026-12-09"))?.phanMoi).toMatchObject({
      soTien: tr(3.4),
      quaHan: false,
      denHanHomNay: false,
    });
    expect(phaiTra(kys, gd, vn("2026-12-10"))?.phanMoi).toMatchObject({ quaHan: false, denHanHomNay: true });
    expect(phaiTra(kys, gd, vn("2026-12-11"))?.phanMoi).toMatchObject({ quaHan: true, denHanHomNay: false });
  });

  it("ca 14: chốt SỚM 05/12 trước hạn kỳ cũ 10/12 ⇒ phanTruoc 2 KHÔNG quá hạn (hạn thật chưa tới) + phanMoi 3", () => {
    const kys = [ky("2026-11-25", 2, "2026-12-10"), ky("2026-12-05", 5, "2026-12-20")];
    const p = phaiTra(kys, [], vn("2026-12-06"));
    expect(p?.nghiaVuKy).toBe(tr(5));
    expect(p?.phanTruoc).toMatchObject({ soTien: tr(2), quaHan: false, denHanHomNay: false });
    expect(khoa(p?.phanTruoc?.hanTra)).toBe("2026-12-10");
    expect(p?.phanMoi).toMatchObject({ soTien: tr(3), quaHan: false });
    expect(khoa(p?.phanMoi?.hanTra)).toBe("2026-12-20");
  });

  it("chỉ có neo mở sổ (không kỳ nào có hạn) ⇒ phaiTra null — chưa có sao kê để nhắc, khác 'đã trả hết' (nghiaVuKy 0)", () => {
    expect(phaiTra([N0], [traThe("2026-11-05", 1)], vn("2026-11-10"))).toBeNull();
    expect(phaiTra([], [], vn("2026-11-10"))).toBeNull();
  });

  it("kỳ có hạn nhưng ngày chốt SAU t ⇒ chưa áp dụng (null)", () => {
    expect(phaiTra([K2], [], vn("2026-11-24"))).toBeNull();
  });

  it("P_sau tính từ ngày chốt KỲ, không từ neo không hạn đứng sau kỳ", () => {
    // kỳ 25/11 soDu 5; neo 30/11 soDu 3 (không hạn); TRA 27/11 2 nằm giữa kỳ và neo ⇒ vẫn ăn vào kỳ: 5 − 2 = 3
    const kys = [ky("2026-11-25", 5, "2026-12-10"), ky("2026-11-30", 3, null, 0, true)];
    const p = phaiTra(kys, [traThe("2026-11-27", 2)], vn("2026-12-01"));
    expect(p?.nghiaVuKy).toBe(tr(3));
    expect(p?.phanMoi?.soTien).toBe(tr(3));
  });

  it("trả thừa ⇒ nghiaVuKy kẹp 0, không âm", () => {
    expect(phaiTra([ky("2026-11-25", 2, "2026-12-10")], [traThe("2026-11-27", 5)], vn("2026-11-28"))).toEqual({
      nghiaVuKy: 0,
      phanTruoc: null,
      phanMoi: null,
    });
  });
});

describe("dư nợ + neo", () => {
  it("ca 10: không có neo ≤ t ⇒ duNo null", () => {
    expect(duNo([N0], [chi("2026-10-30", 1)], vn("2026-10-30"))).toBeNull();
    expect(duNo([], [], vn("2026-11-01"))).toBeNull();
  });

  it("ca 11: thẻ tạo sau B, neo 30/11 soDu 0 ⇒ duNo(01/12) = 0 + CHI sau neo", () => {
    const kys = [ky("2026-11-30", 0, null, 0, true)];
    const gd = [chi("2026-11-30", 9), chi("2026-12-01", 0.5)];
    expect(duNo(kys, gd, vn("2026-11-30"))).toBe(0);
    expect(duNo(kys, gd, vn("2026-12-01"))).toBe(tr(0.5));
  });

  it("ca 12: quanh neo 25/11 — 23:59 VN ngày chốt KHÔNG đếm, 00:01 VN hôm sau ĐẾM", () => {
    const gd: GiaoDichThe[] = [
      { ngay: new Date("2026-11-25T16:59:00Z"), soTien: 100_000, loai: "CHI" }, // 25/11 23:59 VN
      { ngay: new Date("2026-11-25T17:01:00Z"), soTien: 30_000, loai: "CHI" }, // 26/11 00:01 VN
    ];
    expect(duNo([K2], gd, vn("2026-11-25"))).toBe(tr(4.4));
    expect(duNo([K2], gd, vn("2026-11-26"))).toBe(tr(4.4) + 30_000);
  });

  it("thẻ B (TikTok): neo 6 + ads 30 − ví tự trừ 18 = 18; kỳ 25/10 còn 4 chưa trả ⇒ 11/11 quá hạn từ 10/11", () => {
    const kys = [ky("2026-10-25", 4, "2026-11-10"), ky("2026-10-31", 6, null, 0, true)];
    const gd = [chi("2026-11-01", 10), chi("2026-11-15", 20), viTru("2026-11-10", 8), viTru("2026-11-20", 10)];
    expect(duNo(kys, gd, vn("2026-11-25"))).toBe(tr(18));
    const p = phaiTra(kys, gd, vn("2026-11-11"));
    expect(p?.phanTruoc).toBeNull();
    expect(p?.phanMoi).toMatchObject({ soTien: tr(4), quaHan: true });
  });

  it("ví có dòng hoàn (VI_TRU âm) ⇒ dư nợ tăng lại đúng phần hoàn: 6 + 10 − (8 − 2) = 10", () => {
    // settlement −8 ⇒ VI_TRU +8; settlement +2 (hoàn ads) ⇒ VI_TRU −2
    const gd = [chi("2026-11-05", 10), viTru("2026-11-06", 8), viTru("2026-11-07", -2)];
    expect(duNo([ky("2026-10-31", 6, null, 0, true)], gd, vn("2026-11-08"))).toBe(tr(10));
  });

  it("CHI hoặc TRA âm ⇒ ném (caller quy dấu sai)", () => {
    const kys = [ky("2026-10-31", 6, null, 0, true)];
    expect(() => duNo(kys, [chi("2026-11-05", -1)], vn("2026-11-08"))).toThrow();
    expect(() => duNo(kys, [traThe("2026-11-05", -1)], vn("2026-11-08"))).toThrow();
    expect(() => phaiTra([K2], [traThe("2026-11-27", -1)], vn("2026-11-28"))).toThrow();
  });

  it("neoTai / kyPhaiTraTai / kyTruoc chọn đúng dòng theo khoá ngày VN", () => {
    const kys = [K3, N0, K2, K1]; // cố ý không sắp xếp
    expect(neoTai(kys, vn("2026-11-01"))).toBe(N0);
    expect(neoTai(kys, vn("2026-11-25"))).toBe(K2);
    expect(neoTai(kys, vn("2026-10-24"))).toBeNull();
    expect(kyPhaiTraTai(kys, vn("2026-11-01"))).toBe(K1); // bỏ qua neo mở sổ không hạn
    expect(kyPhaiTraTai(kys, vn("2026-12-31"))).toBe(K3);
    expect(kyTruoc(kys, K3)).toBe(K2);
    expect(kyTruoc(kys, K2)).toBe(K1); // bỏ qua N0 (không hạn)
    expect(kyTruoc(kys, K1)).toBeNull();
  });
});

describe("ca 15: ngayTrongThang — ngày vượt số ngày tháng ⇒ cuối tháng", () => {
  it.each([
    [2027, 2, 31, "2027-02-28"],
    [2028, 2, 31, "2028-02-29"],
    [2026, 4, 31, "2026-04-30"],
    [2026, 11, 10, "2026-11-10"],
    [2026, 12, 31, "2026-12-31"],
  ])("(%i, %i, %i) ⇒ %s", (nam, thang, ngay, kq) => {
    expect(ngayTrongThang(nam, thang, ngay)).toBe(kq);
  });

  it("đầu vào ngoài miền ⇒ ném", () => {
    expect(() => ngayTrongThang(2026, 13, 1)).toThrow();
    expect(() => ngayTrongThang(2026, 1, 0)).toThrow();
  });
});
