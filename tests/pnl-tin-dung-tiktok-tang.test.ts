import { describe, expect, it } from "vitest";

import { buildPnlSheetRows } from "@/lib/reports/bao-cao-sheet-rows";
import {
  calcPnlCore,
  khoaNgayPnl,
  tinhTinDungTruTheoNgay,
  type PnlExpenseInput,
  type PnlOrderInput,
  type PnlTinDungInput,
} from "@/lib/reports/pnl";
import {
  buildPnlLineItems,
  displayValue,
  ID_DONG_TIN_DUNG_TIKTOK,
  isPnlMonthEmpty,
} from "@/lib/reports/pnl-line-items";
import { summableChildren } from "@/lib/reports/pnl-line-tree";

/**
 * Quảng cáo TikTok trả bằng TÍN DỤNG TIKTOK TẶNG — chủ shop chốt 23/10: KHÔNG phải chi phí, áp toàn bộ lịch sử.
 * `calcPnlCore` trừ Σ tín dụng (đã nhân VAT) khỏi `ads` + `adsBySource.TIKTOK_ADS`, kẹp trong chi tiêu TikTok của
 * Sổ, theo lăng kính kênh của ads TikTok. Hàm THUẦN — mọi số assert literal.
 *
 * Bốn bẫy suite này khoá:
 *  1. Kỳ KHÔNG có tín dụng phải ra y hệt từng đồng như trước khi có tính năng (đối chứng).
 *  2. Kẹp: tín dụng lớn hơn chi tiêu TikTok không được biến dòng ads thành âm ("thu nhập" quảng cáo).
 *  3. Kênh: tín dụng thuộc kênh của ads TikTok — không ép về 0 như chi phí chung, không rơi sang kênh khác.
 *  4. `buildOpexGroup` lấy HIỆU `grossProfit + financialIncome − netProfit` ⇒ dòng nhóm vẫn = Σ dòng con
 *     (ghi nhớ 16/09: khoản mới quên khai là dòng nhóm hụt mà không test cũ nào đỏ).
 */

const DON: PnlOrderInput = {
  status: "COMPLETED",
  channelId: "tiktok",
  itemsTotal: 5_000_000,
  discount: 100_000,
  platformFeeEst: 500_000,
  items: [{ sku: "SKU-1", quantity: 2, costPrice: 300_000 }],
};

const CHI_PHI: PnlExpenseInput[] = [
  { categoryId: "ads", adsSource: "META", channelId: "facebook", amount: 700_000 },
  { categoryId: "ads", adsSource: "TIKTOK_ADS", channelId: "tiktok", amount: 1_000_000 },
  { categoryId: "shipping", adsSource: null, channelId: null, amount: 120_000 },
  { categoryId: "fixed", adsSource: null, channelId: null, amount: 2_000_000 },
];

const TIN_DUNG: PnlTinDungInput[] = [
  { channelId: "tiktok", amount: 66_000 },
  { channelId: "tiktok", amount: 44_000 },
];

// Không tín dụng: revenue 5.000.000 − phí 500.000 − voucher 100.000 = 4.400.000; − COGS 600.000 = LN gộp 3.800.000;
// − ads 1.700.000 − ship 120.000 − fixed 2.000.000 = LN ròng −20.000.
const GOC = calcPnlCore([DON], CHI_PHI);

describe("kỳ KHÔNG có tín dụng — đối chứng, không đổi một đồng", () => {
  it("số literal y như trước khi có khoản này; adsTinDungTang = 0", () => {
    expect(GOC.ads).toBe(1_700_000);
    expect(GOC.adsBySource).toEqual({ META: 700_000, TIKTOK_ADS: 1_000_000 });
    expect(GOC.netProfit).toBe(-20_000);
    expect(GOC.adsTinDungTang).toBe(0);
  });

  it("truyền mảng tín dụng RỖNG ⇒ breakdown giống hệt không truyền", () => {
    expect(calcPnlCore([DON], CHI_PHI, { tinDungTang: [] })).toEqual(GOC);
  });

  it("cây Lãi/Lỗ không mọc dòng tín dụng, dòng TikTok giữ nguyên số", () => {
    const items = buildPnlLineItems(GOC);
    expect(items.some((i) => i.id === ID_DONG_TIN_DUNG_TIKTOK)).toBe(false);
    expect(items.find((i) => i.id === "ads:TIKTOK_ADS")?.value).toBe(1_000_000);
  });
});

describe("kỳ CÓ tín dụng", () => {
  const b = calcPnlCore([DON], CHI_PHI, { tinDungTang: TIN_DUNG });

  it("trừ Σ tín dụng khỏi ads + adsBySource.TIKTOK_ADS; LN ròng tăng đúng bằng số đó", () => {
    expect(b.adsTinDungTang).toBe(110_000);
    expect(b.ads).toBe(1_590_000);
    expect(b.adsBySource).toEqual({ META: 700_000, TIKTOK_ADS: 890_000 });
    expect(b.netProfit).toBe(90_000);
    expect(b.netProfit - GOC.netProfit).toBe(110_000);
    // Không chạm doanh thu / giá vốn / chi phí khác.
    expect(b.grossProfit).toBe(GOC.grossProfit);
    expect(b.shipping).toBe(GOC.shipping);
    expect(b.fixed).toBe(GOC.fixed);
  });

  it("cây: dòng TikTok hiện SỐ GỐC của Sổ, ngay dưới là dòng tín dụng giá trị ÂM (hiển thị dương)", () => {
    const items = buildPnlLineItems(b);
    const con = items.filter((i) => i.parentId === "ads");
    expect(con.map((i) => [i.id, i.value])).toEqual([
      ["ads:TIKTOK_ADS", 1_000_000],
      [ID_DONG_TIN_DUNG_TIKTOK, -110_000],
      ["ads:META", 700_000],
    ]);
    const dongTinDung = con[1];
    expect(dongTinDung).toMatchObject({ label: "Tín dụng TikTok tặng (trả thay)", isDeduction: true, depth: 2 });
    expect(displayValue(dongTinDung)).toBe(110_000);
  });

  it("Σ con = cha ở dòng Quảng cáo — theo cả value lẫn displayValue", () => {
    const items = buildPnlLineItems(b);
    const cha = items.find((i) => i.id === "ads")!;
    const con = summableChildren(items, "ads");
    expect(con.reduce((s, i) => s + i.value, 0)).toBe(cha.value);
    expect(con.reduce((s, i) => s + displayValue(i), 0)).toBe(displayValue(cha));
    expect(cha.value).toBe(1_590_000);
  });

  it("dòng nhóm Chi phí vận hành = Σ dòng con = LN gộp + thu nhập TC − LN ròng (có cả thu nhập TC ≠ 0)", () => {
    const coThuNhap = calcPnlCore([DON], CHI_PHI, { tinDungTang: TIN_DUNG, incomes: [{ amount: 3_000_000 }] });
    const items = buildPnlLineItems(coThuNhap);
    const nhom = items.find((i) => i.id === "opex")!;
    expect(summableChildren(items, "opex").reduce((s, i) => s + i.value, 0)).toBe(nhom.value);
    expect(nhom.value).toBe(coThuNhap.grossProfit + coThuNhap.financialIncome - coThuNhap.netProfit);
    // 1.590.000 ads ròng + 120.000 ship + 2.000.000 fixed — tín dụng ĐÃ nằm trong dòng ads, không trừ hai lần.
    expect(nhom.value).toBe(3_710_000);
    expect(coThuNhap.netProfit).toBe(3_090_000);
  });

  it("Excel in dòng tín dụng và Σ các dòng con ads trên file = dòng Quảng cáo", () => {
    const rows = buildPnlSheetRows(b, GOC)[0].rows as Record<string, string | number>[];
    const tien = (label: string) =>
      Number(rows.find((r) => String(r["Khoản mục"]).trim() === label)!["Số tiền (VND)"]);
    expect(tien("Tín dụng TikTok tặng (trả thay)")).toBe(110_000);
    expect(tien("TikTok Ads") + tien("Tín dụng TikTok tặng (trả thay)") + tien("Meta")).toBe(tien("Quảng cáo"));
    expect(tien("Quảng cáo")).toBe(-1_590_000);
    const dong = rows.find((r) => String(r["Khoản mục"]).trim() === "Tín dụng TikTok tặng (trả thay)")!;
    expect(String(dong["Ghi chú"])).toMatch(/tín dụng TikTok tặng/);
  });
});

describe("kẹp tín dụng trong [0, chi tiêu TikTok của Sổ]", () => {
  it("tín dụng lớn hơn chi tiêu TikTok ⇒ chỉ trừ tới hết chi tiêu TikTok, dòng TikTok về 0, không âm", () => {
    const b = calcPnlCore([DON], CHI_PHI, { tinDungTang: [{ channelId: "tiktok", amount: 2_500_000 }] });
    expect(b.adsTinDungTang).toBe(1_000_000);
    expect(b.adsBySource).toEqual({ META: 700_000, TIKTOK_ADS: 0 });
    expect(b.ads).toBe(700_000);
    expect(b.netProfit - GOC.netProfit).toBe(1_000_000);
  });

  it("kỳ không có chi tiêu TikTok ⇒ tín dụng trừ 0, không đẻ key TIKTOK_ADS", () => {
    const chiMeta = CHI_PHI.filter((e) => e.adsSource !== "TIKTOK_ADS");
    const b = calcPnlCore([DON], chiMeta, { tinDungTang: TIN_DUNG });
    expect(b.adsTinDungTang).toBe(0);
    expect(b.adsBySource).toEqual({ META: 700_000 });
    expect(b).toEqual(calcPnlCore([DON], chiMeta));
  });

  it("số âm lọt vào ⇒ coi như 0 (không bao giờ CỘNG thêm chi phí)", () => {
    const b = calcPnlCore([DON], CHI_PHI, { tinDungTang: [{ channelId: "tiktok", amount: -50_000 }] });
    expect(b.adsTinDungTang).toBe(0);
    expect(b.ads).toBe(GOC.ads);
  });
});

describe("kẹp THEO NGÀY — tín dụng ngày nào chỉ trừ chi tiêu TikTok ngày đó", () => {
  const adsNgay = (ngay: string, amount: number): PnlExpenseInput => ({
    categoryId: "ads",
    adsSource: "TIKTOK_ADS",
    channelId: "tiktok",
    amount,
    ngay,
  });
  const tdNgay = (ngay: string, amount: number): PnlTinDungInput => ({ channelId: "tiktok", amount, ngay });

  it("ngày có tín dụng mà Sổ CHƯA có chi tiêu TikTok ⇒ ngày đó trừ 0 (không trừ sang chi tiêu ngày khác)", () => {
    // 14/01 tín dụng 177.000 nhưng chi tiêu đầu tiên là 15/01 (1.000.000, tín dụng 50.000).
    const chi = [adsNgay("2026-01-15", 1_000_000)];
    const td = [tdNgay("2026-01-14", 177_000), tdNgay("2026-01-15", 50_000)];
    const b = calcPnlCore([], chi, { tinDungTang: td });
    expect(b.adsTinDungTang).toBe(50_000);
    expect(b.ads).toBe(950_000);
    // Kẹp cả kỳ (khi thiếu `ngay`) sẽ trừ 227.000 — đúng lỗi mà kẹp theo ngày chặn.
    const boNgay = <T extends { ngay?: string }>(x: T): T => ({ ...x, ngay: undefined });
    expect(calcPnlCore([], chi.map(boNgay), { tinDungTang: td.map(boNgay) }).adsTinDungTang).toBe(227_000);
  });

  it("Σ kẹp từng ngày (mỗi ngày tính riêng như chuỗi Dashboard) = kẹp cả tháng", () => {
    const chi = [adsNgay("2026-10-14", 1_430_000), adsNgay("2026-10-20", 100_000), adsNgay("2026-10-31", 143_000)];
    const td = [
      tdNgay("2026-10-13", 99_000), // không chi tiêu ⇒ 0
      tdNgay("2026-10-14", 1_100_000),
      tdNgay("2026-10-14", 110_000),
      tdNgay("2026-10-20", 269_232), // > chi tiêu ngày ⇒ kẹp 100.000
      tdNgay("2026-10-31", -5_500), // tín dụng âm (TikTok hoàn) ⇒ 0
    ];
    const thang = calcPnlCore([], chi, { tinDungTang: td });
    expect(thang.adsTinDungTang).toBe(1_210_000 + 100_000);
    const ngays = [...new Set([...chi, ...td].map((x) => x.ngay as string))];
    const tongNgay = ngays.reduce(
      (s, n) =>
        s +
        calcPnlCore(
          [],
          chi.filter((e) => e.ngay === n),
          { tinDungTang: td.filter((t) => t.ngay === n) },
        ).adsTinDungTang,
      0,
    );
    expect(tongNgay).toBe(thang.adsTinDungTang);
  });

  it("cộng các advertiser trong NGÀY trước khi kẹp: advertiser hoàn (âm) bù advertiser tiêu cùng ngày", () => {
    expect(
      tinhTinDungTruTheoNgay(
        [
          { amount: 60_000, ngay: "2026-10-20" },
          { amount: -10_000, ngay: "2026-10-20" },
        ],
        [{ amount: 1_000_000, ngay: "2026-10-20" }],
      ),
    ).toBe(50_000);
  });

  it("khoaNgayPnl theo giờ VN, không lệ thuộc TZ máy: 00:00 VN = 17:00 UTC hôm trước", () => {
    expect(khoaNgayPnl(new Date("2026-10-14T00:00:00+07:00"))).toBe("2026-10-14");
    expect(khoaNgayPnl(new Date("2026-10-14T23:59:59+07:00"))).toBe("2026-10-14");
  });
});

describe("lăng kính KÊNH — tín dụng theo kênh của ads TikTok", () => {
  it("kênh tiktok: trừ đủ (KHÔNG ép về 0 như chi phí chung fixed/interest)", () => {
    const b = calcPnlCore([DON], CHI_PHI, { channelId: "tiktok", tinDungTang: TIN_DUNG });
    expect(b.adsTinDungTang).toBe(110_000);
    expect(b.ads).toBe(890_000);
    expect(b.adsBySource).toEqual({ TIKTOK_ADS: 890_000 });
    expect(b.netProfit - calcPnlCore([DON], CHI_PHI, { channelId: "tiktok" }).netProfit).toBe(110_000);
  });

  it("kênh facebook: trừ 0, ads Meta giữ nguyên", () => {
    const b = calcPnlCore([DON], CHI_PHI, { channelId: "facebook", tinDungTang: TIN_DUNG });
    expect(b.adsTinDungTang).toBe(0);
    expect(b.ads).toBe(700_000);
    expect(b).toEqual(calcPnlCore([DON], CHI_PHI, { channelId: "facebook" }));
  });

  it("kẹp chạy TRONG lăng kính: ads TikTok gắn kênh khác không cho tín dụng kênh tiktok trừ lố", () => {
    const tiktokGanNham: PnlExpenseInput[] = [
      { categoryId: "ads", adsSource: "TIKTOK_ADS", channelId: "shopee", amount: 1_000_000 },
    ];
    const b = calcPnlCore([DON], tiktokGanNham, { channelId: "tiktok", tinDungTang: TIN_DUNG });
    expect(b.adsTinDungTang).toBe(0);
    expect(b.ads).toBe(0);
  });
});

describe("isPnlMonthEmpty xét cả tín dụng", () => {
  it("tháng chỉ có ads TikTok trả TRỌN bằng tín dụng KHÔNG phải tháng trống", () => {
    const chiTikTok: PnlExpenseInput[] = [
      { categoryId: "ads", adsSource: "TIKTOK_ADS", channelId: "tiktok", amount: 110_000 },
    ];
    const b = calcPnlCore([], chiTikTok, { tinDungTang: TIN_DUNG });
    expect(b.ads).toBe(0);
    expect(b.adsTinDungTang).toBe(110_000);
    expect(isPnlMonthEmpty(b)).toBe(false);
    expect(isPnlMonthEmpty(calcPnlCore([], [], { tinDungTang: TIN_DUNG }))).toBe(true);
  });
});
