import { describe, expect, it } from "vitest";

import {
  bocAnhChupChiPhiTiktok,
  mapAnhChupChiPhiTiktok,
  soTrangAnhChupChiPhi,
  tienApi,
  tinhGrantGomVat,
  type AnhChupChiPhiTho,
  type DongChiPhiTho,
  type TrangChiPhiTho,
} from "@/lib/ingest/tiktok-ads-tin-dung-mapping";

/**
 * Mapping THUẦN ảnh chụp chi phí một ngày (`/bc/account/cost/get/`) → dòng Silver theo advertiser.
 * Bẫy chính:
 *  - DẤU (đo 24/10): endpoint báo chi phí bằng SỐ ÂM ⇒ Silver = −giá trị API; giá trị dương (hoàn) ⇒ Silver âm.
 *  - CÙNG advertiser tách NHIỀU dòng ⇒ phải cộng; cộng xong mới làm tròn.
 *  - Ảnh chụp nhiều trang ⇒ phải đủ `total_page` trang; dòng/trang nào đọc không chắc ⇒ bỏ CẢ ảnh chụp (giữ số
 *    cũ), không ép 0.
 */

const BC = "7129545797879726081";
const ADV = "7129548444015902722";
const ADV2 = "7090000000000000001";

/** Đúng payload thật 20/10 (controller đo 24/10), các trường đã rút thành chuỗi như transform đọc từ Postgres. */
const DONG_THAT_2010: DongChiPhiTho = {
  advertiser_id: ADV,
  advertiser_name: "Hogikids",
  amount: "-995050",
  cash_amount: "-750294",
  currency: "VND",
  grant_amount: "-244756",
  tax_amount: "-75029",
};

const dong = (them: Partial<Record<string, string | number | null>> = {}): DongChiPhiTho => ({
  advertiser_id: ADV,
  amount: "-130000",
  cash_amount: "-121000",
  grant_amount: "-9000",
  tax_amount: "-12100",
  currency: "VND",
  ...them,
});

const trang = (them: Partial<TrangChiPhiTho> = {}): TrangChiPhiTho => ({
  code: "0",
  kieuData: "object",
  kieuDanhSach: "array",
  trang: "1",
  tongTrang: "1",
  ...them,
});

const anh = (them: Partial<AnhChupChiPhiTho> = {}): AnhChupChiPhiTho => ({
  bcId: BC,
  ngay: "2026-10-14",
  cacTrang: [trang()],
  dong: [dong()],
  ...them,
});

describe("bocAnhChupChiPhiTiktok — nối chuỗi, không parse", () => {
  it("một trang: giữ NGUYÊN VĂN text thô (int64 19 chữ số, thứ tự key, khoảng trắng)", () => {
    const tho = `{"code":0,"data":{"cost_list":[{"advertiser_id":7129548444015902722,"grant_amount":-9000}]},"request_id":"x"}`;
    expect(bocAnhChupChiPhiTiktok(tho)).toBe(`{"ban_chup":[{"trang":[${tho}]}]}`);
    // Qua JSON.parse là mất: chứng minh phép bọc KHÔNG đi đường đó.
    expect(JSON.stringify(JSON.parse(tho))).not.toBe(tho);
  });

  it("nhiều trang ⇒ nối đúng thứ tự trong MỘT ảnh chụp", () => {
    expect(bocAnhChupChiPhiTiktok(["{\"a\":1}", "{\"b\":2}"])).toBe(`{"ban_chup":[{"trang":[{"a":1},{"b":2}]}]}`);
  });

  it("body rỗng / danh sách rỗng ⇒ ném (không land ảnh chụp ma)", () => {
    expect(() => bocAnhChupChiPhiTiktok("  ")).toThrow(/rỗng/);
    expect(() => bocAnhChupChiPhiTiktok([])).toThrow(/rỗng/);
    expect(() => bocAnhChupChiPhiTiktok(["{}", ""])).toThrow(/rỗng/);
  });
});

describe("mapAnhChupChiPhiTiktok — dấu theo số đo thật", () => {
  it("payload thật 20/10: số ÂM của API ⇒ Silver dương (chi phí); ngày neo 00:00 giờ VN", () => {
    const m = mapAnhChupChiPhiTiktok(anh({ ngay: "2026-10-20", dong: [DONG_THAT_2010] }));
    expect(m.ok).toBe(true);
    if (!m.ok) return;
    expect(m.ngayLuc.toISOString()).toBe("2026-10-19T17:00:00.000Z");
    expect(m.theoAdvertiser).toEqual([
      { advertiserId: ADV, grantExVat: 244_756, cashExVat: 750_294, amountExVat: 995_050, nguon: [DONG_THAT_2010] },
    ]);
    // Đối chiếu khảo sát: amount × 1,1 = 1.094.555 ≈ Expense 20/10 1.094.557.
    expect(Math.round(m.theoAdvertiser[0].amountExVat * 1.1)).toBe(1_094_555);
    expect(tinhGrantGomVat(m.theoAdvertiser[0].grantExVat, 0.1)).toBe(269_232);
  });

  it("payload thật 15/01: chi trọn bằng tiền, grant 0 ⇒ 0 (không phải −0)", () => {
    const m = mapAnhChupChiPhiTiktok(
      anh({
        ngay: "2026-01-15",
        dong: [dong({ amount: "-4551219", cash_amount: "-4551219", grant_amount: "0", tax_amount: "-455122" })],
      }),
    );
    expect(m.ok).toBe(true);
    if (!m.ok) return;
    expect(m.theoAdvertiser[0]).toMatchObject({ grantExVat: 0, cashExVat: 4_551_219, amountExVat: 4_551_219 });
    expect(Object.is(m.theoAdvertiser[0].grantExVat, 0)).toBe(true);
    expect(Object.is(tinhGrantGomVat(0, 0.1), 0)).toBe(true);
  });

  it("nhận cả SỐ (gọi thẳng từ code) lẫn chuỗi", () => {
    const m = mapAnhChupChiPhiTiktok(anh({ dong: [dong({ amount: -995050, cash_amount: -750294, grant_amount: -244756 })] }));
    expect(m).toMatchObject({ ok: true, theoAdvertiser: [{ grantExVat: 244_756, cashExVat: 750_294, amountExVat: 995_050 }] });
  });

  it("giá trị DƯƠNG từ API (TikTok hoàn/điều chỉnh) ⇒ Silver ÂM, không bỏ ảnh chụp", () => {
    const m = mapAnhChupChiPhiTiktok(anh({ dong: [dong({ amount: "5000", cash_amount: "0", grant_amount: "5000" })] }));
    expect(m.ok).toBe(true);
    if (!m.ok) return;
    expect(m.theoAdvertiser[0]).toMatchObject({ grantExVat: -5_000, cashExVat: 0, amountExVat: -5_000 });
    expect(tinhGrantGomVat(-5_000, 0.1)).toBe(-5_500);
  });

  it("CÙNG advertiser nhiều dòng ⇒ CỘNG (không lấy dòng đầu), làm tròn SAU khi cộng, kể cả dòng trái dấu", () => {
    const m = mapAnhChupChiPhiTiktok(
      anh({
        dong: [
          dong({ grant_amount: "-1000.4", cash_amount: "-500.3", amount: "-1500.7" }),
          dong({ grant_amount: "-2000.4", cash_amount: "0", amount: "-2000.4" }),
          dong({ grant_amount: "300", cash_amount: "0", amount: "300" }),
          dong({ advertiser_id: ADV2, grant_amount: "0", cash_amount: "-35880", amount: "-35880" }),
        ],
      }),
    );
    expect(m.ok).toBe(true);
    if (!m.ok) return;
    expect(m.theoAdvertiser.map((d) => [d.advertiserId, d.grantExVat, d.cashExVat, d.amountExVat])).toEqual([
      [ADV2, 0, 35_880, 35_880],
      // −1000,4 − 2000,4 + 300 = −2700,8 ⇒ chi phí 2701 (làm tròn từng dòng sẽ ra 2700 — lệch 1đ mỗi dòng).
      [ADV, 2_701, 500, 3_201],
    ]);
    expect(m.theoAdvertiser[1].nguon).toHaveLength(3);
  });

  it("TikTok bỏ hẳn khoá cost_list kèm total_number 0 (ngày không chi) ⇒ ảnh chụp RỖNG hợp lệ (để gỡ số cũ)", () => {
    const m = mapAnhChupChiPhiTiktok(anh({ cacTrang: [trang({ kieuDanhSach: null, tongDong: "0" })], dong: [] }));
    expect(m).toMatchObject({ ok: true, theoAdvertiser: [] });
  });
});

describe("mapAnhChupChiPhiTiktok — Σ dòng mọi trang phải bằng total_number", () => {
  /** `n` dòng của `n` advertiser khác nhau (mỗi dòng grant 9.000). */
  const nDong = (n: number, tu = 0) =>
    Array.from({ length: n }, (_, i) => dong({ advertiser_id: `70${String(tu + i).padStart(17, "0")}` }));

  it("trang báo total_number 5 mà KHÔNG có cost_list ⇒ từ chối (không coi là ảnh chụp rỗng, không gỡ số cũ)", () => {
    const m = mapAnhChupChiPhiTiktok(
      anh({ cacTrang: [trang({ kieuDanhSach: null, trang: "1", tongTrang: "1", tongDong: "5" })], dong: null }),
    );
    expect(m.ok).toBe(false);
    if (m.ok) return;
    expect(m.loi).toMatch(/thiếu dòng \(0\/5\)/);
  });

  it("đối chứng: ảnh chụp rỗng THẬT (total_page 0, total_number 0, cost_list []) vẫn hợp lệ", () => {
    const m = mapAnhChupChiPhiTiktok(
      anh({ cacTrang: [trang({ kieuDanhSach: "array", tongTrang: "0", tongDong: "0" })], dong: [] }),
    );
    expect(m).toMatchObject({ ok: true, theoAdvertiser: [] });
  });

  it("3 trang 50 + 50 + 7 dòng, total_number 107 ⇒ nhận đủ 107 advertiser", () => {
    const m = mapAnhChupChiPhiTiktok(
      anh({
        cacTrang: [1, 2, 3].map((p) => trang({ trang: String(p), tongTrang: "3", tongDong: "107" })),
        dong: [...nDong(50), ...nDong(50, 50), ...nDong(7, 100)],
      }),
    );
    expect(m.ok).toBe(true);
    if (!m.ok) return;
    expect(m.theoAdvertiser).toHaveLength(107);
  });

  it("2 trang 50 + 50 dòng mà total_number 107 ⇒ từ chối (ảnh chụp thiếu dòng)", () => {
    const m = mapAnhChupChiPhiTiktok(
      anh({
        cacTrang: [1, 2].map((p) => trang({ trang: String(p), tongTrang: "2", tongDong: "107" })),
        dong: [...nDong(50), ...nDong(50, 50)],
      }),
    );
    expect(m.ok).toBe(false);
    if (m.ok) return;
    expect(m.loi).toMatch(/thiếu dòng \(100\/107\)/);
  });

  it("Σ dòng NHIỀU hơn total_number ⇒ từ chối (ảnh chụp không nhất quán)", () => {
    const m = mapAnhChupChiPhiTiktok(anh({ cacTrang: [trang({ tongDong: "1" })], dong: nDong(2) }));
    expect(m.ok).toBe(false);
    if (m.ok) return;
    expect(m.loi).toMatch(/thừa dòng \(2\/1\)/);
  });

  it("total_number lệch giữa các trang ⇒ từ chối", () => {
    const m = mapAnhChupChiPhiTiktok(
      anh({
        cacTrang: [trang({ trang: "1", tongTrang: "2", tongDong: "3" }), trang({ trang: "2", tongTrang: "2", tongDong: "2" })],
        dong: nDong(3),
      }),
    );
    expect(m.ok).toBe(false);
    if (m.ok) return;
    expect(m.loi).toMatch(/trang 2: total_number lệch trang đầu/);
  });

  it("vắng cost_list mà KHÔNG có total_number ⇒ từ chối (không chứng minh được ngày rỗng)", () => {
    const m = mapAnhChupChiPhiTiktok(anh({ cacTrang: [trang({ kieuDanhSach: null })], dong: [] }));
    expect(m.ok).toBe(false);
    if (m.ok) return;
    expect(m.loi).toMatch(/không có cost_list/);
  });

  it("total_number không phải số nguyên ⇒ từ chối", () => {
    const m = mapAnhChupChiPhiTiktok(anh({ cacTrang: [trang({ tongDong: "1.5" })], dong: nDong(1) }));
    expect(m.ok).toBe(false);
    if (m.ok) return;
    expect(m.loi).toMatch(/total_number "1.5" không hợp lệ/);
  });

  it("trang có cost_list nhưng vắng total_number ⇒ vẫn nhận như cũ (chỉ soi Σ khi TikTok báo tổng)", () => {
    const m = mapAnhChupChiPhiTiktok(anh({ cacTrang: [trang({ tongDong: null })], dong: nDong(2) }));
    expect(m).toMatchObject({ ok: true });
  });
});

describe("mapAnhChupChiPhiTiktok — ngày không chi tiêu (total_page = 0)", () => {
  /** Đúng đầu trang đo thật 24/10 (15/07, 20/07, 05/08/2026): `cost_list: []`, `total_number 0`, `total_page 0`. */
  const trangRongThat = (them: Partial<TrangChiPhiTho> = {}) =>
    trang({ kieuDanhSach: "array", trang: "1", tongTrang: "0", tongDong: "0", ...them });

  it("một trang rỗng total_page 0 + total_number 0 ⇒ ảnh chụp RỖNG hợp lệ (để gỡ số cũ)", () => {
    const m = mapAnhChupChiPhiTiktok(anh({ cacTrang: [trangRongThat()], dong: [] }));
    expect(m).toMatchObject({ ok: true, ngay: "2026-10-14", theoAdvertiser: [] });
  });

  it.each([
    ["total_page 0 mà cost_list CÓ dòng", anh({ cacTrang: [trangRongThat()], dong: [dong()] }), /total_page 0 mà cost_list có 1 dòng/],
    ["total_page 0 mà total_number ≠ 0", anh({ cacTrang: [trangRongThat({ tongDong: "3" })], dong: [] }), /total_number "3"/],
    ["total_page 0 mà thiếu total_number", anh({ cacTrang: [trangRongThat({ tongDong: null })], dong: [] }), /total_number ""/],
    [
      "total_page 0 mà land 2 trang",
      anh({ cacTrang: [trangRongThat(), trangRongThat({ trang: "2" })], dong: [] }),
      /total_page 0 mà land 2 trang/,
    ],
    ["total_page 0 mà body lỗi", anh({ cacTrang: [trangRongThat({ code: "40002" })], dong: [] }), /code "40002"/],
    ["total_page âm", anh({ cacTrang: [trang({ tongTrang: "-1" })] }), /total_page "-1" không hợp lệ/],
  ])("%s ⇒ bỏ CẢ ảnh chụp kèm lý do", (_ten, dauVao, loi) => {
    const m = mapAnhChupChiPhiTiktok(dauVao);
    expect(m.ok).toBe(false);
    if (m.ok) return;
    expect(m.loi).toMatch(loi);
  });
});

describe("soTrangAnhChupChiPhi — vòng lặp trang của script backfill", () => {
  it("body THẬT ngày không chi tiêu (total_page 0, cost_list []) ⇒ 1 trang, dừng ngay", () => {
    const data = JSON.parse(
      `{"cost_list":[],"page_info":{"page":1,"page_size":50,"total_number":0,"total_page":0}}`,
    ) as Record<string, unknown>;
    expect(soTrangAnhChupChiPhi(data, 1)).toBe(1);
  });

  it("thiếu page_info / total_page ⇒ 1; total_page 3 ⇒ 3", () => {
    expect(soTrangAnhChupChiPhi(undefined, 1)).toBe(1);
    expect(soTrangAnhChupChiPhi({ cost_list: [] }, 1)).toBe(1);
    expect(soTrangAnhChupChiPhi({ page_info: { total_page: 3 } }, 2)).toBe(3);
  });

  it.each([
    ["có dòng", { cost_list: [{}], page_info: { total_page: 0, total_number: 1 } }, 1],
    ["total_number ≠ 0", { cost_list: [], page_info: { total_page: 0, total_number: 2 } }, 1],
    ["thiếu total_number", { cost_list: [], page_info: { total_page: 0 } }, 1],
    ["không phải trang 1", { cost_list: [], page_info: { total_page: 0, total_number: 0 } }, 2],
  ])("total_page 0 mà %s ⇒ ném (mâu thuẫn, không land)", (_ten, data, page) => {
    expect(() => soTrangAnhChupChiPhi(data, page)).toThrow(/total_page 0/);
  });
});

describe("mapAnhChupChiPhiTiktok — nhiều trang", () => {
  it("đủ total_page trang ⇒ cộng dòng của MỌI trang", () => {
    const m = mapAnhChupChiPhiTiktok(
      anh({
        cacTrang: [trang({ trang: "1", tongTrang: "2" }), trang({ trang: "2", tongTrang: "2" })],
        dong: [dong(), dong({ advertiser_id: ADV2 }), dong()],
      }),
    );
    expect(m.ok).toBe(true);
    if (!m.ok) return;
    expect(m.theoAdvertiser.map((d) => [d.advertiserId, d.grantExVat])).toEqual([
      [ADV2, 9_000],
      [ADV, 18_000],
    ]);
  });

  it.each([
    ["thiếu trang (total_page 2 mà chỉ land 1)", anh({ cacTrang: [trang({ tongTrang: "2" })] }), /có 2 trang mà chỉ land 1/],
    ["không có trang nào", anh({ cacTrang: [] }), /không có trang nào/],
    ["dòng Bronze không có mảng trang", anh({ cacTrang: null }), /không có trang nào/],
    [
      "trang sau là body LỖI",
      anh({ cacTrang: [trang({ tongTrang: "2" }), trang({ code: "40002", trang: "2", tongTrang: "2" })] }),
      /trang 2: code "40002"/,
    ],
    [
      "trang sau lệch thứ tự",
      anh({ cacTrang: [trang({ tongTrang: "2" }), trang({ trang: "3", tongTrang: "2" })] }),
      /page_info.page = 3/,
    ],
    ["data không phải object", anh({ cacTrang: [trang({ kieuData: "array" })] }), /không phải object/],
  ])("%s ⇒ bỏ CẢ ảnh chụp kèm lý do", (_ten, dauVao, loi) => {
    const m = mapAnhChupChiPhiTiktok(dauVao);
    expect(m.ok).toBe(false);
    if (m.ok) return;
    expect(m.loi).toMatch(loi);
  });
});

describe("mapAnhChupChiPhiTiktok — dòng hỏng", () => {
  it.each([
    ["cost_list không phải mảng", anh({ cacTrang: [trang({ kieuDanhSach: "object" })], dong: [] }), /không phải mảng/],
    ["ngày không có thật", anh({ ngay: "2026-02-31" }), /không phải YYYY-MM-DD có thật/],
    ["thiếu ngày", anh({ ngay: null }), /không phải YYYY-MM-DD/],
    ["phần tử không phải object", anh({ dong: [null] }), /không phải object/],
    ["thiếu advertiser_id", anh({ dong: [dong({ advertiser_id: null })] }), /thiếu advertiser_id/],
    ["tiền tệ khác VND", anh({ dong: [dong({ currency: "USD" })] }), /USD/],
    ["thiếu grant_amount", anh({ dong: [dong({ grant_amount: null })] }), /thiếu grant_amount/],
    ["amount rác", anh({ dong: [dong({ amount: "abc" })] }), /amount "abc"/],
    ["số mũ", anh({ dong: [dong({ grant_amount: "-1e3" })] }), /grant_amount "-1e3"/],
  ])("%s ⇒ bỏ CẢ ảnh chụp kèm lý do", (_ten, dauVao, loi) => {
    const m = mapAnhChupChiPhiTiktok(dauVao);
    expect(m.ok).toBe(false);
    if (m.ok) return;
    expect(m.loi).toMatch(loi);
  });

  it("một dòng hỏng giữa các dòng lành ⇒ KHÔNG ghi nửa ảnh chụp", () => {
    const m = mapAnhChupChiPhiTiktok(anh({ dong: [dong(), dong({ advertiser_id: ADV2, cash_amount: null })] }));
    expect(m.ok).toBe(false);
  });
});

describe("tienApi + tinhGrantGomVat", () => {
  it("nhận số nguyên / lẻ / âm dạng chuỗi hay số; từ chối rác / vắng / số mũ", () => {
    expect(tienApi("1513606", "g")).toEqual({ ok: true, so: 1_513_606 });
    expect(tienApi("-244756", "g")).toEqual({ ok: true, so: -244_756 });
    expect(tienApi(-995050, "g")).toEqual({ ok: true, so: -995_050 });
    expect(tienApi("130000.00", "g")).toEqual({ ok: true, so: 130_000 });
    expect(tienApi("", "g")).toMatchObject({ ok: false });
    expect(tienApi("1e3", "g")).toMatchObject({ ok: false });
    expect(tienApi(null, "g")).toMatchObject({ ok: false });
  });

  it("grant × (1 + VAT) làm tròn — số khảo sát T10: 1.513.606 × 1,1 = 1.664.967", () => {
    expect(tinhGrantGomVat(1_513_606, 0.1)).toBe(1_664_967);
    expect(tinhGrantGomVat(0, 0.1)).toBe(0);
    expect(tinhGrantGomVat(9_000, 0.08)).toBe(9_720);
  });
});
