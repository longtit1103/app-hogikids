import { describe, expect, it } from "vitest";

import type { SoQuyThang } from "@/lib/so-quy/cong-thuc-so-quy";
import {
  CAU_TRUC_RONG,
  cauChenhLech,
  ghepDoiChieuSoDuChot,
  thangChot,
  tinhChenhLechChot,
  tinhKhoanCauTruc,
} from "@/lib/so-quy/doi-chieu-so-du-chot";

/**
 * Công thức thuần của bản chốt số dư. Quy ước dấu và CÂU CHỮ là thứ đáng khoá nhất: chủ shop đọc
 * nhầm dấu / nhầm hướng là sửa sổ NGƯỢC chiều — nên mỗi ca khẳng định literal, cả số lẫn chữ.
 */
describe("tinhChenhLechChot — (bank + tiền mặt) − cuối kỳ, rồi CỘNG dư nợ thấu chi", () => {
  it("khớp sổ ⇒ 0", () => {
    expect(tinhChenhLechChot({ soDuBank: 85_000_000, tienMat: 5_000_000 }, 90_000_000)).toEqual({
      soChot: 90_000_000,
      chenhLechTho: 0,
      chenhLech: 0,
    });
  });

  it("tiền thật NHIỀU HƠN sổ ⇒ DƯƠNG", () => {
    expect(tinhChenhLechChot({ soDuBank: 92_000_000, tienMat: 1_000_000 }, 90_000_000).chenhLech).toBe(3_000_000);
  });

  it("sổ NHIỀU HƠN tiền thật ⇒ ÂM", () => {
    expect(tinhChenhLechChot({ soDuBank: 85_000_000, tienMat: 3_000_000 }, 90_000_000).chenhLech).toBe(-2_000_000);
  });

  it("thấu chi: quỹ = bank + tiền mặt + dư nợ — ca bẫy: góp 30tr, thấu chi 20tr cầm mặt", () => {
    // quỹ 50tr · bank tổng 10tr (30 − 20) · tiền mặt 20tr · dư nợ thấu chi 20tr ⇒ thô −20tr, thật 0.
    const r = tinhChenhLechChot({ soDuBank: 10_000_000, tienMat: 20_000_000 }, 50_000_000, 20_000_000);
    expect(r).toEqual({ soChot: 30_000_000, chenhLechTho: -20_000_000, chenhLech: 0 });
  });

  it("bank ÂM (thấu chi rút rồi chi hết) vẫn cộng đúng, không lấy trị tuyệt đối", () => {
    expect(tinhChenhLechChot({ soDuBank: -20_000_000, tienMat: 0 }, 0, 20_000_000)).toEqual({
      soChot: -20_000_000,
      chenhLechTho: -20_000_000,
      chenhLech: 0,
    });
  });
});

describe("cauChenhLech — chữ chỉ ĐÚNG hướng đi tìm", () => {
  it("0 ⇒ Khớp sổ", () => {
    expect(cauChenhLech(0)).toEqual({
      nhan: "Khớp sổ",
      giaiThich: "Tiền thật bằng đúng số cuối kỳ của sổ quỹ.",
      tone: "khop",
    });
  });

  it("0 có thấu chi ⇒ nói rõ đã cộng dư nợ", () => {
    expect(cauChenhLech(0, { duNoThauChi: 20_000_000, tienDangGui: 0 }).giaiThich).toBe(
      "Tiền thật + dư nợ thấu chi 20.000.000 ₫ bằng đúng số cuối kỳ của sổ quỹ."
    );
  });

  it("DƯƠNG ⇒ đi tìm THU chưa ghi / CHI ghi thừa", () => {
    expect(cauChenhLech(3_000_000)).toEqual({
      nhan: "Tiền thật NHIỀU HƠN sổ 3.000.000 ₫",
      giaiThich:
        "Có khoản thu chưa ghi vào sổ, hoặc khoản chi ghi thừa / ghi trùng. Kiểm trước: quảng cáo trả bằng " +
        "thẻ tín dụng đã trừ vào sổ ngay ngày chạy — dư nợ thẻ CHƯA thanh toán phải trừ khỏi số dư ngân hàng khi chốt.",
      tone: "duong",
    });
  });

  it("ÂM ⇒ đi tìm CHI chưa ghi / THU ghi thừa", () => {
    expect(cauChenhLech(-2_000_000)).toEqual({
      nhan: "Sổ NHIỀU HƠN tiền thật 2.000.000 ₫",
      giaiThich: "Có khoản chi chưa ghi vào sổ, hoặc khoản thu ghi thừa / ghi trùng.",
      tone: "am",
    });
  });

  it("DƯƠNG đúng bằng tiền đang gửi ⇒ 'bạn cộng nhầm', KHÔNG phải sai sổ", () => {
    const c = cauChenhLech(100_000_000, { duNoThauChi: 0, tienDangGui: 100_000_000 });
    expect(c.tone).toBe("duong");
    expect(c.giaiThich).toBe(
      "Đúng bằng 100.000.000 ₫ đang gửi tiết kiệm / tiền gửi bắt buộc — bạn đã cộng số đó vào số dư ngân hàng. Trừ ra là khớp, KHÔNG phải sai sổ."
    );
  });

  it("DƯƠNG khác tiền đang gửi ⇒ vẫn dặn kiểm cộng nhầm trước", () => {
    const c = cauChenhLech(3_000_000, { duNoThauChi: 0, tienDangGui: 100_000_000 });
    expect(c.giaiThich).toContain("Có khoản thu chưa ghi vào sổ");
    expect(c.giaiThich).toContain("Kiểm trước: số dư bạn gõ có cộng nhầm 100.000.000 ₫");
  });
});

describe("tinhKhoanCauTruc — chỉ khoản CÒN HIỆU LỰC", () => {
  it("thấu chi chỉ lấy OVERDRAFT chưa đóng; tiền gửi bắt buộc lấy mọi khoản chưa đóng; cộng sổ tiết kiệm", () => {
    const loans = [
      { kind: "OVERDRAFT", closedAt: null, duNo: 20_000_000, tienGuiDangGiu: 0 },
      { kind: "OVERDRAFT", closedAt: new Date(), duNo: 5_000_000, tienGuiDangGiu: 0 }, // đã tất toán ⇒ bỏ
      { kind: "BULLET", closedAt: null, duNo: 200_000_000, tienGuiDangGiu: 30_000_000 },
      { kind: "TERM", closedAt: null, duNo: 50_000_000, tienGuiDangGiu: 0 },
    ];
    expect(tinhKhoanCauTruc(loans, 60_000_000)).toEqual({ duNoThauChi: 20_000_000, tienDangGui: 90_000_000 });
    expect(tinhKhoanCauTruc([], 0)).toEqual(CAU_TRUC_RONG);
  });
});

describe("thangChot — mọi ngày trong tháng về cùng mốc đầu tháng", () => {
  it("đầu, giữa, cuối tháng ⇒ cùng một khoá", () => {
    const dau = thangChot(new Date(2026, 7, 1, 9, 30));
    const giua = thangChot(new Date(2026, 7, 15, 23, 59));
    const cuoi = thangChot(new Date(2026, 7, 31, 12));
    expect(dau.getTime()).toBe(giua.getTime());
    expect(giua.getTime()).toBe(cuoi.getTime());
    expect(dau).toEqual(new Date(2026, 7, 1, 0, 0, 0, 0));
  });

  it("ngày 1 của tháng sau là khoá KHÁC", () => {
    expect(thangChot(new Date(2026, 8, 1)).getTime()).not.toBe(thangChot(new Date(2026, 7, 31)).getTime());
  });
});

describe("ghepDoiChieuSoDuChot — thuần, nói rõ vì sao không có gì để so", () => {
  const T8 = { from: new Date(2026, 7, 1), to: new Date(2026, 7, 31) };
  const soQuy = (ghiDe: Partial<SoQuyThang>): SoQuyThang => ({
    d0: new Date(2026, 6, 5),
    dauKy: 100_000_000,
    thu: 0,
    chi: 10_000_000,
    cuoiKy: 90_000_000,
    quyHomNay: 90_000_000,
    truocMoSo: false,
    ...ghiDe,
  });
  const dong = (thang: Date) => ({ thang, soDuBank: 85_000_000, tienMat: 3_000_000, note: "", updatedAt: new Date(2026, 8, 1) });
  const T8_ROW = dong(new Date(2026, 7, 1));
  const T7_ROW = dong(new Date(2026, 6, 1));

  it("chưa mở sổ ⇒ 'chua_mo_so', bỏ qua cả khi có dòng chốt", () => {
    expect(ghepDoiChieuSoDuChot(T8, soQuy({ d0: null }), { thangNay: T8_ROW, thangTruoc: null }).khaDung).toBe("chua_mo_so");
  });

  it("kỳ trước ngày mở sổ ⇒ 'truoc_mo_so'", () => {
    expect(ghepDoiChieuSoDuChot(T8, soQuy({ truocMoSo: true }), { thangNay: null, thangTruoc: null }).khaDung).toBe("truoc_mo_so");
  });

  it("có sổ, chưa chốt ⇒ 'ok' + chot/chenhLech null, cuoiKy + quyHomNay giữ NGUYÊN từ sổ", () => {
    expect(ghepDoiChieuSoDuChot(T8, soQuy({ quyHomNay: 95_000_000 }), { thangNay: null, thangTruoc: T7_ROW })).toMatchObject({
      khaDung: "ok",
      chot: null,
      chenhLech: null,
      cuoiKy: 90_000_000,
      quyHomNay: 95_000_000,
      thangTruocChuaChot: null,
    });
  });

  it("có sổ, có chốt ⇒ số literal đúng dấu; thấu chi được cộng", () => {
    const dc = ghepDoiChieuSoDuChot(T8, soQuy({}), { thangNay: T8_ROW, thangTruoc: T7_ROW }, { duNoThauChi: 2_000_000, tienDangGui: 0 });
    expect(dc).toMatchObject({ khaDung: "ok", soChot: 88_000_000, chenhLechTho: -2_000_000, chenhLech: 0 });
    expect(dc.thang).toEqual(new Date(2026, 7, 1));
  });

  it("tháng trước chưa chốt VÀ đã tới lúc chốt (≥ tháng mở sổ) ⇒ thangTruocChuaChot = tháng đó", () => {
    const dc = ghepDoiChieuSoDuChot(T8, soQuy({}), { thangNay: null, thangTruoc: null });
    expect(dc.thangTruocChuaChot).toEqual(new Date(2026, 6, 1));
  });

  it("tháng trước nằm TRƯỚC tháng mở sổ ⇒ không nhắc", () => {
    // D0 = 05/08 ⇒ tháng mở sổ = T8; tháng trước T8 là T7 < T8 ⇒ không có gì để chốt.
    const dc = ghepDoiChieuSoDuChot(T8, soQuy({ d0: new Date(2026, 7, 5) }), { thangNay: null, thangTruoc: null });
    expect(dc.thangTruocChuaChot).toBeNull();
  });

  it("dòng đưa vào thuộc THÁNG KHÁC ⇒ ném lỗi, không ghép âm thầm", () => {
    expect(() => ghepDoiChieuSoDuChot(T8, soQuy({}), { thangNay: T7_ROW, thangTruoc: null })).toThrow(/thuộc tháng khác/);
    expect(() => ghepDoiChieuSoDuChot(T8, soQuy({}), { thangNay: null, thangTruoc: T8_ROW })).toThrow(/thuộc tháng khác/);
  });
});
