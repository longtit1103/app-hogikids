import { describe, expect, it } from "vitest";

import { khoanCauTrucTai } from "@/lib/no-phai-tra/khoan-cau-truc-tai-ngay";
import {
  goiYDieuChinh,
  tacDongDieuChinh,
  tinhChenhLechTaiM,
  type DauVaoChenhLechTaiM,
} from "@/lib/no-phai-tra/tinh-chenh-lech-tai-m";

/**
 * Chênh lệch tại mốc bật (đơn vị triệu): quỹ 31/10 = 150, ngân hàng 158 + tiền mặt 7, thẻ A 9 + thẻ B 6
 * ⇒ chênh +15, giải thích được 15, chưa giải thích 0. Dư nợ thấu chi KHÔNG vào chênh — thấu chi giải ngân
 * vào tài khoản nên tiền thật lẫn quỹ app đều đã gồm tiền vay.
 */
const tr = (n: number) => Math.round(n * 1_000_000);
const vn = (ngay: string) => new Date(`${ngay}T00:00:00+07:00`);

const coBan: DauVaoChenhLechTaiM = {
  quyApp: tr(150),
  soDuBank: tr(158),
  tienMat: tr(7),
  duNoThauChi: 0,
  the: [
    { khoa: "the:A", nhan: "nợ thẻ A", soTien: tr(9) },
    { khoa: "the:B", nhan: "nợ thẻ B", soTien: tr(6) },
  ],
  phieuY: [],
  viAds: [],
};

describe("tinhChenhLechTaiM", () => {
  it("fixture §6: chênh 15 = nợ thẻ 9 + 6 ⇒ chưa giải thích 0", () => {
    const kq = tinhChenhLechTaiM(coBan);
    expect(kq).toMatchObject({
      soThat: tr(165),
      chenh: tr(15),
      giaiThichDuoc: { the: tr(15), phieuY: 0, viAds: 0 },
      tongGiaiThich: tr(15),
      chuaGiaiThich: 0,
    });
    // "Giải thích được" và "toàn bộ" trùng nhau khi không có phần chưa giải thích: 2 dòng VÀO 9 + 6.
    const ds = goiYDieuChinh(kq, "toan-bo", "01/11/2026");
    expect(ds.map((d) => [d.chieu, d.soTien])).toEqual([
      ["IN", tr(9)],
      ["IN", tr(6)],
    ]);
    expect(ds[0].moTa).toContain("nợ thẻ A");
    expect(tacDongDieuChinh(ds)).toBe(tr(15));
  });

  it("thấu chi 10 giải ngân vào tài khoản ⇒ dư nợ CUỐI 31/10 = 10 chỉ để hiển thị, KHÔNG cộng vào chênh", () => {
    const thauChi = { id: "od", kind: "OVERDRAFT", startDate: vn("2026-10-01"), closedAt: null, duNoMoSo: 0 };
    const dong = [
      { loanId: "od", savingsId: null, kind: "LOAN_IN", amount: tr(10), date: vn("2026-10-15") },
      { loanId: "od", savingsId: null, kind: "LOAN_REPAY", amount: tr(10), date: vn("2026-11-02") },
    ];
    // Dư nợ cuối 31/10 (trả hết 02/11 vẫn là 10 tại M − 1) — dòng tham khảo trên màn bật.
    const cauTruc = khoanCauTrucTai(vn("2026-10-31"), [thauChi], dong);
    expect(cauTruc.duNoThauChi).toBe(tr(10));
    // Tiền vay đã nằm trên tài khoản (bank 158) lẫn trong quỹ (`LOAN_IN` 10 ⇒ quỹ 150 đã gồm) ⇒ so thẳng:
    // 158 + 7 − 150 = 15, đúng bằng nợ thẻ. Cộng thêm dư nợ là ra 25 — thừa đúng 10.
    const kq = tinhChenhLechTaiM({ ...coBan, duNoThauChi: cauTruc.duNoThauChi });
    expect(kq.duNoThauChi).toBe(tr(10));
    expect(kq.chenh).toBe(tr(15));
    expect(kq.chuaGiaiThich).toBe(0);
    expect(tacDongDieuChinh(goiYDieuChinh(kq, "toan-bo", "01/11/2026"))).toBe(tr(15));
  });

  it("số thật 14/10: quỹ 260.908.494 (gồm thấu chi 100tr), tiền thật 45.547.696, thẻ 24.540.609", () => {
    const kq = tinhChenhLechTaiM({
      quyApp: 260_908_494,
      soDuBank: 45_547_696,
      tienMat: 0,
      duNoThauChi: 100_000_000,
      the: [{ khoa: "the:4826", nhan: "nợ thẻ 4826", soTien: 24_540_609 }],
      phieuY: [],
      viAds: [],
    });
    expect(kq.chenh).toBe(-215_360_798);
    expect(kq.chuaGiaiThich).toBe(-239_901_407);
    // "Toàn bộ chênh lệch" ⇒ quỹ sau điều chỉnh = đúng tiền thật trên tài khoản, không lệch 100tr dư nợ.
    const toanBo = goiYDieuChinh(kq, "toan-bo", "15/10/2026");
    expect(toanBo.map((d) => [d.chieu, d.soTien])).toEqual([
      ["IN", 24_540_609],
      ["OUT", 239_901_407],
    ]);
    expect(260_908_494 + tacDongDieuChinh(toanBo)).toBe(45_547_696);
  });

  it("ví ads trả trước neo 3 (đã nạp, chưa chạy, sổ chưa trừ) ⇒ giải thích thêm −3", () => {
    // Ngân hàng thấp hơn 3 vì tiền nạp ví đã rời ngân hàng: 155 + 7 − 150 = 12 = 15 − 3.
    const kq = tinhChenhLechTaiM({
      ...coBan,
      soDuBank: tr(155),
      viAds: [{ khoa: "vi:S", nhan: "ví Shopee Ads", soTien: -tr(3) }],
    });
    expect(kq.chenh).toBe(tr(12));
    expect(kq.giaiThichDuoc.viAds).toBe(-tr(3));
    expect(kq.chuaGiaiThich).toBe(0);
    const ds = goiYDieuChinh(kq, "giai-thich-duoc", "01/11/2026");
    expect(ds.map((d) => [d.chieu, d.soTien])).toEqual([
      ["IN", tr(9)],
      ["IN", tr(6)],
      ["OUT", tr(3)],
    ]);
    expect(tacDongDieuChinh(ds)).toBe(tr(12));
  });

  it("phiếu Y (duyệt 53,6, thật trả 33,6) ⇒ +20 vào phần giải thích được", () => {
    const kq = tinhChenhLechTaiM({
      ...coBan,
      soDuBank: tr(178),
      phieuY: [{ khoa: "phieu:1", nhan: "phiếu #1", soTien: tr(20) }],
    });
    expect(kq.chenh).toBe(tr(35));
    expect(kq.giaiThichDuoc.phieuY).toBe(tr(20));
    expect(kq.chuaGiaiThich).toBe(0);
  });

  it("phần chưa giải thích: 'giải thích được' bỏ qua, 'toàn bộ' thêm một dòng đúng phần đó (âm ⇒ RA)", () => {
    const kq = tinhChenhLechTaiM({ ...coBan, soDuBank: tr(156) }); // chênh 13 = 15 − 2
    expect(kq.chuaGiaiThich).toBe(-tr(2));
    expect(tacDongDieuChinh(goiYDieuChinh(kq, "giai-thich-duoc", "01/11/2026"))).toBe(tr(15));
    const toanBo = goiYDieuChinh(kq, "toan-bo", "01/11/2026");
    expect(toanBo.at(-1)).toMatchObject({ chieu: "OUT", soTien: tr(2) });
    expect(tacDongDieuChinh(toanBo)).toBe(kq.chenh);
  });

  it("chênh 0, không mục nào ⇒ không dòng điều chỉnh", () => {
    const kq = tinhChenhLechTaiM({ ...coBan, soDuBank: tr(143), the: [] });
    expect(kq.chenh).toBe(0);
    expect(goiYDieuChinh(kq, "toan-bo", "01/11/2026")).toEqual([]);
  });
});
