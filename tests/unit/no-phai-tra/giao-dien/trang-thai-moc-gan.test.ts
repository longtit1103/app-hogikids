import { describe, expect, it } from "vitest";

import { laMocSapApDung, mocGanHienThi, moTaKhoangHieuLuc, ngayVnHienThi } from "@/components/no-phai-tra/trang-thai-moc-gan";
import { khoangHieuLucCacMoc } from "@/lib/no-phai-tra/khoang-hieu-luc-moc-gan";
import type { MocGanThe } from "@/lib/no-phai-tra/the-tin-dung-queries";

const vn = (ngay: string, gio = "00:00:00") => new Date(`${ngay}T${gio}+07:00`);
const HOM_NAY = vn("2026-10-10", "15:00:00");
const TEN_THE: Record<string, string> = { A: "Thẻ A", B: "Thẻ B" };

/** Dựng `MocGanThe` của MỘT thẻ từ danh sách mốc MỌI thẻ — đúng đường server (`docTheKemTrangThai`). */
function mocCuaThe(cardId: string, tatCa: { id: string; cardId: string; nenTang: string; tuNgay: Date }[]): MocGanThe[] {
  const khoang = khoangHieuLucCacMoc(tatCa);
  return tatCa
    .filter((g) => g.cardId === cardId)
    .map((g) => {
      const k = khoang.get(g.id)!;
      const ke = k.cardIdKeTiep;
      return {
        id: g.id,
        nenTang: g.nenTang,
        tuNgay: g.tuNgay,
        xoaDuoc: true,
        denNgay: k.denNgay,
        theKeTiep: ke === null || ke === cardId ? null : (TEN_THE[ke] ?? null),
      };
    });
}

const PROD = [
  { id: "p1", cardId: "A", nenTang: "TIKTOK_ADS", tuNgay: vn("2026-08-01") },
  { id: "p2", cardId: "A", nenTang: "TIKTOK_ADS", tuNgay: vn("2026-09-13") },
  { id: "p3", cardId: "A", nenTang: "TIKTOK_ADS", tuNgay: vn("2026-10-09") },
];
const DOI_THE = [
  { id: "a1", cardId: "A", nenTang: "TIKTOK_ADS", tuNgay: vn("2026-08-01") },
  { id: "b1", cardId: "B", nenTang: "TIKTOK_ADS", tuNgay: vn("2026-09-13") },
];

describe("moTaKhoangHieuLuc", () => {
  it("ca 3 mốc cùng thẻ: khoảng liền nhau, mốc cuối chỉ 'từ'", () => {
    expect(mocCuaThe("A", PROD).map(moTaKhoangHieuLuc)).toEqual([
      "từ 01/08/2026 đến 12/09/2026",
      "từ 13/09/2026 đến 08/10/2026",
      "từ 09/10/2026",
    ]);
  });

  it("ca đổi thẻ: thẻ cũ ghi 'đến' ngày trước mốc thẻ mới + tên thẻ sau đó; thẻ mới chỉ 'từ'", () => {
    expect(mocCuaThe("A", DOI_THE).map(moTaKhoangHieuLuc)).toEqual(["từ 01/08/2026 đến 12/09/2026 (sau đó: Thẻ B)"]);
    expect(mocCuaThe("B", DOI_THE).map(moTaKhoangHieuLuc)).toEqual(["từ 13/09/2026"]);
  });

  it("nền tảng khác nhau không chen vào khoảng của nhau", () => {
    const gan = [...PROD, { id: "m1", cardId: "A", nenTang: "META", tuNgay: vn("2026-09-01") }];
    expect(mocCuaThe("A", gan).find((g) => g.id === "m1")).toMatchObject({ denNgay: null });
    expect(mocCuaThe("A", gan).find((g) => g.id === "p1")).toMatchObject({ denNgay: vn("2026-09-12") });
  });
});

describe("mocGanHienThi", () => {
  it("CHƯA bật: đủ mọi mốc, sắp tăng dần, không loại mốc nào kể cả mốc đã bị mốc sau nối tiếp", () => {
    const ds = mocGanHienThi([...mocCuaThe("A", PROD)].reverse(), false, HOM_NAY);
    expect(ds.map((g) => g.id)).toEqual(["p1", "p2", "p3"]);
  });

  it("ĐÃ bật: bỏ mốc đã bị thay trước hôm nay (kể cả thay bởi mốc ở thẻ KHÁC), giữ đang gánh + sắp áp dụng", () => {
    expect(mocGanHienThi(mocCuaThe("A", PROD), true, HOM_NAY).map((g) => g.id)).toEqual(["p3"]);
    expect(mocGanHienThi(mocCuaThe("A", DOI_THE), true, HOM_NAY)).toEqual([]);
    expect(mocGanHienThi(mocCuaThe("B", DOI_THE), true, HOM_NAY).map((g) => g.id)).toEqual(["b1"]);
    const tuongLai = [...PROD, { id: "p4", cardId: "A", nenTang: "TIKTOK_ADS", tuNgay: vn("2026-11-01") }];
    expect(mocGanHienThi(mocCuaThe("A", tuongLai), true, HOM_NAY).map((g) => g.id)).toEqual(["p3", "p4"]);
  });

  it("mốc thay thế đúng HÔM NAY đã thay mốc trước; mốc thay thế ngày mai thì chưa", () => {
    const homNayLaMocMoi = [
      { id: "x1", cardId: "A", nenTang: "META", tuNgay: vn("2026-09-01") },
      { id: "x2", cardId: "A", nenTang: "META", tuNgay: vn("2026-10-10", "09:00:00") },
    ];
    expect(mocGanHienThi(mocCuaThe("A", homNayLaMocMoi), true, HOM_NAY).map((g) => g.id)).toEqual(["x2"]);
    const ngayMaiLaMocMoi = [homNayLaMocMoi[0], { id: "x3", cardId: "A", nenTang: "META", tuNgay: vn("2026-10-11") }];
    expect(mocGanHienThi(mocCuaThe("A", ngayMaiLaMocMoi), true, HOM_NAY).map((g) => g.id)).toEqual(["x1", "x3"]);
  });
});

describe("ngày theo giờ VN, không theo múi giờ trình duyệt", () => {
  it("laMocSapApDung / ngayVnHienThi dùng khoá ngày VN", () => {
    // 11/10 00:00 VN = 10/10 17:00 UTC: máy UTC mà so ngày địa phương sẽ coi là 'hôm nay', hiện lùi 1 ngày.
    expect(laMocSapApDung({ tuNgay: vn("2026-10-11") }, HOM_NAY)).toBe(true);
    expect(laMocSapApDung({ tuNgay: vn("2026-10-10") }, HOM_NAY)).toBe(false);
    expect(ngayVnHienThi(vn("2026-10-11"))).toBe("11/10/2026");
  });
});
