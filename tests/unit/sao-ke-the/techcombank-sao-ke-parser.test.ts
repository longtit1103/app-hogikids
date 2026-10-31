import { describe, expect, it } from "vitest";

import { parseSaoKeTechcombank, type SaoKeThe } from "@/lib/sao-ke-the/techcombank-sao-ke-parser";

import { docTextFixture } from "./doc-fixture-sao-ke-the";

/**
 * Parser sao kê Techcombank trên 2 kỳ thật (text pypdf đã gột: số tiền ×1,37 làm tròn nghìn, số thẻ + merchant tổng hợp).
 * Số kỳ vọng đo độc lập bằng parser Python tham khảo + khối Tóm tắt in trên sao kê.
 */

function parseOk(text: string): SaoKeThe {
  const r = parseSaoKeTechcombank(text);
  if (!r.ok) throw new Error(`parse hỏng: ${r.loi}`);
  return r.saoKe;
}

function parseLoi(text: string): string {
  const r = parseSaoKeTechcombank(text);
  if (r.ok) throw new Error("mong đợi ok:false nhưng parse được");
  return r.loi;
}

const TEXT_1020 = docTextFixture("techcombank-2026-10-20");
const TEXT_0918 = docTextFixture("techcombank-2026-09-18");

describe("parseSaoKeTechcombank — sao kê 20/10/2026", () => {
  const sk = parseOk(TEXT_1020);

  it("đọc đúng đầu trang + khối Tóm tắt (dư nợ đổi dấu: dương = đang nợ)", () => {
    const { dong, ...dau } = sk;
    expect(dau).toEqual({
      nganHang: "TECHCOMBANK",
      ngaySaoKe: "2026-10-20",
      soCuoiThe: "9999",
      hanMuc: 50_000_000,
      duNoKyTruoc: 9_459_000,
      tongGhiNo: 67_546_000,
      tongGhiCo: 44_530_000,
      duNoCuoiKy: 32_475_000,
      traToiThieu: 1_623_750,
      hanTra: "2026-11-05",
    });
    expect(dong).toHaveLength(357);
  });

  it("Σ dòng khớp Tóm tắt từng đồng; 348 dòng TikTok", () => {
    expect(sk.dong.reduce((s, d) => s + d.ghiNo, 0)).toBe(67_546_000);
    expect(sk.dong.reduce((s, d) => s + d.ghiCo, 0)).toBe(44_530_000);
    expect(sk.dong.filter((d) => d.laTiktok)).toHaveLength(348);
    // Dòng TikTok luôn là ghi nợ có 2 ngày, ngày ghi sổ ≥ ngày giao dịch.
    for (const d of sk.dong.filter((x) => x.laTiktok)) {
      expect(d.ghiCo).toBe(0);
      expect(d.ngayGhiSo >= d.ngayGiaoDich).toBe(true);
    }
  });

  it("ghi nợ không phải TikTok: Dịch vụ B 978.000 + phí ngoại tệ 14.000 (dòng phí chỉ có ngày ghi sổ)", () => {
    const khac = sk.dong.filter((d) => !d.laTiktok && d.ghiNo > 0);
    expect(khac.map((d) => [d.ngayGiaoDich, d.ngayGhiSo, d.ghiNo])).toEqual([
      ["2026-09-26", "2026-09-26", 978_000],
      ["2026-09-26", "2026-09-26", 14_000],
    ]);
    expect(khac[0].dienGiai).toMatch(/DICH VU B \*GOI THUE BAO/);
    expect(khac[1].dienGiai).toMatch(/^PHI GIAO DICH NOI TE O NUOC NGOAI/);
  });

  it("ghi có: 6 lần thanh toán + 1 hoàn phí (hoàn phí KHÔNG phải thanh toán)", () => {
    const thanhToan = sk.dong.filter((d) => d.laThanhToan);
    expect(thanhToan.map((d) => [d.ngayGiaoDich, d.ghiCo])).toEqual([
      ["2026-10-02", 9_459_000],
      ["2026-10-06", 6_850_000],
      ["2026-10-09", 6_850_000],
      ["2026-10-11", 6_850_000],
      ["2026-10-13", 6_850_000],
      ["2026-10-17", 6_850_000],
    ]);
    expect(thanhToan.every((d) => d.ghiNo === 0 && !d.laTiktok)).toBe(true);
    // Thanh toán 11/10 ghi sổ 12/10 — giữ đúng hai ngày.
    expect(thanhToan[3].ngayGhiSo).toBe("2026-10-12");

    const coKhac = sk.dong.filter((d) => d.ghiCo > 0 && !d.laThanhToan);
    expect(coKhac).toHaveLength(1);
    expect(coKhac[0]).toMatchObject({ ngayGiaoDich: "2026-10-19", ngayGhiSo: "2026-10-19", ghiCo: 821_000, ghiNo: 0, laTiktok: false });
    expect(coKhac[0].dienGiai).toBe("Hoan phi thuong nien nam 01 the ...9999 theo uu dai chi tieu");
  });

  it("bill lẻ cuối kỳ đọc đúng từng đồng", () => {
    const ngay1710 = sk.dong.filter((d) => d.laTiktok && d.ngayGiaoDich === "2026-10-17" && d.ngayGhiSo === "2026-10-20");
    expect(ngay1710.map((d) => d.ghiNo)).toEqual([166_000, 166_000]);
  });
});

/**
 * Hoàn tiền TikTok về thẻ (hoá đơn `amountType = NEGATIVE` phía app) in trên sao kê là một dòng GHI CÓ. Dòng đó phải mang
 * `laTiktok` để đối chiếu ghép được với hoá đơn hoàn; hoàn PHÍ ngân hàng (kể cả phí ngoại tệ của giao dịch TikTok) thì
 * không. Dựng bằng cách đổi diễn giải dòng hoàn phí 821.000 của kỳ 20/10 — số tiền giữ nguyên nên cổng tổng vẫn khớp.
 */
describe("parseSaoKeTechcombank — dòng hoàn tiền TikTok (ghi có)", () => {
  const DONG_HOAN_PHI = "19/10/2026 821,000 Hoan phi thuong nien nam 01 the\n...9999 theo uu dai chi tieu";

  it("'Hoan tien … TikTok Ads' ⇒ ghi có, laTiktok, không phải thanh toán", () => {
    const text = TEXT_1020.replace(DONG_HOAN_PHI, "19/10/2026 821,000 Hoan tien giao dich 9PAY*TikTok Ads HA NOI VN");
    expect(text).not.toBe(TEXT_1020);
    const hoan = parseOk(text).dong.filter((d) => d.ghiCo > 0 && !d.laThanhToan);
    expect(hoan).toHaveLength(1);
    expect(hoan[0]).toMatchObject({ ngayGiaoDich: "2026-10-19", ghiCo: 821_000, ghiNo: 0, laTiktok: true, laThanhToan: false });
  });

  it("'Hoan phi … TIKTOK ADS' (hoàn phí ngân hàng) ⇒ KHÔNG laTiktok", () => {
    const text = TEXT_1020.replace(
      DONG_HOAN_PHI,
      "19/10/2026 821,000 Hoan phi giao dich noi te o nuoc ngoai - TIKTOK ADS SINGAPORE SG",
    );
    expect(text).not.toBe(TEXT_1020);
    const hoan = parseOk(text).dong.filter((d) => d.ghiCo > 0 && !d.laThanhToan);
    expect(hoan).toHaveLength(1);
    expect(hoan[0]).toMatchObject({ ghiCo: 821_000, laTiktok: false });
  });

  it("dòng ghi nợ TikTok vẫn đếm đúng 348 (dòng hoàn không lẫn vào bill)", () => {
    const text = TEXT_1020.replace(DONG_HOAN_PHI, "19/10/2026 821,000 Hoan tien giao dich 9PAY*TikTok Ads HA NOI VN");
    expect(parseOk(text).dong.filter((d) => d.laTiktok && d.ghiNo > 0)).toHaveLength(348);
  });
});

/**
 * Từ khoá hoàn chỉ xét ở PHẦN LOẠI giao dịch: merchant mang chữ "HOAN" (phố Hoàn Kiếm) không biến lần mua thành ghi có —
 * trước đây cả file bị từ chối vì Σ ghi nợ lệch Tóm tắt. Merchant tổng hợp, số tiền giữ nguyên nên cổng tổng vẫn khớp.
 */
describe("parseSaoKeTechcombank — merchant có chữ HOAN vẫn là ghi nợ", () => {
  const MERCHANT_GOC = "DICH VU B *GOI THUE BAO DICHVUB.COM\nUS";

  it("lần mua + phí ngoại tệ tại merchant 'PHO HOAN KIEM' ⇒ vẫn ghi nợ, file đọc được", () => {
    const text = TEXT_1020.split(MERCHANT_GOC).join("PHO HOAN KIEM\nHA NOI VN");
    expect(text).not.toBe(TEXT_1020);
    const khac = parseOk(text).dong.filter((d) => !d.laTiktok && d.ghiNo > 0);
    expect(khac.map((d) => [d.ngayGiaoDich, d.ghiNo, d.ghiCo])).toEqual([
      ["2026-09-26", 978_000, 0],
      ["2026-09-26", 14_000, 0],
    ]);
    expect(khac[0].dienGiai).toMatch(/PHO HOAN KIEM HA NOI VN$/);
  });

  it("dòng phí không có số thẻ, chữ HOAN nằm giữa diễn giải ⇒ vẫn ghi nợ", () => {
    const text = TEXT_0918.replace("14/09/2026 821,000 Phí thường niên/Annual Fee", "14/09/2026 821,000 Phi dich vu tai HOAN KIEM");
    expect(text).not.toBe(TEXT_0918);
    const sk = parseOk(text);
    expect(sk.dong.filter((d) => d.dienGiai.includes("HOAN KIEM")).map((d) => [d.ngayGiaoDich, d.ghiNo, d.ghiCo])).toEqual([
      ["2026-09-14", 821_000, 0],
    ]);
    expect(sk.tongGhiCo).toBe(0);
  });

  it("hoàn dạng 'Giao dịch hoàn tiền/Refund - Số Thẻ/Card No …' (cụm hoàn TRƯỚC số thẻ) ⇒ ghi có, laTiktok", () => {
    const text = TEXT_1020.replace(
      "19/10/2026 821,000 Hoan phi thuong nien nam 01 the\n...9999 theo uu dai chi tieu",
      "19/10/2026 821,000 Giao dịch hoàn tiền/Refund - Số\nThẻ/Card No: 0000...9999\n9PAY*TikTok Ads HA NOI VN",
    );
    expect(text).not.toBe(TEXT_1020);
    const hoan = parseOk(text).dong.filter((d) => d.ghiCo > 0 && !d.laThanhToan);
    expect(hoan).toHaveLength(1);
    expect(hoan[0]).toMatchObject({ ngayGiaoDich: "2026-10-19", ghiCo: 821_000, ghiNo: 0, laTiktok: true });
  });
});

describe("parseSaoKeTechcombank — sao kê 18/09/2026", () => {
  const sk = parseOk(TEXT_0918);

  it("46 dòng, dư nợ kỳ trước 0, tổng khớp", () => {
    expect(sk.dong).toHaveLength(46);
    expect(sk).toMatchObject({
      ngaySaoKe: "2026-09-18",
      soCuoiThe: "9999",
      duNoKyTruoc: 0,
      tongGhiNo: 9_459_000,
      tongGhiCo: 0,
      duNoCuoiKy: 9_459_000,
      traToiThieu: 472_950,
      hanTra: "2026-10-05",
    });
    expect(Object.is(sk.duNoKyTruoc, -0)).toBe(false);
  });

  it("phí thường niên + phí ngoại tệ là dòng khác; dòng 'TIKTOK ADS SINGAPORE SG' vẫn là TikTok", () => {
    const khac = sk.dong.filter((d) => !d.laTiktok);
    expect(khac.map((d) => [d.ngayGiaoDich, d.ghiNo, d.ghiCo])).toEqual([
      ["2026-09-14", 821_000, 0],
      ["2026-09-17", 14_000, 0],
    ]);
    expect(khac[0].dienGiai).toBe("Phí thường niên/Annual Fee");
    // Dòng phí có chữ TIKTOK trong diễn giải nhưng là phí ngân hàng, không phải hoá đơn TikTok.
    expect(khac[1].dienGiai).toMatch(/TIKTOK ADS SINGAPORE SG/);

    const singapore = sk.dong.filter((d) => /TIKTOK ADS SINGAPORE SG/.test(d.dienGiai) && d.laTiktok);
    expect(singapore.map((d) => [d.ngayGiaoDich, d.ghiNo])).toEqual([["2026-09-17", 196_000]]);
    expect(sk.dong.filter((d) => d.laTiktok)).toHaveLength(44);
  });
});

describe("parseSaoKeTechcombank — chịu được text khác lớp PDF (khoảng trắng, ngắt dòng)", () => {
  it("CRLF + khoảng trắng/tab/NBSP thừa + diễn giải dồn lên dòng ngày + tiêu đề cột gộp một dòng + NFD ⇒ y hệt", () => {
    const tieuDe = [
      "Ngày giao dịch",
      "Transaction date",
      "Ngày cập nhật hệ thống",
      "Post date",
      "Số tiền giao dịch gốc",
      "Original amount",
      "Ghi nợ (VND)",
      "Debit",
      "Ghi có (VND)",
      "Credit",
      "Diễn giải giao dịch",
      "Transaction description",
    ].join("\n");
    const bien = TEXT_1020.split(tieuDe)
      .join(tieuDe.replace(/\n/g, "  "))
      .replace(
        /(\d{2}\/\d{2}\/\d{4} \d{2}\/\d{2}\/\d{4} [\d,]+\.\d\d VND [\d,]+)\nGiao dịch thanh toán\/Purchase - Số/g,
        "$1 Giao dịch thanh toán/Purchase - Số",
      )
      .replace(/\n(\d{1,2})\nTC191\n/g, "\n$1 TC191\n")
      .replace(/ VND /g, " VND\t ")
      .replace(/\n/g, "  \r\n ")
      .normalize("NFD");
    expect(bien).not.toBe(TEXT_1020);
    expect(parseOk(bien)).toEqual(parseOk(TEXT_1020));
  });

  it("số tiền gốc dính mã tiền tệ ('143,000.00VND') vẫn đọc được", () => {
    const bien = TEXT_0918.replace(/\.00 VND /g, ".00VND ");
    expect(parseOk(bien)).toEqual(parseOk(TEXT_0918));
  });
});

describe("parseSaoKeTechcombank — CỔNG CHẶN (đọc không chắc ⇒ ok:false, không ép số)", () => {
  it("sửa 1 số tiền một dòng ⇒ Σ ghi nợ lệch Tóm tắt", () => {
    const sai = TEXT_1020.replace(
      "17/09/2026 19/09/2026 196,000.00 VND 196,000\n",
      "17/09/2026 19/09/2026 196,000.00 VND 196,100\n",
    );
    expect(sai).not.toBe(TEXT_1020);
    expect(parseLoi(sai)).toMatch(/Σ ghi nợ 357 dòng = .* ≠ Tổng ghi nợ/);
  });

  it("mất 1 dòng giao dịch (dòng phí ngoại tệ) ⇒ ok:false", () => {
    const sai = TEXT_1020.replace("26/09/2026 978,000.00 VND 14,000\n", "");
    expect(sai).not.toBe(TEXT_1020);
    expect(parseLoi(sai)).toMatch(/Σ ghi nợ/);
  });

  it("thanh toán bị đọc thành ghi nợ (diễn giải lạ) ⇒ ok:false", () => {
    const sai = TEXT_1020.replace("Thanh toan no the tin dung - Sotien\n9459000", "Chuyen khoan - Sotien\n9459000");
    expect(sai).not.toBe(TEXT_1020);
    expect(parseOk(TEXT_1020)).toBeTruthy();
    expect(parseLoi(sai)).toMatch(/Σ ghi (nợ|có)/);
  });

  it("Tóm tắt lệch dòng tổng cuối bảng ⇒ ok:false", () => {
    const sai = TEXT_1020.replace("Total Debit in Period\n67,546,000", "Total Debit in Period\n67,546,001");
    expect(sai).not.toBe(TEXT_1020);
    expect(parseLoi(sai)).toMatch(/tổng ghi nợ cuối bảng/);
  });

  it("dư nợ cuối kỳ sai đẳng thức kỳ trước + nợ − có ⇒ ok:false", () => {
    const sai = TEXT_1020.replace("Statement Balance\n-32,475,000", "Statement Balance\n-32,474,000").replace(
      "Outstanding Balance: -32,475,000",
      "Outstanding Balance: -32,474,000",
    );
    expect(parseLoi(sai)).toMatch(/≠ dư nợ cuối kỳ/);
  });

  it("thiếu khối Tóm tắt / thiếu số / không phải Techcombank ⇒ ok:false", () => {
    expect(parseLoi(TEXT_1020.replace("Tóm tắt sao kê", "X").replace("Statement Summary", "Y"))).toMatch(/Tóm tắt sao kê/);
    expect(parseLoi(TEXT_1020.replace("Minimum Payment\n1,623,750", "Minimum Payment\n"))).toMatch(/cần đúng 5/);
    expect(parseLoi("SAO KÊ TÀI KHOẢN THẺ TÍN DỤNG\nNgân hàng khác")).toMatch(/Techcombank/);
    expect(parseLoi("")).toMatch(/Techcombank/);
  });
});
