import { describe, expect, it } from "vitest";

import { LOAI_YEU_CAU_BAT } from "@/lib/no-phai-tra/ghi-khoi-tao-no-phai-tra";
import {
  chonDongNoiBat,
  docSoLieuLucBat,
  LOAI_YEU_CAU_BAT_DOC,
  netDieuChinh,
  tinhTroiQuyTruocM,
  type DongVeMuon,
} from "@/lib/no-phai-tra/troi-quy-truoc-m";

/**
 * Lõi thuần chỉ báo trôi quỹ trước ngày bật: trôi = (quỹ M − 1 hiện tại + Σ điều chỉnh hiện tại) − (quỹ M − 1 lúc
 * bật + Σ điều chỉnh lúc bật). Số lúc bật đọc từ kết quả yêu cầu bật; bản cũ thiếu vân tay ⇒ null (ẩn).
 */
const ketQuaBat = (quyApp: number, dieuChinh: { chieu: "IN" | "OUT"; soTien: number }[]) => ({
  ok: true,
  data: {
    mocM: "2026-11-01",
    soThe: 0,
    soVi: 0,
    dieuChinh: dieuChinh.map((d, i) => ({ id: `dc${i}`, ...d })),
    tacDong: 0,
    viShopeeChuaTheoDoi: false,
    vanTayQuy: { quyApp, duNoThauChi: 0, tongPhieuY: 0 },
  },
});

describe("docSoLieuLucBat", () => {
  it("đọc quỹ lúc bật + Σ CÓ DẤU các dòng điều chỉnh lúc bật", () => {
    expect(
      docSoLieuLucBat(
        ketQuaBat(150_000_000, [
          { chieu: "IN", soTien: 5_000_000 },
          { chieu: "OUT", soTien: 2_000_000 },
        ])
      )
    ).toEqual({ quyApp: 150_000_000, dieuChinhNet: 3_000_000 });
  });

  it("không có dòng điều chỉnh ⇒ Σ = 0", () => {
    expect(docSoLieuLucBat(ketQuaBat(-1_000, []))).toEqual({ quyApp: -1_000, dieuChinhNet: 0 });
  });

  it("bản cũ thiếu vân tay quỹ / kết quả lỗi / rác ⇒ null", () => {
    const { vanTayQuy: _bo, ...dataCu } = ketQuaBat(1, []).data;
    expect(docSoLieuLucBat({ ok: true, data: dataCu })).toBeNull();
    expect(docSoLieuLucBat({ ok: false, error: "x" })).toBeNull();
    expect(docSoLieuLucBat(null)).toBeNull();
    expect(docSoLieuLucBat({ ok: true, data: { ...ketQuaBat(1, []).data, vanTayQuy: { quyApp: 1.5 } } })).toBeNull();
  });

  it("hằng loại yêu cầu bật chép đúng hằng của bước bật", () => {
    expect(LOAI_YEU_CAU_BAT_DOC).toBe(LOAI_YEU_CAU_BAT);
  });
});

describe("netDieuChinh", () => {
  it("IN cộng, OUT trừ, kind khác bỏ qua", () => {
    expect(
      netDieuChinh([
        { kind: "CUTOVER_ADJ_IN", amount: 7 },
        { kind: "CUTOVER_ADJ_OUT", amount: 3 },
        { kind: "OTHER_IN", amount: 100 },
      ])
    ).toBe(4);
  });
});

describe("tinhTroiQuyTruocM", () => {
  const lucBat = { quyApp: 150_000_000, dieuChinhNet: 2_000_000 };

  it("không gì đổi ⇒ 0", () => {
    expect(tinhTroiQuyTruocM(lucBat, { quyApp: 150_000_000, dieuChinhNet: 2_000_000 })).toBe(0);
  });

  it("quỹ trước M tăng (rút ví về muộn) ⇒ dương đúng số", () => {
    expect(tinhTroiQuyTruocM(lucBat, { quyApp: 153_000_000, dieuChinhNet: 2_000_000 })).toBe(3_000_000);
  });

  it("quỹ trước M giảm (chi phí về muộn) ⇒ âm đúng số", () => {
    expect(tinhTroiQuyTruocM(lucBat, { quyApp: 149_250_000, dieuChinhNet: 2_000_000 })).toBe(-750_000);
  });

  it("điều chỉnh bù đúng phần đổi ⇒ 0 (lối sửa số tiền / chủ shop sửa dòng mở sổ)", () => {
    expect(tinhTroiQuyTruocM(lucBat, { quyApp: 153_000_000, dieuChinhNet: -1_000_000 })).toBe(0);
  });

  it("thiếu số lúc bật ⇒ null", () => {
    expect(tinhTroiQuyTruocM(null, { quyApp: 1, dieuChinhNet: 0 })).toBeNull();
  });
});

describe("chonDongNoiBat", () => {
  const d = (tacDong: number, khoaNgay: string): DongVeMuon => ({ nguon: "VI_SHOPEE", khoaNgay, tacDong, moTa: "" });

  it("xếp theo trị tuyệt đối giảm dần, hoà ⇒ ngày cũ trước, bỏ dòng 0đ, cắt theo trần", () => {
    const ra = chonDongNoiBat(
      [d(1, "2026-10-01"), d(-5, "2026-10-02"), d(0, "2026-10-03"), d(5, "2026-09-30"), d(3, "2026-10-04")],
      3
    );
    expect(ra.map((x) => [x.tacDong, x.khoaNgay])).toEqual([
      [5, "2026-09-30"],
      [-5, "2026-10-02"],
      [3, "2026-10-04"],
    ]);
  });
});
