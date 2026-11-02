import { describe, expect, it } from "vitest";

import {
  doiChieuSaoKeThe,
  lyDoGiaoDichSaiNgay,
  lyDoTraTheMoHo,
  tomTatDienGiai,
  type BillApp,
} from "@/lib/sao-ke-the/doi-chieu-sao-ke-the";
import type { GiaoDichAppThe } from "@/lib/sao-ke-the/ghep-chi-tra-the-voi-sao-ke";
import { parseSaoKeTechcombank, type DongSaoKe, type SaoKeThe } from "@/lib/sao-ke-the/techcombank-sao-ke-parser";
import { khoaNgayVn } from "@/lib/so-quy/dong-chay-so-quy";

import { docBillFixture, docTextFixture } from "./doc-fixture-sao-ke-the";

/**
 * Đối chiếu sao kê 20/10 với bill TikTok app 10/09→25/10 (số đã gột).
 * Nghiệm thu: số chốt đúng = dư nợ sao kê 32.475.000 + 15 bill ngày 17–20/10 ghi sổ sau ngày sao kê
 * 2.364.000 = 34.839.000.
 */

function saoKe1020(): SaoKeThe {
  const r = parseSaoKeTechcombank(docTextFixture("techcombank-2026-10-20"));
  if (!r.ok) throw new Error(r.loi);
  return r.saoKe;
}

const BILLS = docBillFixture();

describe("doiChieuSaoKeThe — sao kê 20/10, neo trước 14/10", () => {
  const sk = saoKe1020();
  const kq = doiChieuSaoKeThe(sk, BILLS, { ngayChotTruoc: "2026-10-14" });

  it("mọi dòng TikTok trên sao kê đều ghép được bill (kể cả dòng ≤ ngày neo trước)", () => {
    // 348 dòng TikTok đều có bill cùng ngày + cùng tiền; 15 bill ghi sổ trễ KHÔNG nằm trên sao kê
    // nên không trừ vào số khớp.
    expect(kq.khop).toHaveLength(348);
    expect(kq.saoKeKhongCoTrongApp).toHaveLength(0);
    expect(new Set(kq.khop.map((k) => k.billId)).size).toBe(348);
    for (const { dong, billId } of kq.khop) {
      const bill = BILLS.find((b) => b.id === billId)!;
      expect([bill.ngay, bill.soTien]).toEqual([dong.ngayGiaoDich, dong.ghiNo]);
    }
  });

  it("15 bill ghi sổ trễ = 2.364.000 (17/10 ×2 · 19/10 ×5 · 20/10 ×8) ⇒ số đề xuất 34.839.000", () => {
    expect(kq.billGhiSoTre).toHaveLength(15);
    expect(kq.tongBillGhiSoTre).toBe(2_364_000);
    const demNgay = kq.billGhiSoTre.reduce<Record<string, number>>((m, b) => ({ ...m, [b.ngay]: (m[b.ngay] ?? 0) + 1 }), {});
    expect(demNgay).toEqual({ "2026-10-17": 2, "2026-10-19": 5, "2026-10-20": 8 });
    expect(kq.billGhiSoTre.filter((b) => b.ngay === "2026-10-17").map((b) => b.soTien).sort((a, b) => a - b)).toEqual([166_000, 167_000]);
    expect(kq.billKhongThayTrenSaoKe).toHaveLength(0);
    expect(kq.soDeXuat).toBe(34_839_000);
    expect(kq.soDeXuat).toBe(sk.duNoCuoiKy + kq.tongBillGhiSoTre);
  });

  it("dòng khác + thanh toán", () => {
    expect(kq.dongKhac.ghiNo.map((d) => d.ghiNo)).toEqual([978_000, 14_000]);
    expect(kq.dongKhac.ghiCo.map((d) => [d.ngayGiaoDich, d.ghiCo])).toEqual([["2026-10-19", 821_000]]);
    expect(kq.thanhToan.map((d) => d.ghiCo)).toEqual([9_459_000, 6_850_000, 6_850_000, 6_850_000, 6_850_000, 6_850_000]);
  });

  it("giải thích tiếng Việt nêu đủ phép cộng + dòng lạ", () => {
    expect(kq.giaiThich[0]).toBe(
      "Sao kê 32.475.000 ₫ + 15 bill TikTok ngày 17/10 ×2 · 19/10 ×5 · 20/10 ×8 ghi sổ sau ngày sao kê 2.364.000 ₫ = 34.839.000 ₫",
    );
    const tatCa = kq.giaiThich.join("\n");
    expect(tatCa).toContain("DICH VU B *GOI THUE BAO DICHVUB.COM US 978.000 ₫ (26/09)");
    expect(tatCa).toContain("Hoan phi thuong nien");
    expect(tatCa).toContain("6 lần thanh toán thẻ trong kỳ, tổng 43.709.000 ₫");
    expect(tatCa).not.toContain("không thấy trên sao kê");
  });
});

describe("doiChieuSaoKeThe — sao kê 20/10, neo trước 18/09", () => {
  const kq = doiChieuSaoKeThe(saoKe1020(), BILLS, { ngayChotTruoc: "2026-09-18" });

  it("3 bill 02/10 × 196.000 không thấy trên sao kê ⇒ cảnh báo 588.000; bill 17–18/09 thừa (≤ neo) bị bỏ", () => {
    expect(kq.billKhongThayTrenSaoKe.map((b) => [b.ngay, b.soTien])).toEqual([
      ["2026-10-02", 196_000],
      ["2026-10-02", 196_000],
      ["2026-10-02", 196_000],
    ]);
    expect(kq.giaiThich.join("\n")).toContain("3 bill 02/10 ×3 (588.000 ₫) không thấy trên sao kê");
    // 17/09: app 17 bill, sao kê 6 dòng ⇒ 11 bill thừa ≤ 18/09 KHÔNG bị cảnh báo.
    expect(kq.billKhongThayTrenSaoKe.some((b) => b.ngay <= "2026-09-18")).toBe(false);
    expect(kq.billGhiSoTre).toHaveLength(15);
    expect(kq.soDeXuat).toBe(34_839_000);
  });
});

describe("doiChieuSaoKeThe — luật ghép (dữ liệu tổng hợp)", () => {
  const dong = (ngay: string, ghiNo: number, laTiktok = true): DongSaoKe => ({
    ngayGiaoDich: ngay,
    ngayGhiSo: ngay,
    ghiNo,
    ghiCo: 0,
    dienGiai: laTiktok ? "9PAY*TikTok Ads HA NOI VN" : "MUA KHAC",
    laTiktok,
    laThanhToan: false,
  });
  const saoKe = (ds: DongSaoKe[]): SaoKeThe => {
    const tongGhiNo = ds.reduce((s, d) => s + d.ghiNo, 0);
    return {
      nganHang: "TECHCOMBANK",
      ngaySaoKe: "2026-10-20",
      soCuoiThe: "9999",
      hanMuc: 50_000_000,
      duNoKyTruoc: 0,
      tongGhiNo,
      tongGhiCo: 0,
      duNoCuoiKy: tongGhiNo,
      traToiThieu: 0,
      hanTra: "2026-11-05",
      dong: ds,
    };
  };
  const bill = (id: string, ngay: string, soTien: number): BillApp => ({ id, ngay, soTien });

  it("MULTISET: 2 dòng cùng ngày cùng tiền ghép đúng 2 bill khác nhau; không ghép chéo ngày / chéo tiền", () => {
    const kq = doiChieuSaoKeThe(
      saoKe([dong("2026-10-01", 143_000), dong("2026-10-01", 143_000), dong("2026-10-03", 100_000)]),
      [
        bill("b1", "2026-10-01", 143_000),
        bill("b2", "2026-10-01", 143_000),
        bill("b3", "2026-10-01", 143_000), // thừa: không có dòng thứ ba
        bill("b4", "2026-10-02", 100_000), // lệch ngày với dòng 03/10
        bill("b5", "2026-10-03", 100_001), // lệch tiền
      ],
      { ngayChotTruoc: "2026-09-30" },
    );
    expect(kq.khop.map((k) => k.billId)).toEqual(["b1", "b2"]);
    expect(kq.saoKeKhongCoTrongApp.map((d) => [d.ngayGiaoDich, d.ghiNo])).toEqual([["2026-10-03", 100_000]]);
    expect(kq.billKhongThayTrenSaoKe.map((b) => b.id)).toEqual(["b3", "b4", "b5"]);
    expect(kq.giaiThich.join("\n")).toContain("1 dòng TikTok trên sao kê (100.000 ₫) KHÔNG có hoá đơn tương ứng trong app");
  });

  it("dòng không TikTok không ghép với bill dù cùng ngày cùng tiền", () => {
    const kq = doiChieuSaoKeThe(saoKe([dong("2026-10-01", 143_000, false)]), [bill("b1", "2026-10-01", 143_000)], {
      ngayChotTruoc: null,
    });
    expect(kq.khop).toHaveLength(0);
    expect(kq.dongKhac.ghiNo).toHaveLength(1);
    expect(kq.billKhongThayTrenSaoKe.map((b) => b.id)).toEqual(["b1"]);
  });

  it("biên ngày: ≤ neo trước bỏ qua · > ngày sao kê bỏ qua · cửa sổ ghi sổ trễ (ngaySaoKe − n, ngaySaoKe]", () => {
    const bills = [
      bill("neo", "2026-10-10", 1), // = ngayChotTruoc ⇒ bỏ
      bill("canh", "2026-10-15", 2), // = ngaySaoKe − 5 ⇒ KHÔNG trễ ⇒ cảnh báo
      bill("tre1", "2026-10-16", 3), // trễ
      bill("tre2", "2026-10-20", 4), // = ngaySaoKe ⇒ trễ
      bill("sau", "2026-10-21", 5), // kỳ sau ⇒ bỏ
    ];
    const kq = doiChieuSaoKeThe(saoKe([]), bills, { ngayChotTruoc: "2026-10-10" });
    expect(kq.billKhongThayTrenSaoKe.map((b) => b.id)).toEqual(["canh"]);
    expect(kq.billGhiSoTre.map((b) => b.id)).toEqual(["tre1", "tre2"]);
    expect(kq.tongBillGhiSoTre).toBe(7);
    expect(kq.soDeXuat).toBe(7);
    expect(kq.giaiThich[0]).toContain("2 bill TikTok ngày 16/10 · 20/10");

    const kq2 = doiChieuSaoKeThe(saoKe([]), bills, { ngayChotTruoc: "2026-10-10", soNgayGhiSoTre: 4 });
    expect(kq2.billKhongThayTrenSaoKe.map((b) => b.id)).toEqual(["canh", "tre1"]);
    expect(kq2.billGhiSoTre.map((b) => b.id)).toEqual(["tre2"]);
  });

  it("không bill trễ ⇒ số đề xuất = dư nợ sao kê", () => {
    const kq = doiChieuSaoKeThe(saoKe([dong("2026-10-01", 143_000)]), [bill("b1", "2026-10-01", 143_000)], {
      ngayChotTruoc: null,
    });
    expect(kq.soDeXuat).toBe(143_000);
    expect(kq.giaiThich[0]).toBe("Không có bill TikTok ghi sổ trễ — số đề xuất = dư nợ sao kê 143.000 ₫");
  });
});

/**
 * KHOÁ HÀNH VI HIỆN TẠI ở biên nửa đêm: hoá đơn TikTok `createTime` 18/10 23:59:40 VN mang khoá ngày 18/10, ngân hàng in
 * ngày giao dịch 19/10 cùng số tiền. Luật ghép bill hiện là ĐÚNG ngày + đúng tiền ⇒ dòng sao kê "không có trong app" và
 * bill thành "ghi sổ trễ" — số đề xuất CỘNG thừa đúng số đó. Chưa đổi luật (chờ đo lệch ngày trên sao kê thật); test này
 * để lần đổi luật ghép sau này hiện rõ trong diff thay vì trôi im lặng.
 */
describe("doiChieuSaoKeThe — biên nửa đêm bill TikTok (hành vi hiện tại)", () => {
  const dongTiktok = (ngay: string, ghiNo: number): DongSaoKe => ({
    ngayGiaoDich: ngay,
    ngayGhiSo: ngay,
    ghiNo,
    ghiCo: 0,
    dienGiai: "9PAY*TikTok Ads HA NOI VN",
    laTiktok: true,
    laThanhToan: false,
  });
  const saoKe = (ds: DongSaoKe[]): SaoKeThe => {
    const tongGhiNo = ds.reduce((s, d) => s + d.ghiNo, 0);
    return {
      nganHang: "TECHCOMBANK",
      ngaySaoKe: "2026-10-20",
      soCuoiThe: "9999",
      hanMuc: 50_000_000,
      duNoKyTruoc: 0,
      tongGhiNo,
      tongGhiCo: 0,
      duNoCuoiKy: tongGhiNo,
      traToiThieu: 0,
      hanTra: "2026-11-05",
      dong: ds,
    };
  };

  it("khoá ngày của bill = ngày VN của createTime: 23:59:40 ⇒ 18/10, 00:00:20 ⇒ 19/10", () => {
    expect(khoaNgayVn(new Date("2026-10-18T23:59:40+07:00"))).toBe("2026-10-18");
    expect(khoaNgayVn(new Date("2026-10-19T00:00:20+07:00"))).toBe("2026-10-19");
  });

  it("bill 18/10 23:59 vs dòng sao kê ngày GD 19/10 cùng tiền ⇒ KHÔNG ghép; dòng 'không có trong app', bill 'ghi sổ trễ' (cộng thừa)", () => {
    const sk = saoKe([dongTiktok("2026-10-19", 143_000)]);
    const bill: BillApp = { id: "b-nua-dem", ngay: khoaNgayVn(new Date("2026-10-18T23:59:40+07:00")), soTien: 143_000 };
    const kq = doiChieuSaoKeThe(sk, [bill], { ngayChotTruoc: "2026-10-14" });
    expect(kq.khop).toEqual([]);
    expect(kq.saoKeKhongCoTrongApp.map((d) => [d.ngayGiaoDich, d.ghiNo])).toEqual([["2026-10-19", 143_000]]);
    expect(kq.billGhiSoTre.map((b) => b.id)).toEqual(["b-nua-dem"]);
    expect(kq.soDeXuat).toBe(143_000 + 143_000);
  });

  it("cùng cặp nhưng bill 00:00:20 ngày 19/10 ⇒ ghép, số đề xuất = dư nợ sao kê", () => {
    const sk = saoKe([dongTiktok("2026-10-19", 143_000)]);
    const bill: BillApp = { id: "b-sau-nua-dem", ngay: khoaNgayVn(new Date("2026-10-19T00:00:20+07:00")), soTien: 143_000 };
    const kq = doiChieuSaoKeThe(sk, [bill], { ngayChotTruoc: "2026-10-14" });
    expect(kq.khop.map((k) => k.billId)).toEqual(["b-sau-nua-dem"]);
    expect(kq.soDeXuat).toBe(143_000);
  });
});

describe("doiChieuSaoKeThe — sao kê 20/10, neo trước 18/10 (kỳ gõ tay trong cửa sổ ghi sổ trễ)", () => {
  it("bill 17/10 ghi sổ trễ ≤ neo trước nhưng trong cửa sổ trễ VẪN cộng ⇒ đề xuất vẫn 34.839.000", () => {
    const kq = doiChieuSaoKeThe(saoKe1020(), BILLS, { ngayChotTruoc: "2026-10-18" });
    expect(kq.billGhiSoTre).toHaveLength(15);
    expect(kq.billGhiSoTre.filter((b) => b.ngay === "2026-10-17")).toHaveLength(2);
    expect(kq.soDeXuat).toBe(34_839_000);
  });
});

describe("doiChieuSaoKeThe — sao kê 20/10 với giao dịch thẻ như prod (CARD_PAY 19/10 + 23/10)", () => {
  it("lần trả 17/10 trên sao kê ghép CARD_PAY 19/10 (lệch 2 ngày, ≤ ngày sao kê); 23/10 là kỳ sau; trả trước M không nhắc", () => {
    const kq = doiChieuSaoKeThe(saoKe1020(), BILLS, {
      ngayChotTruoc: "2026-10-14",
      mocM: "2026-10-15",
      giaoDichApp: {
        ghiNo: [],
        ghiCo: [
          { id: "p19", ngay: "2026-10-19", soTien: 6_850_000 },
          { id: "p23", ngay: "2026-10-23", soTien: 32_475_000 },
        ],
      },
    });
    expect(kq.soDeXuat).toBe(34_839_000);
    expect(kq.traChuaLenSaoKe).toEqual([]);
    expect(kq.traSaiNgay).toEqual([]);
    expect(kq.thanhToanChuaGhi).toEqual([]);
    expect(lyDoGiaoDichSaiNgay(kq)).toBeNull();
  });

  it("không có CARD_PAY nào ⇒ chỉ nhắc lần trả 17/10 (≥ M, sau neo), 5 lần trả trước M bỏ qua", () => {
    const kq = doiChieuSaoKeThe(saoKe1020(), BILLS, { ngayChotTruoc: "2026-10-14", mocM: "2026-10-15" });
    expect(kq.thanhToanChuaGhi.map((d) => [d.ngayGiaoDich, d.ghiCo])).toEqual([["2026-10-17", 6_850_000]]);
    expect(kq.soDeXuat).toBe(34_839_000);
  });
});

describe("doiChieuSaoKeThe — chuỗi 5 lần trả 6.850.000 trên sao kê 20/10 (06, 09, 11, 13, 17)", () => {
  const X = 6_850_000;
  const chay = (ngayApp: string[]) =>
    doiChieuSaoKeThe(saoKe1020(), BILLS, {
      ngayChotTruoc: "2026-09-18",
      mocM: "2026-10-01",
      giaoDichApp: {
        ghiNo: [],
        ghiCo: [
          { id: "p02", ngay: "2026-10-02", soTien: 9_459_000 },
          ...ngayApp.map((ngay) => ({ id: `p${ngay.slice(8)}`, ngay, soTien: X })),
        ],
      },
    });

  it("app ghi ĐÚNG ngày GD ngân hàng ⇒ ghép thẳng, không mơ hồ, số đề xuất như cũ 34.839.000", () => {
    const kq = chay(["2026-10-06", "2026-10-09", "2026-10-11", "2026-10-13", "2026-10-17"]);
    expect(kq.traMoHo).toEqual([]);
    expect(kq.thanhToanChuaGhi).toEqual([]);
    expect(kq.traChuaLenSaoKe).toEqual([]);
    expect(kq.soDeXuat).toBe(34_839_000);
  });

  it("app ghi trễ 1 ngày mỗi lần (07, 10, 12, 14, 18) ⇒ cả chuỗi đan nhau ⇒ MƠ HỒ, CHẶN", () => {
    const kq = chay(["2026-10-07", "2026-10-10", "2026-10-12", "2026-10-14", "2026-10-18"]);
    expect(kq.traMoHo).toHaveLength(1);
    expect(kq.traMoHo[0].dong).toHaveLength(5);
    expect(kq.traMoHo[0].giaoDich).toHaveLength(5);
    expect(kq.traChuaLenSaoKe).toEqual([]);
    expect(lyDoTraTheMoHo(kq)).toContain("sao kê có 5 lần trả 6.850.000 ₫ ngày 06/10, 09/10, 11/10, 13/10, 17/10");
  });
});

describe("doiChieuSaoKeThe — chi thẻ / trả thẻ ngoài TikTok (dữ liệu tổng hợp, sao kê 20/10, M 15/10)", () => {
  const no = (ngay: string, ghiNo: number, dienGiai = "MUA KHAC"): DongSaoKe => ({
    ngayGiaoDich: ngay,
    ngayGhiSo: ngay,
    ghiNo,
    ghiCo: 0,
    dienGiai,
    laTiktok: false,
    laThanhToan: false,
  });
  const tra = (ngay: string, ghiCo: number): DongSaoKe => ({
    ngayGiaoDich: ngay,
    ngayGhiSo: ngay,
    ghiNo: 0,
    ghiCo,
    dienGiai: "Thanh toan no the tin dung",
    laTiktok: false,
    laThanhToan: true,
  });
  const DU_NO = 10_000_000;
  const saoKe = (ds: DongSaoKe[]): SaoKeThe => ({
    nganHang: "TECHCOMBANK",
    ngaySaoKe: "2026-10-20",
    soCuoiThe: "9999",
    hanMuc: 50_000_000,
    duNoKyTruoc: 0,
    tongGhiNo: 0,
    tongGhiCo: 0,
    duNoCuoiKy: DU_NO,
    traToiThieu: 0,
    hanTra: "2026-11-05",
    dong: ds,
  });
  const chay = (
    ds: DongSaoKe[],
    gd: Partial<GiaoDichAppThe>,
    ngayChotTruoc: string | null = "2026-10-14",
    mocM = "2026-10-15",
  ) =>
    doiChieuSaoKeThe(saoKe(ds), [], {
      ngayChotTruoc,
      mocM,
      giaoDichApp: { ghiNo: gd.ghiNo ?? [], ghiCo: gd.ghiCo ?? [] },
    });

  it("trả thẻ ngày sao kê mà ngân hàng ghi sổ sau ⇒ TRỪ khỏi đề xuất (traChuaLenSaoKe)", () => {
    const kq = chay([tra("2026-10-17", 5_000_000)], {
      ghiCo: [
        { id: "p17", ngay: "2026-10-17", soTien: 5_000_000 },
        { id: "p20", ngay: "2026-10-20", soTien: 3_000_000 },
      ],
    });
    expect(kq.traChuaLenSaoKe.map((g) => g.id)).toEqual(["p20"]);
    expect(kq.tongTraChuaLenSaoKe).toBe(3_000_000);
    expect(kq.soDeXuat).toBe(DU_NO - 3_000_000);
    expect(kq.giaiThich[0]).toBe("Sao kê 10.000.000 ₫ − 1 lần trả thẻ ngày 20/10 chưa lên sao kê 3.000.000 ₫ = 7.000.000 ₫");
    expect(lyDoGiaoDichSaiNgay(kq)).toBeNull();
  });

  it("trả thẻ app ghi ngày SAU ngày sao kê mà sao kê đã có ⇒ traSaiNgay, chặn (sửa ngày), số không đổi", () => {
    const kq = chay([tra("2026-10-19", 5_000_000)], { ghiCo: [{ id: "p21", ngay: "2026-10-21", soTien: 5_000_000 }] });
    expect(kq.traSaiNgay.map((c) => [c.giaoDich.id, c.dong.ngayGiaoDich])).toEqual([["p21", "2026-10-19"]]);
    expect(kq.thanhToanChuaGhi).toEqual([]);
    expect(kq.soDeXuat).toBe(DU_NO);
    expect(lyDoGiaoDichSaiNgay(kq)).toContain("ngày Trả thẻ về đúng ngày ngân hàng");
    expect(lyDoGiaoDichSaiNgay(kq)).toContain("ghi ngày 21/10 — ngân hàng ghi ngày 19/10");
  });

  it("ưu tiên CARD_PAY ≤ ngày sao kê: dòng 18/10 ghép CARD_PAY 19/10, CARD_PAY 21/10 là lần trả mới kỳ sau", () => {
    const kq = chay([tra("2026-10-18", 5_000_000)], {
      ghiCo: [
        { id: "p21", ngay: "2026-10-21", soTien: 5_000_000 },
        { id: "p19", ngay: "2026-10-19", soTien: 5_000_000 },
      ],
    });
    expect(kq.traSaiNgay).toEqual([]);
    expect(kq.traChuaLenSaoKe).toEqual([]);
    expect(kq.soDeXuat).toBe(DU_NO);
  });

  it("khác số tiền không ghép; CARD_PAY ≤ mốc trễ không thấy trên sao kê ⇒ chỉ báo, không trừ; dòng sao kê ⇒ nhắc ghi", () => {
    const kq = chay([tra("2026-10-16", 5_000_000)], { ghiCo: [{ id: "p15", ngay: "2026-10-15", soTien: 4_000_000 }] });
    expect(kq.thanhToanChuaGhi.map((d) => d.ngayGiaoDich)).toEqual(["2026-10-16"]);
    expect(kq.traKhongThayTrenSaoKe.map((g) => g.id)).toEqual(["p15"]);
    expect(kq.traChuaLenSaoKe).toEqual([]);
    expect(kq.soDeXuat).toBe(DU_NO);
    expect(kq.giaiThich.join("\n")).toContain("1 lần trả thẻ trong app ngày 15/10 (4.000.000 ₫) không thấy trên sao kê");
  });

  it("thanh toán trên sao kê trước M hoặc ≤ neo trước không nhắc ghi", () => {
    const kq = chay([tra("2026-10-12", 1), tra("2026-10-16", 2), tra("2026-10-18", 3)], {}, "2026-10-16");
    expect(kq.thanhToanChuaGhi.map((d) => d.ghiCo)).toEqual([3]);
  });

  /**
   * Nhiều lần trả CÙNG số tiền cách nhau vài ngày: mỗi cách ghép ±3 ngày cho một P (trả chưa lên sao kê) và một câu nhắc
   * "chưa ghi" khác nhau ⇒ MƠ HỒ ⇒ CHẶN, không đoán. Các phần tử của cụm không vào P / nhắc / sai ngày.
   */
  const X = 6_850_000;
  const p = (id: string, ngay: string) => ({ id, ngay, soTien: X });

  it("sao kê trả 13/10 + 17/10, app trả 16/10 + 19/10 ⇒ MƠ HỒ, CHẶN — không im lặng P = 0", () => {
    // Một cách hiểu: quên ghi 13/10, 16/10 là lần GD 17/10, 19/10 chưa lên sổ ⇒ P = 19/10 + nhắc 13/10.
    // Cách kia: 13↔16, 17↔19 ⇒ P = 0, không nhắc. App không biết cách nào đúng.
    const kq = chay(
      [tra("2026-10-13", X), tra("2026-10-17", X)],
      { ghiCo: [p("p16", "2026-10-16"), p("p19", "2026-10-19")] },
      null,
      "2026-10-01",
    );
    expect(kq.traMoHo).toHaveLength(1);
    expect(kq.traMoHo[0].dong.map((d) => d.ngayGiaoDich)).toEqual(["2026-10-13", "2026-10-17"]);
    expect(kq.traMoHo[0].giaoDich.map((g) => g.id)).toEqual(["p16", "p19"]);
    expect(kq.traChuaLenSaoKe).toEqual([]);
    expect(kq.thanhToanChuaGhi).toEqual([]);
    expect(kq.traSaiNgay).toEqual([]);
    expect(lyDoTraTheMoHo(kq)).toBe(
      "Trả thẻ MƠ HỒ — không ghép chắc được theo ngày: sao kê có 2 lần trả 6.850.000 ₫ ngày 13/10, 17/10 ↔ app có 2 lần " +
        '6.850.000 ₫ ngày 16/10, 19/10. Sửa ngày "Trả thẻ" trong app về ĐÚNG ngày giao dịch ngân hàng (cột Ngày giao dịch ' +
        "trên sao kê), ghi lần nào còn thiếu, rồi nhập lại",
    );
  });

  it("sao kê trả 17/10 + 19/10, app trả 18/10 + 21/10 ⇒ MƠ HỒ (18/10 ứng cả hai dòng), không báo 'sai ngày' cho 21/10", () => {
    const kq = chay([tra("2026-10-17", X), tra("2026-10-19", X)], { ghiCo: [p("p18", "2026-10-18"), p("p21", "2026-10-21")] });
    // Cả hai dòng đều có lần trả ≤ ngày sao kê trong ±3 ⇒ 21/10 KHÔNG được lấp dòng nào (là lần trả kỳ sau).
    expect(kq.traMoHo.map((c) => [c.dong.map((d) => d.ngayGiaoDich), c.giaoDich.map((g) => g.id)])).toEqual([
      [["2026-10-17", "2026-10-19"], ["p18"]],
    ]);
    expect(kq.traSaiNgay).toEqual([]);
    expect(lyDoGiaoDichSaiNgay(kq)).toBeNull();
    expect(lyDoTraTheMoHo(kq)).toContain("sao kê có 2 lần trả 6.850.000 ₫ ngày 17/10, 19/10 ↔ app có 1 lần 6.850.000 ₫ ngày 18/10");
  });

  it("sửa ngày Trả thẻ về đúng ngày GD ngân hàng ⇒ hết mơ hồ, ghép đúng ngày (P chỉ gồm lần thật chưa lên sổ)", () => {
    const kq = chay([tra("2026-10-13", X), tra("2026-10-17", X)], {
      ghiCo: [p("p13", "2026-10-13"), p("p17", "2026-10-17"), p("p19", "2026-10-19")],
    }, null, "2026-10-01");
    expect(kq.traMoHo).toEqual([]);
    expect(kq.traChuaLenSaoKe.map((g) => g.id)).toEqual(["p19"]);
    expect(kq.soDeXuat).toBe(DU_NO - X);
    expect(lyDoTraTheMoHo(kq)).toBeNull();
  });

  it("cặp dung sai DUY NHẤT vẫn ghép: dòng 18/10 ↔ CARD_PAY 20/10 (không ứng viên nào khác)", () => {
    const kq = chay([tra("2026-10-18", X)], { ghiCo: [p("p20", "2026-10-20")] });
    expect(kq.traMoHo).toEqual([]);
    expect(kq.traChuaLenSaoKe).toEqual([]);
    expect(kq.thanhToanChuaGhi).toEqual([]);
    expect(kq.soDeXuat).toBe(DU_NO);
  });

  it("sao kê có trả 19/10 app chưa ghi + app có trả 21/10 (lần khác) ⇒ vẫn chặn, câu hướng dẫn nêu cả lối 'hai lần khác nhau' kèm điều kiện kiểm", () => {
    const kq = chay([tra("2026-10-19", 5_000_000)], { ghiCo: [{ id: "p21", ngay: "2026-10-21", soTien: 5_000_000 }] });
    expect(kq.traSaiNgay.map((c) => c.giaoDich.id)).toEqual(["p21"]);
    const lyDo = lyDoGiaoDichSaiNgay(kq)!;
    expect(lyDo).toContain("Nếu là CÙNG một lần: Sửa ngày Trả thẻ về đúng ngày ngân hàng");
    expect(lyDo).toContain("Nếu là HAI lần khác nhau cùng số tiền: ghi thêm lần ngân hàng đã ghi");
    expect(lyDo).toContain("CHỈ làm vậy sau khi kiểm sao kê TÀI KHOẢN thanh toán thấy ĐỦ hai lần chuyển");
    expect(lyDo).toContain("quỹ hụt và dư nợ thẻ thấp");

    // Làm theo lối thứ hai: ghi lần 19/10 ⇒ dòng sao kê ghép ĐÚNG ngày, lần 21/10 là kỳ sau ⇒ hết chặn, số không đổi.
    const kq2 = chay([tra("2026-10-19", 5_000_000)], {
      ghiCo: [
        { id: "p21", ngay: "2026-10-21", soTien: 5_000_000 },
        { id: "p19", ngay: "2026-10-19", soTien: 5_000_000 },
      ],
    });
    expect(lyDoGiaoDichSaiNgay(kq2)).toBeNull();
    expect(kq2.traMoHo).toEqual([]);
    expect(kq2.traChuaLenSaoKe).toEqual([]);
    expect(kq2.soDeXuat).toBe(DU_NO);
  });

  it("kết quả trả thẻ (kể cả mơ hồ) không phụ thuộc thứ tự đầu vào", () => {
    const dongs = [tra("2026-10-16", 2_000_000), tra("2026-10-18", 2_000_000), tra("2026-10-19", 2_000_000)];
    const gd = [
      { id: "a", ngay: "2026-10-16", soTien: 2_000_000 },
      { id: "b", ngay: "2026-10-17", soTien: 2_000_000 },
      { id: "c", ngay: "2026-10-20", soTien: 2_000_000 },
      { id: "d", ngay: "2026-10-22", soTien: 2_000_000 },
    ];
    const xuoi = chay(dongs, { ghiCo: gd });
    const nguoc = chay([...dongs].reverse(), { ghiCo: [...gd].reverse() });
    const tom = (k: typeof xuoi) => ({
      traMoHo: k.traMoHo,
      traChuaLenSaoKe: k.traChuaLenSaoKe,
      traSaiNgay: k.traSaiNgay,
      thanhToanChuaGhi: k.thanhToanChuaGhi,
      soDeXuat: k.soDeXuat,
    });
    expect(tom(nguoc)).toEqual(tom(xuoi));
    // 16↔16 đúng ngày; 18 và 19 cùng ứng 17 + 20 ⇒ một cụm mơ hồ; 22/10 là kỳ sau.
    expect(xuoi.traMoHo.map((c) => [c.dong.map((d) => d.ngayGiaoDich), c.giaoDich.map((g) => g.id)])).toEqual([
      [["2026-10-18", "2026-10-19"], ["b", "c"]],
    ]);
  });

  it("chi ghi tay / nạp ví bằng thẻ: khớp đúng ngày ⇒ thôi; trong cửa sổ trễ chưa lên sao kê ⇒ CỘNG; sớm hơn ⇒ chỉ báo", () => {
    const kq = chay([no("2026-10-18", 200_000, "SHOP ABC"), no("2026-10-19", 9_900, "PHI KHAC")], {
      ghiNo: [
        { id: "c18", ngay: "2026-10-18", soTien: 200_000, loai: "CHI_TAY" },
        { id: "c19", ngay: "2026-10-19", soTien: 150_000, loai: "CHI_TAY" },
        { id: "n20", ngay: "2026-10-20", soTien: 300_000, loai: "NAP_VI" },
        { id: "c15", ngay: "2026-10-15", soTien: 77_000, loai: "CHI_TAY" },
        { id: "sau", ngay: "2026-10-22", soTien: 1, loai: "CHI_TAY" },
      ],
    });
    expect(kq.chiTayChuaLenSaoKe.map((g) => g.id)).toEqual(["c19", "n20"]);
    expect(kq.tongChiTayChuaLenSaoKe).toBe(450_000);
    expect(kq.chiTayKhongThayTrenSaoKe.map((g) => g.id)).toEqual(["c15"]);
    expect(kq.soDeXuat).toBe(DU_NO + 450_000);
    expect(kq.giaiThich[0]).toContain("+ 2 khoản chi trừ vào thẻ ngày 19/10 · 20/10 chưa lên sao kê 450.000 ₫");
    // Gợi ý ghi Sổ chi phí chỉ cho dòng app CHƯA có, và nói rõ phải ghi đúng ngày giao dịch.
    const goiY = kq.giaiThich.find((g) => g.includes("khoản không phải TikTok"))!;
    expect(goiY).toContain("PHI KHAC");
    expect(goiY).not.toContain("SHOP ABC");
    expect(goiY).toContain("ĐÚNG ngày giao dịch trên sao kê");
  });

  it("chi thẻ app ghi ngày sau ngày sao kê mà sao kê đã có ⇒ chiSaiNgay, chặn", () => {
    const kq = chay([no("2026-10-19", 300_000)], { ghiNo: [{ id: "n21", ngay: "2026-10-21", soTien: 300_000, loai: "NAP_VI" }] });
    expect(kq.chiSaiNgay.map((c) => c.giaoDich.id)).toEqual(["n21"]);
    expect(kq.chiTayChuaLenSaoKe).toEqual([]);
    expect(lyDoGiaoDichSaiNgay(kq)).toContain("Sửa ngày khoản chi về đúng ngày ngân hàng");
  });

  it("giao dịch app ≤ neo trước: bỏ khi cũng ≤ mốc trễ; trong cửa sổ trễ thì vẫn xét", () => {
    const kq = chay([], {
      ghiCo: [
        { id: "cu", ngay: "2026-10-14", soTien: 1_000 },
        { id: "tre", ngay: "2026-10-17", soTien: 2_000 },
      ],
    }, "2026-10-18");
    expect(kq.traChuaLenSaoKe.map((g) => g.id)).toEqual(["tre"]);
    expect(kq.traKhongThayTrenSaoKe).toEqual([]);
    expect(kq.soDeXuat).toBe(DU_NO - 2_000);
  });
});

/**
 * Hoàn tiền TikTok về thẻ (hoá đơn `amountType = NEGATIVE`): lõi dư nợ trừ nó (ngày hoàn > neo), nhưng neo PDF mới chỉ
 * đúng khi số đề xuất cũng trừ phần hoàn ngân hàng CHƯA ghi sổ ở ngày sao kê — không thì sau chốt lõi chỉ đếm > ngày
 * chốt và khoản hoàn mất hẳn. Ghép MULTISET theo (ngày, số tiền) với dòng GHI CÓ `laTiktok`; còn dư thì cùng luật cửa
 * sổ trễ như bill. Số dư sao kê in (`duNoCuoiKy`) không đổi. Sao kê 20/10, mốc trễ 15/10, neo trước 14/10.
 */
describe("doiChieuSaoKeThe — hoàn tiền TikTok (hoá đơn NEGATIVE)", () => {
  const DU_NO = 10_000_000;
  const hoanTrenSaoKe = (ngay: string, ghiCo: number): DongSaoKe => ({
    ngayGiaoDich: ngay,
    ngayGhiSo: ngay,
    ghiNo: 0,
    ghiCo,
    dienGiai: "Hoan tien giao dich 9PAY*TikTok Ads HA NOI VN",
    laTiktok: true,
    laThanhToan: false,
  });
  const saoKe = (ds: DongSaoKe[]): SaoKeThe => ({
    nganHang: "TECHCOMBANK",
    ngaySaoKe: "2026-10-20",
    soCuoiThe: "9999",
    hanMuc: 50_000_000,
    duNoKyTruoc: 0,
    tongGhiNo: 0,
    tongGhiCo: 0,
    duNoCuoiKy: DU_NO,
    traToiThieu: 0,
    hanTra: "2026-11-05",
    dong: ds,
  });
  const hoan = (id: string, ngay: string, soTien: number): BillApp => ({ id, ngay, soTien });
  const chay = (ds: DongSaoKe[], dsHoan: BillApp[], ngayChotTruoc: string | null = "2026-10-14") =>
    doiChieuSaoKeThe(saoKe(ds), [], { ngayChotTruoc, mocM: "2026-10-15", hoan: dsHoan });

  it("hoàn 200.000 ngày 20/10 chưa lên sao kê ⇒ TRỪ khỏi đề xuất; số sao kê in giữ nguyên", () => {
    const kq = chay([], [hoan("h1", "2026-10-20", 200_000)]);
    expect(kq.hoanGhiSoTre.map((h) => h.id)).toEqual(["h1"]);
    expect(kq.tongHoanGhiSoTre).toBe(200_000);
    expect(kq.soDeXuat).toBe(DU_NO - 200_000);
    expect(kq.giaiThich[0]).toBe("Sao kê 10.000.000 ₫ − 1 lần TikTok hoàn ngày 20/10 chưa lên sao kê 200.000 ₫ = 9.800.000 ₫");
  });

  it("hoàn đã lên sao kê (dòng ghi có TikTok cùng ngày, cùng tiền) ⇒ ghép, KHÔNG trừ lần nữa, không lẫn vào 'dòng khác'", () => {
    const kq = chay([hoanTrenSaoKe("2026-10-19", 200_000)], [hoan("h1", "2026-10-19", 200_000)]);
    expect(kq.khopHoan.map((k) => k.billId)).toEqual(["h1"]);
    expect(kq.hoanGhiSoTre).toEqual([]);
    expect(kq.soDeXuat).toBe(DU_NO);
    expect(kq.dongKhac.ghiCo).toEqual([]);
    // Dòng hoàn không bao giờ ghép nhầm với bill ghi nợ cùng ngày cùng tiền.
    expect(kq.khop).toEqual([]);
  });

  it("hai lần hoàn trùng ngày + số, sao kê mới in một ⇒ một ghép, một trừ", () => {
    const kq = chay(
      [hoanTrenSaoKe("2026-10-19", 200_000)],
      [hoan("h1", "2026-10-19", 200_000), hoan("h2", "2026-10-19", 200_000)],
    );
    expect(kq.khopHoan.map((k) => k.billId)).toEqual(["h1"]);
    expect(kq.hoanGhiSoTre.map((h) => h.id)).toEqual(["h2"]);
    expect(kq.soDeXuat).toBe(DU_NO - 200_000);
  });

  it("hoàn thuộc kỳ trước (≤ neo trước và ≤ mốc trễ) ⇒ bỏ qua; ≤ mốc trễ mà sau neo trước ⇒ chỉ báo; sau ngày sao kê ⇒ kỳ sau", () => {
    const kq = chay(
      [],
      [hoan("cu", "2026-10-12", 300_000), hoan("som", "2026-10-15", 400_000), hoan("sau", "2026-10-21", 500_000)],
    );
    expect(kq.hoanGhiSoTre).toEqual([]);
    expect(kq.hoanKhongThayTrenSaoKe.map((h) => h.id)).toEqual(["som"]);
    expect(kq.soDeXuat).toBe(DU_NO);
    expect(kq.giaiThich.join("\n")).toContain("1 lần TikTok hoàn 15/10 (400.000 ₫) không thấy trên sao kê");
  });

  it("hoàn trong cửa sổ trễ dù ≤ neo trước (neo 18/10) vẫn trừ — neo mới thay hẳn neo cũ", () => {
    const kq = chay([], [hoan("tre", "2026-10-17", 100_000)], "2026-10-18");
    expect(kq.hoanGhiSoTre.map((h) => h.id)).toEqual(["tre"]);
    expect(kq.soDeXuat).toBe(DU_NO - 100_000);
  });

  it("dòng hoàn TikTok trên sao kê mà app không có hoá đơn hoàn ⇒ chỉ báo, đề xuất không đổi", () => {
    const kq = chay([hoanTrenSaoKe("2026-10-19", 200_000)], []);
    expect(kq.saoKeHoanKhongCoTrongApp.map((d) => [d.ngayGiaoDich, d.ghiCo])).toEqual([["2026-10-19", 200_000]]);
    expect(kq.soDeXuat).toBe(DU_NO);
    expect(kq.giaiThich.join("\n")).toContain("1 dòng TikTok hoàn trên sao kê (200.000 ₫) KHÔNG có hoá đơn hoàn tương ứng trong app");
  });

  it("không truyền danh sách hoàn ⇒ như trước (không trường nào khác đổi)", () => {
    const kq = doiChieuSaoKeThe(saoKe([]), [], { ngayChotTruoc: "2026-10-14" });
    expect(kq).toMatchObject({ khopHoan: [], hoanGhiSoTre: [], hoanKhongThayTrenSaoKe: [], tongHoanGhiSoTre: 0, soDeXuat: DU_NO });
  });
});

describe("tomTatDienGiai", () => {
  it("bỏ phần lặp 'Giao dịch thanh toán/Purchase - Số Thẻ/Card No: …'", () => {
    expect(tomTatDienGiai("Giao dịch thanh toán/Purchase - Số Thẻ/Card No: 0000...9999 DICH VU B *GOI THUE BAO DICHVUB.COM US")).toBe(
      "DICH VU B *GOI THUE BAO DICHVUB.COM US",
    );
    expect(tomTatDienGiai("Phí thường niên/Annual Fee")).toBe("Phí thường niên/Annual Fee");
  });
});
