import { describe, expect, it } from "vitest";

import {
  congNgay,
  docNguongTuGiaTri,
  ghepDuBao,
  khoaDaSinh,
  khoanDaGhi,
  khoanDinhKy,
  khoanKyTraNo,
  soDuCuoiNgay,
  type MauDinhKy,
} from "@/lib/so-quy/du-bao-quy";
import type { DongSoQuy } from "@/lib/so-quy/dong-chay-so-quy-types";
import type { KhoanDuKien } from "@/lib/so-quy/du-bao-quy-types";
import { duKienNKy, type KhoanVayLich } from "@/lib/so-quy/lich-tra-no";

/**
 * Lõi THUẦN của biểu đồ quỹ + dự báo "sắp cạn". Mọi số là LITERAL tính tay. Trọng tâm:
 *  - chuỗi số dư cuối ngày LIỀN MẠCH (ngày trống mang số dư ngày trước);
 *  - biên ngày THEO GIỜ VN: 00:30 sáng mai giờ VN là NGÀY MAI (UTC còn là hôm nay);
 *  - kỳ trả nợ quá hạn tính vào HÔM NAY, dồn vào điểm dự báo đầu tiên;
 *  - định kỳ ngày 31 gặp tháng 2 kẹp về cuối tháng, chỉ lần phát sinh SAU hôm nay;
 *  - `cham` = ngày ĐẦU TIÊN số dư < ngưỡng (bằng ngưỡng chưa phải cạn).
 */

const vn = (iso: string) => new Date(`${iso}+07:00`);

const dong = (ngay: Date, thu: number, chi: number, dienGiai = "d"): DongSoQuy => ({
  key: `K:${ngay.toISOString()}:${thu}:${chi}`,
  ngay,
  nguon: "GHI_TAY",
  dienGiai,
  thu,
  chi,
  soDu: 0, // không dùng — chuỗi số dư tự cộng từ thu/chi
});

describe("congNgay", () => {
  it("qua tháng, qua năm, năm nhuận, lùi ngày", () => {
    expect(congNgay("2026-09-24", 1)).toBe("2026-09-25");
    expect(congNgay("2026-09-30", 1)).toBe("2026-10-01");
    expect(congNgay("2026-12-31", 1)).toBe("2027-01-01");
    expect(congNgay("2028-02-28", 1)).toBe("2028-02-29");
    expect(congNgay("2026-09-24", 30)).toBe("2026-10-24");
    expect(congNgay("2026-09-24", -89)).toBe("2026-06-27");
  });

  it("khoá ngày hỏng/không tồn tại ⇒ ném (không lặng lẽ trôi sang tháng sau)", () => {
    expect(() => congNgay("2026-02-31", 1)).toThrow();
    expect(() => congNgay("24/09/2026", 1)).toThrow();
  });
});

describe("soDuCuoiNgay — chuỗi liền mạch", () => {
  it("mỗi ngày đúng một điểm; ngày trống mang số dư ngày trước; nhiều dòng cùng ngày cộng dồn", () => {
    const ds = soDuCuoiNgay(
      10_000_000,
      [
        dong(vn("2026-09-20T09:00:00"), 5_000_000, 0),
        dong(vn("2026-09-20T15:00:00"), 0, 2_000_000),
        dong(vn("2026-09-23T10:00:00"), 0, 1_000_000),
      ],
      "2026-09-19",
      "2026-09-24"
    );
    expect(ds).toEqual([
      { ngay: "2026-09-19", soDu: 10_000_000, duBao: false },
      { ngay: "2026-09-20", soDu: 13_000_000, duBao: false },
      { ngay: "2026-09-21", soDu: 13_000_000, duBao: false },
      { ngay: "2026-09-22", soDu: 13_000_000, duBao: false },
      { ngay: "2026-09-23", soDu: 12_000_000, duBao: false },
      { ngay: "2026-09-24", soDu: 12_000_000, duBao: false },
    ]);
  });

  it("🔴 biên ngày VN: 23:59:59.999 VN vẫn là hôm nay, 00:30 VN hôm sau là NGÀY MAI (UTC còn hôm nay)", () => {
    const ds = soDuCuoiNgay(
      0,
      [
        // 24/09 23:59:59.999 VN = 24/09 16:59:59.999Z
        dong(vn("2026-09-24T23:59:59.999"), 1_000, 0),
        // 25/09 00:30 VN = 24/09 17:30Z — phần ngày UTC là 24 nhưng ngày VN là 25
        dong(vn("2026-09-25T00:30:00"), 20_000, 0),
      ],
      "2026-09-24",
      "2026-09-25"
    );
    expect(ds).toEqual([
      { ngay: "2026-09-24", soDu: 1_000, duBao: false },
      { ngay: "2026-09-25", soDu: 21_000, duBao: false },
    ]);
  });

  it("dòng ngoài cửa sổ ⇒ ném (không lặng lẽ bỏ làm số dư lệch thẻ)", () => {
    expect(() =>
      soDuCuoiNgay(0, [dong(vn("2026-09-26T08:00:00"), 1, 0)], "2026-09-24", "2026-09-25")
    ).toThrow(/ngoài cửa sổ/);
  });
});

describe("khoanDaGhi", () => {
  it("đóng góp có dấu = thu − chi của dòng, ngày theo giờ VN, bỏ dòng 0đ", () => {
    expect(
      khoanDaGhi([
        dong(vn("2026-09-25T00:30:00"), 0, 3_000_000, "Trả gốc"),
        dong(vn("2026-09-26T08:00:00"), 500_000, 0, "Thu khác"),
        dong(vn("2026-09-27T08:00:00"), 0, 0, "rỗng"),
      ])
    ).toEqual([
      { ngay: "2026-09-25", soTien: -3_000_000, moTa: "Trả gốc", loai: "DA_GHI" },
      { ngay: "2026-09-26", soTien: 500_000, moTa: "Thu khác", loai: "DA_GHI" },
    ]);
  });
});

describe("khoanKyTraNo — từ duKienNKy", () => {
  /** Trả gốc cuối kỳ, lãi cố định 1tr/kỳ ⇒ mỗi kỳ trước kỳ cuối chuyển đúng 1tr. Kỳ: 15 hằng tháng. */
  const LICH: KhoanVayLich = {
    kind: "BULLET",
    startDate: new Date(2026, 5, 15),
    firstDueDate: new Date(2026, 6, 15),
    termMonths: 12,
    annualRateBp: 0,
    duNoMoSo: 100_000_000,
    giaiNgan: 0,
    giaiNganNgay: null,
    laiCoDinhMoiKy: 1_000_000,
    tienGuiBatBuocMoiKy: 0,
  };
  const HOM_NAY = vn("2026-09-24T09:00:00");

  const ky = (lastDueHandled: Date | null) =>
    duKienNKy({
      lich: LICH,
      traGoc: [],
      lastDueHandled,
      homNay: HOM_NAY,
      soKy: 6,
      duNoHienTai: 100_000_000,
      tienGuiDangGiu: 0,
      closedAt: null,
    });

  it("🔴 kỳ QUÁ HẠN (15/09 chưa ghi) tính vào HÔM NAY; kỳ 15/10 đúng ngày; kỳ 15/11 ngoài cửa sổ", () => {
    const ra = khoanKyTraNo("VPBank", ky(new Date(2026, 7, 15)), "2026-09-24", "2026-10-24");
    expect(ra).toEqual([
      {
        ngay: "2026-09-24",
        soTien: -1_000_000,
        moTa: "Trả nợ VPBank — kỳ 15/09/2026 (đã tới hạn, chưa ghi)",
        loai: "KY_TRA_NO",
      },
      { ngay: "2026-10-15", soTien: -1_000_000, moTa: "Trả nợ VPBank — kỳ 15/10/2026", loai: "KY_TRA_NO" },
    ]);
  });

  it("kỳ đã đóng dấu (kể cả duyệt TRƯỚC hạn tới 15/10) KHÔNG xuất hiện — nằm ở phần đã ghi", () => {
    const ra = khoanKyTraNo("VPBank", ky(new Date(2026, 9, 15)), "2026-09-24", "2026-10-24");
    expect(ra).toEqual([]);
  });

  it("🔴 tongChuyen ÂM (kỳ cuối: ngân hàng hoàn tiền gửi vượt phần phải nộp) ⇒ khoản DƯƠNG, nhãn đúng chiều", () => {
    const [k] = ky(new Date(2026, 7, 15)); // kỳ 15/09 quá hạn
    const ra = khoanKyTraNo("VPBank", [{ ...k, tongChuyen: -4_000_000 }], "2026-09-24", "2026-10-24");
    expect(ra).toEqual([
      {
        ngay: "2026-09-24",
        soTien: 4_000_000,
        moTa: "VPBank — kỳ 15/09/2026 — ngân hàng hoàn tiền gửi (đã tới hạn, chưa ghi)",
        loai: "KY_TRA_NO",
      },
    ]);
    expect(ra[0].moTa).not.toContain("Trả nợ");
    const [, k2] = ky(new Date(2026, 7, 15)); // kỳ 15/10 chưa tới hạn — không mang đuôi quá hạn
    expect(khoanKyTraNo("VPBank", [{ ...k2, tongChuyen: -1 }], "2026-09-24", "2026-10-24")).toEqual([
      { ngay: "2026-10-15", soTien: 1, moTa: "VPBank — kỳ 15/10/2026 — ngân hàng hoàn tiền gửi", loai: "KY_TRA_NO" },
    ]);
  });

  it("kỳ tongChuyen = 0 bị bỏ (không đổi số dư)", () => {
    const [k] = ky(new Date(2026, 8, 15));
    expect(khoanKyTraNo("X", [{ ...k, tongChuyen: 0 }], "2026-09-24", "2026-10-24")).toEqual([]);
  });
});

describe("khoanDinhKy — từ tháng hiện tại, kẹp cuối tháng", () => {
  const mau = (
    id: string,
    dayOfMonth: number,
    amount = 1_000_000,
    description = "",
    activeFrom: MauDinhKy["activeFrom"] = null
  ): MauDinhKy => ({
    id,
    amount,
    dayOfMonth,
    description,
    activeFrom,
  });

  it("🔴 mẫu có mốc activeFrom ở tháng SAU ⇒ bỏ mọi lần phát sinh trước tháng mốc (bộ sinh không sinh)", () => {
    const ra = khoanDinhKy(
      [mau("moc", 5, 700_000, "", "2026-10-20"), mau("null", 5, 100_000)],
      "2026-09-24",
      "2026-10-24",
      new Set()
    );
    // "null" (không mốc) đến hạn 05/09 chưa sinh ⇒ tính vào hôm nay, và 05/10. "moc" chỉ có 05/10:
    // so theo THÁNG — mốc ngày 20 vẫn tính lần ngày 5 cùng tháng, đúng như bộ sinh.
    expect(ra.map((k) => [k.ngay, k.soTien])).toEqual([
      ["2026-09-24", -100_000],
      ["2026-10-05", -700_000],
      ["2026-10-05", -100_000],
    ]);
  });

  it("🔴 ngày 31 gặp tháng 2 (không nhuận) ⇒ 28/02; tháng 3 ngày 31 vượt cửa sổ ⇒ không có", () => {
    const ra = khoanDinhKy([mau("r31", 31, 5_000_000, "Mặt bằng")], "2027-02-10", "2027-03-12", new Set());
    expect(ra).toEqual([
      { ngay: "2027-02-28", soTien: -5_000_000, moTa: "Chi phí định kỳ — Mặt bằng", loai: "DINH_KY" },
    ]);
  });

  it("năm nhuận ⇒ 29/02", () => {
    const ra = khoanDinhKy([mau("r31", 31)], "2028-02-10", "2028-03-11", new Set());
    expect(ra.map((k) => k.ngay)).toEqual(["2028-02-29"]);
  });

  it("🔴 lần phát sinh ĐÚNG hôm nay / TRƯỚC hôm nay trong tháng hiện tại, CHƯA sinh dòng ⇒ tính vào HÔM NAY", () => {
    const ra = khoanDinhKy(
      [mau("r24", 24, 2_000_000, "Mặt bằng"), mau("r3", 3, 500_000)],
      "2026-09-24",
      "2026-10-24",
      new Set()
    );
    expect(ra).toEqual([
      {
        ngay: "2026-09-24",
        soTien: -2_000_000,
        moTa: "Chi phí định kỳ — Mặt bằng — ngày 24/09/2026 (đến hạn, chưa ghi sổ)",
        loai: "DINH_KY",
      },
      {
        ngay: "2026-09-24",
        soTien: -500_000,
        moTa: "Chi phí định kỳ — ngày 03/09/2026 (đến hạn, chưa ghi sổ)",
        loai: "DINH_KY",
      },
      { ngay: "2026-10-24", soTien: -2_000_000, moTa: "Chi phí định kỳ — Mặt bằng", loai: "DINH_KY" },
      { ngay: "2026-10-03", soTien: -500_000, moTa: "Chi phí định kỳ", loai: "DINH_KY" },
    ]);
  });

  it("đến hạn trong tháng hiện tại mà ĐÃ sinh dòng ⇒ không tính (dòng đó đã nằm trong quỹ hôm nay)", () => {
    const ra = khoanDinhKy(
      [mau("r24", 24), mau("r3", 3)],
      "2026-09-24",
      "2026-10-24",
      new Set([khoaDaSinh("r24", "2026-09-24"), khoaDaSinh("r3", "2026-09-03")])
    );
    expect(ra.map((k) => k.ngay)).toEqual(["2026-10-24", "2026-10-03"]);
  });

  it("tháng TRƯỚC tháng hiện tại không bao giờ xét (dù chưa sinh dòng)", () => {
    // Hôm nay 01/10: lần 03/09, 24/09, 30/09 của tháng 9 chưa sinh — không đòi bù.
    const ra = khoanDinhKy([mau("r3", 3), mau("r24", 24), mau("r30", 30)], "2026-10-01", "2026-10-31", new Set());
    expect(ra.map((k) => k.ngay).sort()).toEqual(["2026-10-03", "2026-10-24", "2026-10-30"]);
    expect(ra.every((k) => !k.moTa.includes("đến hạn"))).toBe(true);
  });

  it("qua năm: cửa sổ 20/12 → 19/01 lấy 25/12 và 05/01", () => {
    // Lần 05/12 đã sinh dòng — chỉ soi phần qua năm.
    const daSinh = new Set([khoaDaSinh("b", "2026-12-05")]);
    const ra = khoanDinhKy([mau("a", 25), mau("b", 5)], "2026-12-20", "2027-01-19", daSinh);
    expect(ra.map((k) => k.ngay).sort()).toEqual(["2026-12-25", "2027-01-05"]);
  });

  it("tháng mà mẫu ĐÃ sinh dòng ⇒ bỏ (bộ sinh không đẻ thêm; dòng đó thuộc phần đã ghi)", () => {
    const ra = khoanDinhKy(
      [mau("r28", 28)],
      "2026-09-24",
      "2026-10-24",
      new Set([khoaDaSinh("r28", "2026-09-05")])
    );
    expect(ra).toEqual([]);
  });

  it("mẫu 0đ bị bỏ; mô tả rỗng ⇒ nhãn chung", () => {
    const ra = khoanDinhKy([mau("z", 26, 0), mau("r", 26, 300_000)], "2026-09-24", "2026-10-24", new Set());
    expect(ra).toEqual([{ ngay: "2026-09-26", soTien: -300_000, moTa: "Chi phí định kỳ", loai: "DINH_KY" }]);
  });
});

describe("ghepDuBao", () => {
  const k = (ngay: string, soTien: number, loai: KhoanDuKien["loai"] = "DA_GHI", moTa = ngay): KhoanDuKien => ({
    ngay,
    soTien,
    moTa,
    loai,
  });

  it("đủ 30 điểm SAU hôm nay, liền mạch, đều là điểm dự báo", () => {
    const r = ghepDuBao({ homNay: "2026-09-24", quyHomNay: 5_000_000, nguong: 0, khoan: [] });
    expect(r.duBao).toHaveLength(30);
    expect(r.duBao[0]).toEqual({ ngay: "2026-09-25", soDu: 5_000_000, duBao: true });
    expect(r.duBao[29]).toEqual({ ngay: "2026-10-24", soDu: 5_000_000, duBao: true });
    expect(r.cham).toBeNull();
    expect(r.thapNhat).toEqual({ ngay: "2026-09-25", soDu: 5_000_000 });
  });

  it("🔴 cham = ngày ĐẦU TIÊN dưới ngưỡng + ĐÚNG các khoản của ngày đó; thapNhat là đáy", () => {
    const r = ghepDuBao({
      homNay: "2026-09-24",
      quyHomNay: 10_000_000,
      nguong: 3_000_000,
      khoan: [
        k("2026-10-10", -2_000_000, "DINH_KY", "Mặt bằng"),
        k("2026-09-30", -4_000_000, "KY_TRA_NO", "Trả nợ"),
        k("2026-10-05", -2_000_000, "DA_GHI", "Chi A"),
        k("2026-10-05", -1_500_000, "KY_TRA_NO", "Trả nợ B"),
        k("2026-10-20", 5_000_000, "DA_GHI", "Góp vốn"),
      ],
    });
    // 10 → 30/09: 6 → 05/10: 2,5 (< 3 — chạm) → 10/10: 0,5 → 20/10: 5,5
    expect(r.cham).toEqual({
      ngay: "2026-10-05",
      soDu: 2_500_000,
      khoan: [k("2026-10-05", -2_000_000, "DA_GHI", "Chi A"), k("2026-10-05", -1_500_000, "KY_TRA_NO", "Trả nợ B")],
    });
    expect(r.thapNhat).toEqual({ ngay: "2026-10-10", soDu: 500_000 });
    // Danh sách khoản xếp cũ → mới.
    expect(r.khoanDuKien.map((x) => x.ngay)).toEqual([
      "2026-09-30",
      "2026-10-05",
      "2026-10-05",
      "2026-10-10",
      "2026-10-20",
    ]);
    expect(r.duBao.find((d) => d.ngay === "2026-10-04")?.soDu).toBe(6_000_000);
    expect(r.duBao.find((d) => d.ngay === "2026-10-24")?.soDu).toBe(5_500_000);
  });

  it("không chạm ⇒ cham null", () => {
    const r = ghepDuBao({
      homNay: "2026-09-24",
      quyHomNay: 10_000_000,
      nguong: 1_000_000,
      khoan: [k("2026-10-01", -8_999_999)],
    });
    expect(r.cham).toBeNull();
    expect(r.thapNhat).toEqual({ ngay: "2026-10-01", soDu: 1_000_001 });
  });

  it("ngưỡng 0: về đúng 0 CHƯA chạm; âm 1 đồng là chạm", () => {
    const ve0 = ghepDuBao({ homNay: "2026-09-24", quyHomNay: 1_000, nguong: 0, khoan: [k("2026-09-28", -1_000)] });
    expect(ve0.cham).toBeNull();
    const am = ghepDuBao({ homNay: "2026-09-24", quyHomNay: 1_000, nguong: 0, khoan: [k("2026-09-28", -1_001)] });
    expect(am.cham).toEqual({ ngay: "2026-09-28", soDu: -1, khoan: [k("2026-09-28", -1_001)] });
  });

  it("🔴 biên hôm nay: khoản NGÀY MAI đổi điểm đầu, KHÔNG đổi quỹ hôm nay; khoản HÔM NAY (quá hạn) dồn vào điểm đầu", () => {
    const mai = ghepDuBao({ homNay: "2026-09-24", quyHomNay: 5_000_000, nguong: 0, khoan: [k("2026-09-25", -1_000_000)] });
    expect(mai.duBao[0]).toEqual({ ngay: "2026-09-25", soDu: 4_000_000, duBao: true });

    const quaHan = k("2026-09-24", -6_000_000, "KY_TRA_NO", "Kỳ quá hạn");
    const r = ghepDuBao({ homNay: "2026-09-24", quyHomNay: 5_000_000, nguong: 0, khoan: [quaHan] });
    expect(r.duBao[0]).toEqual({ ngay: "2026-09-25", soDu: -1_000_000, duBao: true });
    // Chạm ở điểm đầu ⇒ khoản gây ra là khoản quá hạn mang ngày hôm nay.
    expect(r.cham).toEqual({ ngay: "2026-09-25", soDu: -1_000_000, khoan: [quaHan] });
  });

  it("quỹ hôm nay đã dưới ngưỡng, không khoản nào ⇒ chạm ngay điểm đầu, khoản rỗng", () => {
    const r = ghepDuBao({ homNay: "2026-09-24", quyHomNay: 100, nguong: 1_000, khoan: [] });
    expect(r.cham).toEqual({ ngay: "2026-09-25", soDu: 100, khoan: [] });
  });

  it("khoản ngoài [hôm nay, +30] ⇒ ném", () => {
    expect(() =>
      ghepDuBao({ homNay: "2026-09-24", quyHomNay: 0, nguong: 0, khoan: [k("2026-10-25", -1)] })
    ).toThrow();
    expect(() =>
      ghepDuBao({ homNay: "2026-09-24", quyHomNay: 0, nguong: 0, khoan: [k("2026-09-23", -1)] })
    ).toThrow();
  });
});

describe("docNguongTuGiaTri", () => {
  it("chuỗi số hợp lệ ⇒ đã đặt; thiếu/hỏng/âm/quá trần ⇒ 0 + chưa đặt", () => {
    expect(docNguongTuGiaTri("5000000")).toEqual({ nguong: 5_000_000, nguongDaDat: true });
    expect(docNguongTuGiaTri("0")).toEqual({ nguong: 0, nguongDaDat: true });
    for (const hong of [undefined, null, "", "abc", "-5", "1.5", "2000000001", "1e6"]) {
      expect(docNguongTuGiaTri(hong)).toEqual({ nguong: 0, nguongDaDat: false });
    }
  });
});
