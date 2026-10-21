import { describe, expect, it } from "vitest";

import { chuanHoaMoTa, timMauTrung } from "@/lib/expenses/mau-dinh-ky-trung";

/**
 * Nhận diện mẫu chi định kỳ "có vẻ trùng" — nhánh MÔ TẢ. Chuẩn hoá cũ chỉ `trim` + `toLowerCase`
 * nên "Tiền  nhà" (2 dấu cách) hay chuỗi NFD (một số bộ gõ) lọt khỏi cảnh báo dù nhìn y hệt.
 */
describe("chuanHoaMoTa", () => {
  it("NFD và NFC cùng một chữ ⇒ bằng nhau", () => {
    const nfd = "Tiền nhà".normalize("NFD");
    expect(nfd).not.toBe("Tiền nhà");
    expect(chuanHoaMoTa(nfd)).toBe(chuanHoaMoTa("Tiền nhà"));
  });

  it("gộp khoảng trắng liên tiếp (kể cả tab/xuống dòng), bỏ đầu cuối, không phân biệt hoa thường", () => {
    expect(chuanHoaMoTa("  TIỀN \t nhà\n tháng ")).toBe("tiền nhà tháng");
  });
});

describe("timMauTrung — nhánh mô tả", () => {
  const dangChay = [{ description: "Tiền nhà", amount: 5_000_000 }];

  it("mô tả khác cách gõ (NFD, 2 dấu cách) nhưng cùng chữ ⇒ trùng dù số tiền khác", () => {
    expect(timMauTrung(dangChay, { description: "tiền  nhà".normalize("NFD"), amount: 6_000_000 })).toEqual(
      dangChay[0],
    );
  });

  it("mô tả rỗng sau chuẩn hoá ⇒ không tính nhánh mô tả", () => {
    expect(timMauTrung([{ description: "  ", amount: 1 }], { description: " \t", amount: 2 })).toBeNull();
  });

  it("khác chữ thật ⇒ không trùng", () => {
    expect(timMauTrung(dangChay, { description: "Tiền điện", amount: 6_000_000 })).toBeNull();
  });
});
