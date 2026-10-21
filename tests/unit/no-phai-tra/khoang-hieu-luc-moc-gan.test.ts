import { describe, expect, it } from "vitest";

import { khoangHieuLucCacMoc, type MocGanDeTinhKhoang } from "@/lib/no-phai-tra/khoang-hieu-luc-moc-gan";
import { theCuaNenTang } from "@/lib/no-phai-tra/the-cua-dong-chi";
import { khoaNgayVn } from "@/lib/so-quy/dong-chay-so-quy";

const vn = (ngay: string, gio = "00:00:00") => new Date(`${ngay}T${gio}+07:00`);
const moc = (id: string, cardId: string, nenTang: string, ngay: string): MocGanDeTinhKhoang => ({
  id,
  cardId,
  nenTang,
  tuNgay: vn(ngay),
});

describe("khoangHieuLucCacMoc", () => {
  it("ca prod 3 mốc cùng thẻ: denNgay = ngày trước mốc kế; mốc cuối null", () => {
    const k = khoangHieuLucCacMoc([
      moc("p1", "A", "TIKTOK_ADS", "2026-08-01"),
      moc("p2", "A", "TIKTOK_ADS", "2026-09-13"),
      moc("p3", "A", "TIKTOK_ADS", "2026-10-09"),
    ]);
    expect(k.get("p1")).toEqual({ denNgay: vn("2026-09-12"), cardIdKeTiep: "A" });
    expect(k.get("p2")).toEqual({ denNgay: vn("2026-10-08"), cardIdKeTiep: "A" });
    expect(k.get("p3")).toEqual({ denNgay: null, cardIdKeTiep: null });
  });

  it("đổi thẻ: mốc kế ở thẻ KHÁC vẫn cắt khoảng của thẻ cũ và báo thẻ kế tiếp", () => {
    const k = khoangHieuLucCacMoc([moc("a1", "A", "TIKTOK_ADS", "2026-08-01"), moc("b1", "B", "TIKTOK_ADS", "2026-09-13")]);
    expect(k.get("a1")).toEqual({ denNgay: vn("2026-09-12"), cardIdKeTiep: "B" });
    expect(k.get("b1")).toEqual({ denNgay: null, cardIdKeTiep: null });
  });

  it("denNgay qua ranh giới tháng/năm; nền tảng khác không ảnh hưởng", () => {
    const k = khoangHieuLucCacMoc([
      moc("m1", "A", "META", "2026-12-15"),
      moc("m2", "A", "META", "2027-01-01"),
      moc("t1", "B", "TIKTOK_ADS", "2026-12-20"),
    ]);
    expect(k.get("m1")?.denNgay).toEqual(vn("2026-12-31"));
    expect(k.get("t1")).toEqual({ denNgay: null, cardIdKeTiep: null });
  });

  it("mốc không chuẩn hoá 00:00 (10:00) vẫn cắt theo NGÀY VN", () => {
    const k = khoangHieuLucCacMoc([
      { id: "x1", cardId: "A", nenTang: "META", tuNgay: vn("2026-09-01", "10:00:00") },
      { id: "x2", cardId: "B", nenTang: "META", tuNgay: vn("2026-09-13", "23:30:00") },
    ]);
    expect(k.get("x1")?.denNgay).toEqual(vn("2026-09-12"));
  });

  it("ĐỐI CHIẾU nguồn chuẩn: mỗi ngày kể từ mốc đầu, thẻ gánh theo theCuaNenTang = thẻ của đúng một khoảng chứa ngày đó", () => {
    const gan = [
      moc("a1", "A", "TIKTOK_ADS", "2026-08-01"),
      moc("b1", "B", "TIKTOK_ADS", "2026-09-13"),
      moc("a2", "A", "TIKTOK_ADS", "2026-10-09"),
      moc("m1", "A", "META", "2026-09-01"),
      moc("m2", "B", "META", "2026-10-05"),
    ];
    const k = khoangHieuLucCacMoc(gan);
    const ctx = { mocM: vn("2026-07-01"), gan: gan.map(({ cardId, nenTang, tuNgay }) => ({ cardId, nenTang, tuNgay })), viAds: [] };
    for (const nenTang of ["TIKTOK_ADS", "META"]) {
      const cua = gan.filter((g) => g.nenTang === nenTang);
      const dauTien = Math.min(...cua.map((g) => g.tuNgay.getTime()));
      for (let t = dauTien; t < vn("2026-11-15").getTime(); t += 86_400_000) {
        const ngay = new Date(t + 12 * 3600_000); // giữa ngày VN
        const chua = cua.filter((g) => khoaNgayVn(g.tuNgay) <= khoaNgayVn(ngay) && (k.get(g.id)!.denNgay === null || khoaNgayVn(k.get(g.id)!.denNgay!) >= khoaNgayVn(ngay)));
        expect(chua, `${nenTang} ${khoaNgayVn(ngay)}`).toHaveLength(1);
        expect(theCuaNenTang(ctx, nenTang, ngay)).toBe(chua[0].cardId);
      }
    }
  });
});
