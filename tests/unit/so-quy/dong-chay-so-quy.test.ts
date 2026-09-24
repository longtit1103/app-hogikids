import { describe, expect, it } from "vitest";

import { TONG_RONG, tinhQuyTuTong } from "@/lib/so-quy/cong-thuc-so-quy";
import {
  dongGopCuaSuKien,
  dungDongChay,
  gopChiPhiAdsTheoNgay,
  khoaNgayVn,
  type SuKienQuy,
} from "@/lib/so-quy/dong-chay-so-quy";

/**
 * Lõi thuần Sổ quỹ dòng chạy: dấu từng dòng (suy từ công thức thẻ Quỹ, không tự viết), thứ tự tất
 * định, số dư chạy, gộp ads tự động theo ngày VN. Dữ liệu DB thật ở
 * `tests/so-quy/dong-chay-so-quy.integration.test.ts`.
 */

const vn = (iso: string) => new Date(`${iso}+07:00`);

function sk(p: Partial<SuKienQuy> & Pick<SuKienQuy, "nguon" | "truong" | "giaTri">): SuKienQuy {
  return { key: `${p.nguon}:x`, ngay: vn("2026-10-05T10:00:00"), dienGiai: "", ...p } as SuKienQuy;
}

describe("dấu từng dòng — suy từ công thức thẻ Quỹ", () => {
  it.each<[string, SuKienQuy, number, number]>([
    ["ghi tay VÀO ⇒ thu", sk({ nguon: "GHI_TAY", truong: "ghiTayVao", giaTri: 100 }), 100, 0],
    ["ghi tay RA ⇒ chi", sk({ nguon: "GHI_TAY", truong: "ghiTayRa", giaTri: 40 }), 0, 40],
    ["TikTok về bank ⇒ thu", sk({ nguon: "TIKTOK_VE_BANK", truong: "tiktokVeBank", giaTri: 30 }), 30, 0],
    // Rút ví lưu ÂM: tiền rời ví VỀ tài khoản shop ⇒ quỹ tăng.
    ["Shopee rút (âm) ⇒ thu", sk({ nguon: "SHOPEE_RUT_VI", truong: "shopeeRutViCoDau", giaTri: -5 }), 5, 0],
    // Dòng đảo lệnh rút lưu DƯƠNG: tiền quay lại ví ⇒ quỹ giảm.
    ["Shopee đảo rút (dương) ⇒ chi", sk({ nguon: "SHOPEE_RUT_VI", truong: "shopeeRutViCoDau", giaTri: 2 }), 0, 2],
    ["chi phí ⇒ chi", sk({ nguon: "CHI_PHI", truong: "chiPhi", giaTri: 7 }), 0, 7],
    ["ads gộp ⇒ chi", sk({ nguon: "CHI_PHI_ADS_GOP", truong: "chiPhi", giaTri: 9 }), 0, 9],
    // Ads TikTok sàn trừ ví lưu ÂM ⇒ cộng lại quỹ phần Sổ chi phí đã trừ mà tiền chưa hề rời bank.
    ["ads TikTok trừ ví (âm) ⇒ thu", sk({ nguon: "ADS_TIKTOK_TRU_VI", truong: "adsTiktokViCoDau", giaTri: -3 }), 3, 0],
    ["thu nhập tài chính ⇒ thu", sk({ nguon: "THU_NHAP", truong: "thuNhap", giaTri: 11 }), 11, 0],
    ["bán trực tiếp ⇒ thu", sk({ nguon: "BAN_TRUC_TIEP", truong: "banTrucTiep", giaTri: 13 }), 13, 0],
  ])("%s", (_ten, s, thu, chi) => {
    const { dong, tongThu, tongChi } = dungDongChay(0, [s]);
    expect(dong).toHaveLength(1);
    expect(dong[0]).toMatchObject({ thu, chi, soDu: thu - chi });
    expect([tongThu, tongChi]).toEqual([thu, chi]);
    expect(dongGopCuaSuKien(s)).toBe(thu - chi);
  });

  it("dòng giá trị 0 không sinh −0 ở vế chi", () => {
    const { dong } = dungDongChay(0, [sk({ nguon: "BAN_TRUC_TIEP", truong: "banTrucTiep", giaTri: 0 })]);
    expect(Object.is(dong[0].chi, 0)).toBe(true);
    expect(Object.is(dong[0].thu, 0)).toBe(true);
  });
});

describe("thứ tự + số dư chạy", () => {
  const a = sk({ key: "GHI_TAY:b", nguon: "GHI_TAY", truong: "ghiTayVao", giaTri: 100, ngay: vn("2026-10-01T00:00:00") });
  const b = sk({ key: "GHI_TAY:a", nguon: "GHI_TAY", truong: "ghiTayVao", giaTri: 50, ngay: vn("2026-10-01T00:00:00") });
  const c = sk({ key: "CHI_PHI:z", nguon: "CHI_PHI", truong: "chiPhi", giaTri: 30, ngay: vn("2026-10-01T00:00:00") });
  const d = sk({ key: "TIKTOK_VE_BANK:q", nguon: "TIKTOK_VE_BANK", truong: "tiktokVeBank", giaTri: 20, ngay: vn("2026-10-01T00:00:00") });
  const e = sk({ key: "CHI_PHI:a", nguon: "CHI_PHI", truong: "chiPhi", giaTri: 5, ngay: vn("2026-09-30T23:59:59") });

  it("xếp theo ngày, rồi thứ tự nguồn cố định, rồi key — không phụ thuộc thứ tự đầu vào", () => {
    const kyVong = ["CHI_PHI:a", "GHI_TAY:a", "GHI_TAY:b", "TIKTOK_VE_BANK:q", "CHI_PHI:z"];
    const xuoi = dungDongChay(1000, [a, b, c, d, e]).dong.map((x) => x.key);
    const nguoc = dungDongChay(1000, [e, d, c, b, a]).dong.map((x) => x.key);
    expect(xuoi).toEqual(kyVong);
    expect(nguoc).toEqual(kyVong);
  });

  it("số dư cộng dồn từ đầu kỳ; đầu kỳ + Σthu − Σchi = số dư dòng cuối", () => {
    const r = dungDongChay(1000, [a, b, c, d, e]);
    expect(r.dong.map((x) => x.soDu)).toEqual([995, 1045, 1145, 1165, 1135]);
    expect(r.tongThu).toBe(170);
    expect(r.tongChi).toBe(35);
    expect(1000 + r.tongThu - r.tongChi).toBe(r.dong.at(-1)!.soDu);
  });

  it("không đổi mảng đầu vào", () => {
    const vao = [a, b, c];
    dungDongChay(0, vao);
    expect(vao).toEqual([a, b, c]);
  });

  it("kỳ rỗng ⇒ không dòng, tổng 0", () => {
    expect(dungDongChay(12_345, [])).toEqual({ dong: [], tongThu: 0, tongChi: 0 });
  });
});

describe("gộp ads tự động theo ngày VN + nền tảng", () => {
  it("N dòng chiến dịch → 1 dòng/ngày/nền tảng, tổng giữ nguyên", () => {
    const ngay12 = vn("2026-10-12T00:00:00");
    const g = gopChiPhiAdsTheoNgay([
      { date: ngay12, adsSource: "META", amount: 100 },
      { date: ngay12, adsSource: "META", amount: 200 },
      { date: ngay12, adsSource: "META", amount: 300 },
      { date: ngay12, adsSource: "TIKTOK_ADS", amount: 50 },
      { date: vn("2026-10-13T00:00:00"), adsSource: "META", amount: 70 },
      { date: ngay12, adsSource: null, amount: 9 },
    ]);
    const theoKey = Object.fromEntries(g.map((x) => [x.key, x]));
    expect(Object.keys(theoKey).sort()).toEqual([
      "CHI_PHI_ADS_GOP:2026-10-12:KHAC",
      "CHI_PHI_ADS_GOP:2026-10-12:META",
      "CHI_PHI_ADS_GOP:2026-10-12:TIKTOK_ADS",
      "CHI_PHI_ADS_GOP:2026-10-13:META",
    ]);
    expect(theoKey["CHI_PHI_ADS_GOP:2026-10-12:META"]).toMatchObject({
      giaTri: 600,
      nguon: "CHI_PHI_ADS_GOP",
      truong: "chiPhi",
      dienGiai: "Quảng cáo Meta — 3 chiến dịch",
    });
    expect(theoKey["CHI_PHI_ADS_GOP:2026-10-12:KHAC"].dienGiai).toBe("Quảng cáo Khác — 1 chiến dịch");
    expect(g.reduce((s, x) => s + x.giaTri, 0)).toBe(729);
  });

  it("khoá ngày theo giờ VN: 00:00 VN và 23:59:59.999 VN cùng một ngày; 1ms sau là ngày kế", () => {
    expect(khoaNgayVn(vn("2026-10-01T00:00:00"))).toBe("2026-10-01");
    expect(khoaNgayVn(vn("2026-10-01T23:59:59.999"))).toBe("2026-10-01");
    expect(khoaNgayVn(vn("2026-10-02T00:00:00"))).toBe("2026-10-02");
    // 17:00 UTC hôm trước = 00:00 VN hôm sau — gom theo ngày UTC là lệch ngày.
    expect(khoaNgayVn(new Date("2026-09-30T17:00:00Z"))).toBe("2026-10-01");
  });
});

describe("khoản ÂM/DƯƠNG ngược chiều thường lệ — dấu từng dòng đổi, tổng giữ nguyên", () => {
  const ngay12 = vn("2026-10-12T00:00:00");
  const ngay13 = vn("2026-10-13T00:00:00");

  it("nhóm ads gộp có một dòng điều chỉnh âm: nhóm trừ ròng, nhóm chỉ có hoàn ⇒ vế THU", () => {
    const ads = [
      { date: ngay12, adsSource: "META", amount: 500_000 },
      { date: ngay12, adsSource: "META", amount: 300_000 },
      { date: ngay12, adsSource: "META", amount: -200_000 }, // nền tảng hoàn/điều chỉnh
      { date: ngay13, adsSource: "TIKTOK_ADS", amount: -150_000 }, // cả ngày chỉ có khoản hoàn
    ];
    const gop = gopChiPhiAdsTheoNgay(ads);
    const r = dungDongChay(1_000_000, gop);

    expect(r.dong.map((d) => [d.key, d.thu, d.chi, d.soDu])).toEqual([
      ["CHI_PHI_ADS_GOP:2026-10-12:META", 0, 600_000, 400_000],
      // Hoàn ads = tiền quay về ⇒ quỹ TĂNG; không được hiện thành "chi âm".
      ["CHI_PHI_ADS_GOP:2026-10-13:TIKTOK_ADS", 150_000, 0, 550_000],
    ]);
    expect(r.dong[0].dienGiai).toBe("Quảng cáo Meta — 3 chiến dịch");

    // Tổng giữ nguyên: đóng góp ròng của bảng = quỹ theo công thức thẻ trên Σ chi phí thô.
    const tongThe = tinhQuyTuTong({ ...TONG_RONG, chiPhi: ads.reduce((s, e) => s + e.amount, 0) });
    expect(r.tongThu - r.tongChi).toBe(tongThe);
    expect(tongThe).toBe(-450_000);
  });

  it("ads TikTok sàn trừ ví: dòng DƯƠNG (sàn hoàn ads về ví) ⇒ vế CHI, bù trừ với dòng trừ ví", () => {
    const truVi = sk({ key: "ADS_TIKTOK_TRU_VI:a", nguon: "ADS_TIKTOK_TRU_VI", truong: "adsTiktokViCoDau", giaTri: -1_500_000, ngay: ngay12 });
    const hoanVi = sk({ key: "ADS_TIKTOK_TRU_VI:b", nguon: "ADS_TIKTOK_TRU_VI", truong: "adsTiktokViCoDau", giaTri: 400_000, ngay: ngay13 });
    const r = dungDongChay(0, [hoanVi, truVi]);

    // Sàn hoàn phần ads đã trừ ví ⇒ phần "cộng lại quỹ" trước đó co lại ⇒ quỹ GIẢM.
    expect(r.dong.map((d) => [d.key, d.thu, d.chi, d.soDu])).toEqual([
      ["ADS_TIKTOK_TRU_VI:a", 1_500_000, 0, 1_500_000],
      ["ADS_TIKTOK_TRU_VI:b", 0, 400_000, 1_100_000],
    ]);
    const tongThe = tinhQuyTuTong({ ...TONG_RONG, adsTiktokViCoDau: -1_500_000 + 400_000 });
    expect(r.tongThu - r.tongChi).toBe(tongThe);
    expect(tongThe).toBe(1_100_000);
  });
});
