import { describe, expect, it } from "vitest";

import { khoanCauTrucTai } from "@/lib/no-phai-tra/khoan-cau-truc-tai-ngay";
import {
  goiYDieuChinh,
  tacDongDieuChinh,
  tinhChenhLechTaiM,
  type DauVaoChenhLechTaiM,
} from "@/lib/no-phai-tra/tinh-chenh-lech-tai-m";

/**
 * Chênh lệch tại mốc bật (spec §5.4 bước 2, ví dụ tiền §6; đơn vị triệu): quỹ 31/10 = 150, ngân hàng 158 +
 * tiền mặt 7, thấu chi 0, thẻ A 9 + thẻ B 6 ⇒ chênh +15, giải thích được 15, chưa giải thích 0.
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

  it("thấu chi 10 còn tại 31/10, trả hết 02/11, xác nhận 03/11 ⇒ dùng dư nợ CUỐI 31/10 = 10, không phải 0", () => {
    const thauChi = { id: "od", kind: "OVERDRAFT", startDate: vn("2026-10-01"), closedAt: null, duNoMoSo: 0 };
    const dong = [
      { loanId: "od", savingsId: null, kind: "LOAN_IN", amount: tr(10), date: vn("2026-10-15") },
      { loanId: "od", savingsId: null, kind: "LOAN_REPAY", amount: tr(10), date: vn("2026-11-02") },
    ];
    const cauTruc = khoanCauTrucTai(vn("2026-10-31"), [thauChi], dong);
    expect(cauTruc.duNoThauChi).toBe(tr(10));
    // Thấu chi làm ngân hàng thấp hơn quỹ 10: bank 148 + 7 − 150 + 10 = 15.
    const kq = tinhChenhLechTaiM({ ...coBan, soDuBank: tr(148), duNoThauChi: cauTruc.duNoThauChi });
    expect(kq.chenh).toBe(tr(15));
    expect(kq.chuaGiaiThich).toBe(0);
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
