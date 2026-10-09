import { describe, expect, it } from "vitest";

import {
  mocCatNenTang,
  mocCatViTraTruoc,
  theCuaDongChi,
  theCuaNenTang,
  type NguCanhLoc,
} from "@/lib/no-phai-tra/the-cua-dong-chi";

// Mọi ngày dựng ở 00:00 giờ VN (= 17:00Z hôm trước) để khớp cách app neo ngày.
const vn = (ymd: string) => new Date(`${ymd}T00:00:00+07:00`);

const M = vn("2026-11-01");

describe("theCuaNenTang / mocCatNenTang", () => {
  it("(a) mocM null ⇒ mọi hàm trả null dù đã gắn", () => {
    const ctx: NguCanhLoc = { mocM: null, gan: [{ cardId: "A", nenTang: "META", tuNgay: vn("2026-10-15") }], viAds: [] };
    expect(theCuaNenTang(ctx, "META", vn("2026-12-01"))).toBeNull();
    expect(mocCatNenTang(ctx, "META")).toBeNull();
    expect(
      theCuaDongChi(ctx, { cardId: null, categoryId: "ads", adsSource: "META", date: vn("2026-12-01") })
    ).toBeNull();
  });

  it("(b) gắn META→A từ 15/10, M=01/11 ⇒ mốc cắt 01/11; 31/10 null, 01/11 là A", () => {
    const ctx: NguCanhLoc = { mocM: M, gan: [{ cardId: "A", nenTang: "META", tuNgay: vn("2026-10-15") }], viAds: [] };
    expect(mocCatNenTang(ctx, "META")).toEqual(M);
    expect(theCuaNenTang(ctx, "META", vn("2026-10-31"))).toBeNull();
    expect(theCuaNenTang(ctx, "META", vn("2026-11-01"))).toBe("A");
  });

  it("(c) đổi thẻ B→C từ 15/11 ⇒ 14/11 là B, 15/11 là C", () => {
    const ctx: NguCanhLoc = {
      mocM: M,
      viAds: [],
      gan: [
        { cardId: "B", nenTang: "META", tuNgay: vn("2026-11-01") },
        { cardId: "C", nenTang: "META", tuNgay: vn("2026-11-15") },
      ],
    };
    expect(theCuaNenTang(ctx, "META", vn("2026-11-14"))).toBe("B");
    expect(theCuaNenTang(ctx, "META", vn("2026-11-15"))).toBe("C");
  });

  it("tuNgay ở tương lai ⇒ chưa hiệu lực; mốc cắt = tuNgay nếu sau M", () => {
    const ctx: NguCanhLoc = { mocM: M, gan: [{ cardId: "A", nenTang: "TIKTOK_ADS", tuNgay: vn("2026-12-10") }], viAds: [] };
    expect(theCuaNenTang(ctx, "TIKTOK_ADS", vn("2026-12-09"))).toBeNull();
    expect(theCuaNenTang(ctx, "TIKTOK_ADS", vn("2026-12-10"))).toBe("A");
    expect(mocCatNenTang(ctx, "TIKTOK_ADS")).toEqual(vn("2026-12-10"));
  });

  it("hai dòng gắn cùng nền tảng khác thẻ ⇒ lấy dòng tuNgay lớn nhất ≤ d, bất kể thứ tự mảng", () => {
    const ctx: NguCanhLoc = {
      mocM: M,
      viAds: [],
      gan: [
        { cardId: "C", nenTang: "META", tuNgay: vn("2026-11-20") },
        { cardId: "B", nenTang: "META", tuNgay: vn("2026-11-05") },
      ],
    };
    expect(theCuaNenTang(ctx, "META", vn("2026-11-10"))).toBe("B");
    expect(theCuaNenTang(ctx, "META", vn("2026-11-25"))).toBe("C");
    expect(mocCatNenTang(ctx, "META")).toEqual(vn("2026-11-05"));
  });

  it("so ngày theo khoá ngày VN: 23:30 VN ngày 31/10 vẫn là 31/10", () => {
    const ctx: NguCanhLoc = { mocM: M, gan: [{ cardId: "A", nenTang: "META", tuNgay: vn("2026-10-15") }], viAds: [] };
    expect(theCuaNenTang(ctx, "META", new Date("2026-10-31T23:30:00+07:00"))).toBeNull();
    expect(theCuaNenTang(ctx, "META", new Date("2026-11-01T00:30:00+07:00"))).toBe("A");
  });

  it("mocCatNenTang trả ĐẦU NGÀY VN: tuNgay 15/11 10:00 VN ⇒ 15/11 00:00 VN", () => {
    const ctx: NguCanhLoc = {
      mocM: M,
      viAds: [],
      gan: [{ cardId: "A", nenTang: "TIKTOK_ADS", tuNgay: new Date("2026-11-15T10:00:00+07:00") }],
    };
    expect(mocCatNenTang(ctx, "TIKTOK_ADS")).toEqual(vn("2026-11-15"));
  });

  it("mocCatNenTang: mocM parse 00:00 UTC (= 07:00 VN) vẫn ra 00:00 VN cùng ngày", () => {
    const ctx: NguCanhLoc = {
      mocM: new Date("2026-11-01T00:00:00Z"),
      viAds: [],
      gan: [{ cardId: "A", nenTang: "META", tuNgay: vn("2026-10-15") }],
    };
    expect(mocCatNenTang(ctx, "META")).toEqual(vn("2026-11-01"));
  });

  it("mocCatNenTang chỉ xét dòng gắn của ĐÚNG nền tảng", () => {
    const ctx: NguCanhLoc = {
      mocM: M,
      viAds: [],
      gan: [
        { cardId: "A", nenTang: "META", tuNgay: vn("2026-11-05") },
        { cardId: "B", nenTang: "TIKTOK_ADS", tuNgay: vn("2026-11-20") },
      ],
    };
    expect(mocCatNenTang(ctx, "TIKTOK_ADS")).toEqual(vn("2026-11-20"));
  });

  it("nền tảng chưa gắn ⇒ null", () => {
    const ctx: NguCanhLoc = { mocM: M, gan: [], viAds: [] };
    expect(theCuaNenTang(ctx, "SHOPEE_ADS", vn("2026-11-05"))).toBeNull();
    expect(mocCatNenTang(ctx, "SHOPEE_ADS")).toBeNull();
  });
});

describe("theCuaDongChi — luật thẻ duy nhất", () => {
  const ctx: NguCanhLoc = { mocM: M, gan: [{ cardId: "A", nenTang: "META", tuNgay: vn("2026-11-01") }], viAds: [] };

  it("(d) cardId thắng nền tảng: cardId=B + ads META (gắn A) ⇒ B", () => {
    expect(theCuaDongChi(ctx, { cardId: "B", categoryId: "ads", adsSource: "META", date: vn("2026-11-05") })).toBe("B");
  });

  it("(d) không cardId, ads SHOPEE_ADS chưa gắn ⇒ null", () => {
    expect(theCuaDongChi(ctx, { cardId: null, categoryId: "ads", adsSource: "SHOPEE_ADS", date: vn("2026-11-05") })).toBeNull();
  });

  it("ads có nguồn đã gắn ⇒ thẻ của nền tảng", () => {
    expect(theCuaDongChi(ctx, { cardId: null, categoryId: "ads", adsSource: "META", date: vn("2026-11-05") })).toBe("A");
  });

  it("ads nhập tay không adsSource ⇒ null; danh mục khác không cardId ⇒ null", () => {
    expect(theCuaDongChi(ctx, { cardId: null, categoryId: "ads", adsSource: null, date: vn("2026-11-05") })).toBeNull();
    expect(theCuaDongChi(ctx, { cardId: null, categoryId: "other", adsSource: "META", date: vn("2026-11-05") })).toBeNull();
  });

  it("danh mục khác có cardId, date ≥ M ⇒ cardId (đúng ngày M cũng tính)", () => {
    expect(theCuaDongChi(ctx, { cardId: "A", categoryId: "other", adsSource: null, date: vn("2026-11-02") })).toBe("A");
    expect(theCuaDongChi(ctx, { cardId: "A", categoryId: "other", adsSource: null, date: vn("2026-11-01") })).toBe("A");
  });

  it("cardId nhưng date < M ⇒ null (dòng trước M luôn trừ quỹ, không cộng nợ thẻ)", () => {
    expect(theCuaDongChi(ctx, { cardId: "A", categoryId: "other", adsSource: null, date: vn("2026-10-20") })).toBeNull();
    expect(
      theCuaDongChi(ctx, { cardId: "A", categoryId: "other", adsSource: null, date: new Date("2026-10-31T23:30:00+07:00") })
    ).toBeNull();
  });

  it("mocM null ⇒ null KỂ CẢ khi dòng có cardId", () => {
    expect(
      theCuaDongChi({ mocM: null, gan: [], viAds: [] }, { cardId: "A", categoryId: "other", adsSource: null, date: vn("2026-12-01") })
    ).toBeNull();
  });
});

describe("mocCatViTraTruoc — nhánh ví trả trước chỉ khi có hồ sơ", () => {
  it("chưa có hồ sơ ví ⇒ null (không loại khỏi quỹ)", () => {
    expect(mocCatViTraTruoc({ mocM: M, gan: [], viAds: [] }, "SHOPEE_ADS")).toBeNull();
    expect(
      mocCatViTraTruoc({ mocM: M, gan: [], viAds: [{ nenTang: "SHOPEE_ADS", ngayNeo: vn("2026-10-31") }] }, "META")
    ).toBeNull();
  });

  it("M null ⇒ null dù có hồ sơ", () => {
    expect(
      mocCatViTraTruoc({ mocM: null, gan: [], viAds: [{ nenTang: "SHOPEE_ADS", ngayNeo: vn("2026-10-31") }] }, "SHOPEE_ADS")
    ).toBeNull();
  });

  it("neo cuối ngày 31/10 (giờ lẻ) ⇒ cắt từ 01/11 00:00 VN = max(M, ngày sau neo)", () => {
    const viAds = [{ nenTang: "SHOPEE_ADS", ngayNeo: new Date("2026-10-31T21:30:00+07:00") }];
    expect(mocCatViTraTruoc({ mocM: M, gan: [], viAds }, "SHOPEE_ADS")).toEqual(vn("2026-11-01"));
  });

  it("neo SAU M (10/11) ⇒ cắt từ 11/11; neo trước M (20/10) ⇒ cắt từ M", () => {
    const sau = [{ nenTang: "SHOPEE_ADS", ngayNeo: vn("2026-11-10") }];
    expect(mocCatViTraTruoc({ mocM: M, gan: [], viAds: sau }, "SHOPEE_ADS")).toEqual(vn("2026-11-11"));
    const truoc = [{ nenTang: "SHOPEE_ADS", ngayNeo: vn("2026-10-20") }];
    expect(mocCatViTraTruoc({ mocM: M, gan: [], viAds: truoc }, "SHOPEE_ADS")).toEqual(M);
  });
});
