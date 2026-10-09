import { describe, expect, it } from "vitest";

import { chonMocT, dauTuan, khaoSatChenhNguon, phanTichCheDoDb, trungVi } from "@/lib/no-phai-tra/khao-sat-chenh-nguon";

// Mốc giờ VN (+07) viết tường minh để test không phụ thuộc TZ máy.
const vn = (s: string) => new Date(`${s}+07:00`);

describe("khaoSatChenhNguon", () => {
  const ads = [
    { adsSource: "TIKTOK_ADS", source: "ADS_API", date: vn("2026-09-14T00:00:00"), amount: 100 }, // T2 tuần 1
    { adsSource: "TIKTOK_ADS", source: "ADS_API", date: vn("2026-09-15T00:00:00"), amount: 200 },
    { adsSource: "TIKTOK_ADS", source: "ADS_API", date: vn("2026-09-21T00:00:00"), amount: 300 }, // tuần 2
    { adsSource: "META", source: "ADS_API", date: vn("2026-09-14T00:00:00"), amount: 999 }, // không tính
    { adsSource: null, source: "MANUAL", date: vn("2026-09-14T00:00:00"), amount: 5 },
  ];
  const vi = [
    { orderCreateTime: vn("2026-09-14T23:59:00"), settlementAmount: -90, syncedAt: vn("2026-09-16T23:59:00") }, // ngày 14
    { orderCreateTime: vn("2026-09-15T00:01:00"), settlementAmount: -210, syncedAt: vn("2026-09-18T00:01:00") }, // ngày 15
    { orderCreateTime: vn("2026-09-22T10:00:00"), settlementAmount: -50, syncedAt: vn("2026-09-23T10:00:00") }, // ngày 22 (ads 0)
  ];
  const payment = [
    { paidTime: vn("2026-09-16T08:00:00"), settlementValue: 1000 },
    { paidTime: null, settlementValue: 777 },
  ];

  it("gộp theo tuần VN, tỉ lệ ví/ads, ngày biên 23:59/00:01 rơi đúng ngày", () => {
    const r = khaoSatChenhNguon({ ads, vi, payment });
    expect(r.tuan).toEqual([
      { tuanBatDau: "2026-09-14", adsTiktok: 300, viTiktok: 300, bankVe: 1000, tiLeViTrenAds: 1 },
      { tuanBatDau: "2026-09-21", adsTiktok: 300, viTiktok: 50, bankVe: 0, tiLeViTrenAds: 50 / 300 },
    ]);
  });

  it("đếm ngày lệch hai chiều và nguồn ads", () => {
    const r = khaoSatChenhNguon({ ads, vi, payment });
    expect(r.soNgayAdsCoViKhong).toBe(1); // 21
    expect(r.soNgayViCoAdsKhong).toBe(1); // 22
    expect(r.soDongAdsKhongNguon).toBe(1);
    expect(r.adsTheoSource).toEqual({ ADS_API: 4, MANUAL: 1 });
    expect(r.adsTheoNguon).toEqual({ TIKTOK_ADS: 3, META: 1 });
  });

  it("trung vị trễ đồng bộ: lẻ lấy giữa", () => {
    const r = khaoSatChenhNguon({ ads, vi, payment });
    // trễ: 2, ~2.99, 1 ngày ⇒ trung vị = 2
    expect(r.trungViTreDongBoNgay).toBeCloseTo(2, 5);
  });

  it("trung vị chẵn lấy trung bình hai số giữa; rỗng ⇒ null", () => {
    expect(trungVi([4, 1, 3, 2])).toBe(2.5);
    expect(trungVi([])).toBeNull();
    expect(khaoSatChenhNguon({ ads: [], vi: [], payment: [] }).trungViTreDongBoNgay).toBeNull();
  });

  it("mốc T: hai phía < T và ≥ T trong ±7 ngày cho cả ads và ví, kèm ước lượng lệch", () => {
    const r = khaoSatChenhNguon({ ads, vi, payment, mocT: ["2026-09-22"] });
    // T=09-22: trước = [09-15, 09-21]: ads 200+300=500, ví 210; từ T = [09-22, 09-29]: ads 0, ví 50
    expect(r.moc).toEqual([
      { t: "2026-09-22", adsTruocT: 500, adsTuT: 0, viTruocT: 210, viTuT: 50, uocLuongLechHaiTruc: 50 - 290 },
    ]);
    expect(khaoSatChenhNguon({ ads, vi, payment }).moc).toEqual([]);
  });

  it("nhiều mốc T cho ra nhiều dòng độc lập", () => {
    const r = khaoSatChenhNguon({ ads, vi, payment, mocT: ["2026-09-15", "2026-09-22"] });
    expect(r.moc.map((m) => m.t)).toEqual(["2026-09-15", "2026-09-22"]);
  });

  it("Σ ví cộng có dấu rồi mới abs: dòng −10 và +4 ⇒ 6", () => {
    const r = khaoSatChenhNguon({
      ads: [{ adsSource: "TIKTOK_ADS", source: "ADS_API", date: vn("2026-09-14T00:00:00"), amount: 6 }],
      vi: [
        { orderCreateTime: vn("2026-09-14T09:00:00"), settlementAmount: -10, syncedAt: vn("2026-09-15T09:00:00") },
        { orderCreateTime: vn("2026-09-14T10:00:00"), settlementAmount: 4, syncedAt: vn("2026-09-15T10:00:00") },
      ],
      payment: [],
      mocT: ["2026-09-14"],
    });
    expect(r.tuan[0].viTiktok).toBe(6);
    expect(r.moc[0].viTuT).toBe(6);
  });

  it("trung vị trễ loại backfill (syncedAt > orderCreateTime + 30 ngày)", () => {
    const r = khaoSatChenhNguon({
      ads: [],
      vi: [
        { orderCreateTime: vn("2026-08-01T00:00:00"), settlementAmount: -1, syncedAt: vn("2026-08-03T00:00:00") }, // 2
        { orderCreateTime: vn("2026-08-01T00:00:00"), settlementAmount: -1, syncedAt: vn("2026-08-05T00:00:00") }, // 4
        { orderCreateTime: vn("2026-08-01T00:00:00"), settlementAmount: -1, syncedAt: vn("2026-10-01T00:00:00") }, // 61 backfill
      ],
      payment: [],
    });
    expect(r.trungViTreDongBoNgay).toBeCloseTo(4, 5);
    expect(r.trungViTreKhongBackfillNgay).toBeCloseTo(3, 5);
  });

  it("phanTichCheDoDb: 0 cờ ⇒ lỗi; cả 2 cờ ⇒ lỗi; --db-test cần tên DB _test", () => {
    const env = { TEST_DATABASE_URL: "postgresql://u:p@h:5432/hogikids_test?schema=app", DATABASE_URL: "postgresql://u:p@h:5432/postgres" };
    expect(() => phanTichCheDoDb([], env)).toThrow(/Thiếu cờ DB/);
    expect(() => phanTichCheDoDb(["--db-test", "--prod"], env)).toThrow(/MỘT/);
    expect(phanTichCheDoDb(["--db-test"], env).che).toBe("test");
    expect(phanTichCheDoDb(["--prod"], env)).toEqual({ che: "prod", databaseUrl: env.DATABASE_URL });
    expect(() => phanTichCheDoDb(["--db-test"], { TEST_DATABASE_URL: "postgresql://u:p@h/postgres" })).toThrow(/_test/);
  });

  it("chonMocT: mặc định mùng 1 trong (tu, den]; T ngoài cửa sổ bị bỏ kèm cảnh báo", () => {
    expect(chonMocT("2026-07-01", "2026-09-30", undefined).mocT).toEqual(["2026-08-01", "2026-09-01"]);
    const r = chonMocT("2026-07-01", "2026-09-30", "2026-09-01,2026-11-01");
    expect(r.mocT).toEqual(["2026-09-01"]);
    expect(r.canhBao).toHaveLength(1);
  });

  it("dauTuan trả thứ Hai (kể cả Chủ nhật)", () => {
    expect(dauTuan("2026-09-20")).toBe("2026-09-14"); // CN
    expect(dauTuan("2026-09-14")).toBe("2026-09-14");
  });
});
