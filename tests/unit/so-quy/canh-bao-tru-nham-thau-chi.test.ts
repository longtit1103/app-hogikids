import { describe, expect, it } from "vitest";

import { CAU_TRU_NHAM_THAU_CHI, laTruNhamThauChi } from "@/lib/so-quy/canh-bao-tru-nham-thau-chi";
import { cauChenhLech } from "@/lib/so-quy/doi-chieu-so-du-chot";
import { tinhChenhLechTaiM } from "@/lib/no-phai-tra/tinh-chenh-lech-tai-m";

/**
 * Cảnh báo "trừ nhầm dư nợ thấu chi": chênh (hoặc phần chưa giải thích ở bước bật) rơi đúng −dư nợ ±1.000đ.
 * Số 15/10 (đã gột): ngân hàng 62.400.000, quỹ 357.445.000, thẻ 33.650.000, thấu chi 137tr.
 */
const THAU_CHI = 137_000_000;

describe("laTruNhamThauChi", () => {
  it("đúng −dư nợ ⇒ true; lệch trong ±1.000đ ⇒ true; lệch hơn ⇒ false", () => {
    expect(laTruNhamThauChi(-THAU_CHI, THAU_CHI)).toBe(true);
    expect(laTruNhamThauChi(-THAU_CHI + 1_000, THAU_CHI)).toBe(true);
    expect(laTruNhamThauChi(-THAU_CHI - 1_000, THAU_CHI)).toBe(true);
    expect(laTruNhamThauChi(-THAU_CHI + 1_001, THAU_CHI)).toBe(false);
    expect(laTruNhamThauChi(THAU_CHI, THAU_CHI)).toBe(false);
  });

  it("không có dư nợ thấu chi ⇒ không bao giờ cảnh báo (kể cả chênh 0)", () => {
    expect(laTruNhamThauChi(0, 0)).toBe(false);
  });
});

describe("cauChenhLech — trừ nhầm dư nợ thấu chi", () => {
  const cauTruc = { duNoThauChi: THAU_CHI, tienDangGui: 0 };

  it("chênh đúng −dư nợ ⇒ câu cảnh báo, vẫn tone 'am'", () => {
    const c = cauChenhLech(-THAU_CHI, cauTruc);
    expect(c.giaiThich).toBe(CAU_TRU_NHAM_THAU_CHI);
    expect(c.nhan).toBe("Sổ NHIỀU HƠN tiền thật 137.000.000 ₫");
    expect(c.tone).toBe("am");
  });

  it("chênh khác −dư nợ ⇒ câu cũ, không cảnh báo", () => {
    const c = cauChenhLech(-295_045_000, cauTruc);
    expect(c.giaiThich).not.toContain("dư nợ thấu chi");
    expect(c.giaiThich).toContain("Có khoản chi chưa ghi vào sổ");
  });

  it("không có thấu chi ⇒ chênh −100tr vẫn là câu cũ", () => {
    expect(cauChenhLech(-THAU_CHI, { duNoThauChi: 0, tienDangGui: 0 }).giaiThich).not.toContain("thấu chi");
  });
});

describe("bước bật — phần chưa giải thích so với dư nợ thấu chi", () => {
  const dau = (soDuBank: number, quyApp = 357_445_000, the = 33_650_000) => ({
    quyApp,
    soDuBank,
    tienMat: 0,
    duNoThauChi: THAU_CHI,
    the: the === 0 ? [] : [{ khoa: "the:9999", nhan: "nợ thẻ 9999", soTien: the }],
    phieuY: [],
    viAds: [],
  });
  const canhBao = (kq: ReturnType<typeof tinhChenhLechTaiM>) => laTruNhamThauChi(kq.chuaGiaiThich, kq.duNoThauChi);

  it("số 15/10 (đã gột) gõ ĐÚNG số dư ngân hàng ⇒ chưa giải thích −328.695.000 ⇒ KHÔNG cảnh báo", () => {
    const kq = tinhChenhLechTaiM(dau(62_400_000));
    expect(kq.chuaGiaiThich).toBe(-328_695_000);
    expect(canhBao(kq)).toBe(false);
  });

  it("sổ đã đúng (quỹ = tiền thật) mà gõ 62.400.000 − 137tr = −74.600.000 ⇒ chênh −137tr ⇒ CÓ cảnh báo", () => {
    const kq = tinhChenhLechTaiM(dau(-74_600_000, 62_400_000, 0));
    expect(kq.chuaGiaiThich).toBe(-THAU_CHI);
    expect(canhBao(kq)).toBe(true);
  });

  it("gõ đúng khi sổ đúng ⇒ chưa giải thích 0 ⇒ không cảnh báo", () => {
    expect(canhBao(tinhChenhLechTaiM(dau(62_400_000, 62_400_000, 0)))).toBe(false);
  });
});
