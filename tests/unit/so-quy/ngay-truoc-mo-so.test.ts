import { describe, expect, it } from "vitest";

import { ngayTruocMoSo } from "@/lib/so-quy/ngay-truoc-mo-so";

/**
 * Phép so DUY NHẤT dùng chung cho ba form sinh dòng tiền thật (ghi tay, khoản vay, sổ tiết kiệm) để
 * hỏi lại khi ngày ghi sớm hơn D0 (ngày mở sổ quỹ). Ca thật đã gặp: 2 khoản vay giải ngân ĐÚNG ngày
 * 12/05/2026 — ngày đó CHÍNH LÀ D0 (dòng LOAN_IN đầu tiên) nên KHÔNG được hỏi, dù trực giác "ngày
 * này ⩽ D0" dễ viết nhầm thành hỏi luôn cả ngày bằng D0.
 */
describe("ngayTruocMoSo", () => {
  it("d0 null (chưa mở sổ) → không hỏi", () => {
    expect(ngayTruocMoSo("2026-01-01", null)).toBe(false);
  });

  it("ngày rỗng (đang gõ dở) → không hỏi", () => {
    expect(ngayTruocMoSo("", new Date("2026-05-12T00:00:00+07:00"))).toBe(false);
  });

  it("ngày sớm hơn D0 → hỏi", () => {
    expect(ngayTruocMoSo("2026-05-11", new Date("2026-05-12T00:00:00+07:00"))).toBe(true);
  });

  it("ĐÚNG ngày D0 → không hỏi (ca thật: giải ngân đúng ngày mở sổ)", () => {
    expect(ngayTruocMoSo("2026-05-12", new Date("2026-05-12T00:00:00+07:00"))).toBe(false);
  });

  it("ngày sau D0 → không hỏi", () => {
    expect(ngayTruocMoSo("2026-05-13", new Date("2026-05-12T00:00:00+07:00"))).toBe(false);
  });

  it("D0 mang giờ lẻ (không phải 00:00) — vẫn so theo NGÀY, đúng ngày D0 vẫn không hỏi", () => {
    const d0GioLe = new Date("2026-05-12T14:37:00+07:00");
    expect(ngayTruocMoSo("2026-05-12", d0GioLe)).toBe(false);
    expect(ngayTruocMoSo("2026-05-11", d0GioLe)).toBe(true);
  });
});
