import { eachDayOfInterval, format } from "date-fns";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { khoangServerThuocTinh, lastMonthToSameDay, resolveRangePreset, type DateRange } from "@/lib/date-range";
import type { Quyen } from "@/lib/quyen/danh-muc-quyen";
import type { ChannelPnl, PnlBreakdown } from "@/lib/reports/pnl";
import type { ProductReportRow } from "@/lib/reports/product-report";
import { nguoiDungGia } from "../../helpers/nguoi-dung-gia";

/**
 * Loader trang chủ: nguồn số (`calcPnl`, `computeDailySeries`, `computeChannelPnl`, khối chi tiết) mock trả
 * số CANH ở mọi trường nhạy cảm — người thiếu `gia-von-loi-nhuan:xem` thì DTO không được chứa một số canh
 * nào (kể cả số suy ra như chi phí). Chủ shop thì có (chứng minh phép quét nhìn thấy, không xanh giả).
 */

const CANH = {
  cogs: 9_131_717,
  gross: 8_272_721,
  net: 6_363_631,
  netKenh: 5_454_541,
  margin: 47.123,
  ngayLai: 4_545_451,
  ngayChiPhi: 3_737_373,
  spLai: 2_828_281,
  spCogs: 1_919_191,
};

const m = vi.hoisted(() => ({
  calcPnl: vi.fn(),
  computeChannelPnl: vi.fn(),
  computeDailySeries: vi.fn(),
  demTrangThaiDon: vi.fn(),
  taiKhoiChiTietDashboard: vi.fn(),
  docSanPhamCoBienTheTonThap: vi.fn(),
  ensureRecurringExpensesForMonths: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({ prisma: {} }));
vi.mock("@/lib/reports/pnl", () => ({ calcPnl: m.calcPnl, computeChannelPnl: m.computeChannelPnl }));
vi.mock("@/lib/reports/daily-series", () => ({ computeDailySeries: m.computeDailySeries }));
vi.mock("@/lib/trang-chu/dem-trang-thai-don", () => ({ demTrangThaiDon: m.demTrangThaiDon }));
vi.mock("@/lib/dashboard/khoi-chi-tiet-theo-quyen", () => ({ taiKhoiChiTietDashboard: m.taiKhoiChiTietDashboard }));
vi.mock("@/lib/queries/variants", () => ({ docSanPhamCoBienTheTonThap: m.docSanPhamCoBienTheTonThap }));
vi.mock("@/lib/expenses/ensure-recurring-expenses", async (goc) => ({
  ...(await goc<typeof import("@/lib/expenses/ensure-recurring-expenses")>()),
  ensureRecurringExpensesForMonths: m.ensureRecurringExpensesForMonths,
}));

import { taiDuLieuTrangChu } from "@/lib/trang-chu/tai-du-lieu-trang-chu";

const NOW = new Date("2026-10-31T10:00:00+07:00");

function pnlCanh(): PnlBreakdown {
  return {
    revenue: 100_000_000,
    platformFee: 5_000_000,
    returnedOrderFee: 100_000,
    voucher: 1_000_000,
    netRevenue: 94_000_000,
    cogs: CANH.cogs,
    grossProfit: CANH.gross,
    ads: 2_000_000,
    adsBySource: { META: 2_000_000 },
    adsTinDungTang: 0,
    shipping: 0,
    packaging: 0,
    returnBom: 0,
    fixed: 0,
    financialIncome: 0,
    interest: 0,
    other: 0,
    otherCategoryIds: [],
    netProfit: CANH.net,
    orderCount: 40,
    returnBomOrderCount: 2,
    skuMissingCount: 0,
    skuUnknownLineCount: 0,
  };
}

function kenhCanh(): ChannelPnl[] {
  const goc = {
    color: "#f60",
    isActive: true,
    aov: 2_500_000,
    ads: 2_000_000,
    platformFee: 5_000_000,
    returnBomOrderCount: 2,
    returnBomRatePct: 4.7,
    roas: 50,
    marginPct: CANH.margin,
  };
  return [
    { ...goc, channelId: "tiktok", name: "TikTok", revenue: 30_000_000, orderCount: 10, netProfit: CANH.netKenh },
    { ...goc, channelId: "shopee", name: "Shopee", revenue: 70_000_000, orderCount: 30, netProfit: CANH.netKenh },
    { ...goc, channelId: "facebook", name: "Facebook", revenue: 0, orderCount: 0, netProfit: -1 }, // chỉ có chi tiêu ads
    { ...goc, channelId: "zalo", name: "Zalo", revenue: 0, orderCount: 0, ads: 0, netProfit: 0 }, // không bán, không ads
  ];
}

function spCanh(): ProductReportRow {
  return {
    productId: "sp-1",
    name: "Áo",
    imageUrl: null,
    soldQty: 3,
    revenue: 6_000_000,
    cogs: CANH.spCogs,
    grossProfit: CANH.spLai,
    marginPct: CANH.margin,
    currentStock: 4,
    orderCount: 3,
    skus: [
      { variantId: "v1", sku: "A", label: "M", soldQty: 3, revenue: 6_000_000, cogs: CANH.spCogs, grossProfit: CANH.spLai, currentStock: 4 },
    ],
  };
}

/** Chuỗi ngày phủ đúng range được yêu cầu — để đo độ dài biểu đồ. */
function chuoiNgay(r: DateRange) {
  return eachDayOfInterval({ start: r.from, end: r.to }).map((d) => ({
    date: format(d, "yyyy-MM-dd"),
    revenue: 1_000_000,
    netProfit: CANH.ngayLai,
    chiPhi: CANH.ngayChiPhi,
    orderCount: 2,
  }));
}

const KHOA_CAM = ["cogs", "grossProfit", "netProfit", "marginPct", "chiPhi", "loiNhuan"];

function nguoi(role: "OWNER" | "STAFF", ...q: Quyen[]) {
  return nguoiDungGia({ role, quyen: new Set(q) });
}

function soCanhTrong(json: string): number[] {
  return Object.values(CANH).filter((so) => json.includes(String(so)));
}

beforeEach(() => {
  vi.clearAllMocks();
  m.calcPnl.mockImplementation(async () => pnlCanh());
  m.computeChannelPnl.mockImplementation(async () => kenhCanh());
  m.computeDailySeries.mockImplementation(async (r: DateRange) => chuoiNgay(r));
  m.demTrangThaiDon.mockResolvedValue({ PENDING: 5, SHIPPING: 10, COMPLETED: 25, RETURNED: 1, CANCELLED: 1 });
  m.docSanPhamCoBienTheTonThap.mockResolvedValue(new Set(["sp-1"]));
  m.ensureRecurringExpensesForMonths.mockResolvedValue(0);
  m.taiKhoiChiTietDashboard.mockImplementation(async (_nd: unknown, _r: unknown, q: { coQuyenGiaVon: boolean }) => ({
    productReport: q.coQuyenGiaVon
      ? { coQuyenGiaVon: true, rows: [spCanh()] }
      : { coQuyenGiaVon: false, rows: [{ productId: "sp-1", name: "Áo", imageUrl: null, soldQty: 3, revenue: 6_000_000, currentStock: 4, orderCount: 3, skus: [] }] },
    lowStock: { rows: [], total: 0 },
  }));
});

describe("taiDuLieuTrangChu — che giá vốn", () => {
  it("(a) thiếu quyền giá vốn ⇒ DTO không chứa số canh, tienDiDau/laiNenDay null, không đọc tồn thấp theo SP", async () => {
    const nd = nguoi("STAFF", "tong-quan:xem", "bao-cao:xem", "ton-kho:xem");
    const du = await taiDuLieuTrangChu(nd, resolveRangePreset("this_month", NOW), NOW);
    const json = JSON.stringify(du);
    expect(soCanhTrong(json)).toEqual([]);
    for (const k of KHOA_CAM) expect(json).not.toContain(`"${k}"`);
    expect(du.tienDiDau).toBeNull();
    expect(du.laiNenDay).toBeNull();
    expect(du.theVaBieuDo.coQuyenGiaVon).toBe(false);
    expect(du.theoKenh.coQuyenGiaVon).toBe(false);
    expect(m.docSanPhamCoBienTheTonThap).not.toHaveBeenCalled();
    // Số không nhạy cảm vẫn có.
    expect(du.banChay).toEqual([{ productId: "sp-1", ten: "Áo", soLuong: 3, doanhSo: 6_000_000 }]);
    // Nhánh che vẫn liệt kê kênh chỉ-ads nhưng doanh số/đơn 0 và KHÔNG có trường lãi (cũng không lộ số ads).
    expect(du.theoKenh.rows.map((r) => r.channelId)).toEqual(["shopee", "tiktok", "facebook"]);
    expect(du.theoKenh.rows.find((r) => r.channelId === "facebook")).toEqual({ channelId: "facebook", ten: "Facebook", doanhSo: 0, donHang: 0 });
    expect(JSON.stringify(du.theoKenh)).not.toContain("loiNhuan");
    expect(du.theVaBieuDo.the.doanhSo).toEqual({ hienTai: 100_000_000, kyTruoc: 100_000_000, phanTram: 0 });
    expect(du.theVaBieuDo.the.tbMoiDon).toBe(2_500_000);
  });

  it("(b) chủ shop ⇒ có số canh, có tiền đi đâu + lãi nên đẩy, kênh lọc + sort doanh số", async () => {
    const du = await taiDuLieuTrangChu(nguoi("OWNER"), resolveRangePreset("this_month", NOW), NOW);
    const json = JSON.stringify(du);
    expect(soCanhTrong(json)).toEqual(expect.arrayContaining([CANH.net, CANH.netKenh, CANH.ngayLai, CANH.ngayChiPhi, CANH.spLai]));
    expect(du.tienDiDau?.giaVon).toBe(CANH.cogs);
    expect(du.tienDiDau?.loiNhuan).toBe(CANH.net);
    expect(du.laiNenDay?.top[0]).toMatchObject({ productId: "sp-1", loiNhuan: CANH.spLai, tonThap: true });
    expect(m.docSanPhamCoBienTheTonThap).toHaveBeenCalledTimes(1);
    if (!du.theVaBieuDo.coQuyenGiaVon) throw new Error("phải nhánh đầy đủ");
    expect(du.theVaBieuDo.the.loiNhuan.hienTai).toBe(CANH.net);
    expect(du.theVaBieuDo.the.bienLai).toBeCloseTo((CANH.net / 99_000_000) * 100, 6);
    expect(du.theVaBieuDo.the.tyLeHoanHuy).toBeCloseTo((2 / 42) * 100, 6);
    if (!du.theoKenh.coQuyenGiaVon) throw new Error("phải nhánh đầy đủ");
    // Kênh có bán (doanh số giảm) trước, kênh CHỈ có ads ở sau, kênh không bán không ads (zalo) vắng.
    expect(du.theoKenh.rows.map((r) => r.channelId)).toEqual(["shopee", "tiktok", "facebook"]);
    expect(du.theoKenh.rows.find((r) => r.channelId === "facebook")).toMatchObject({ doanhSo: 0, donHang: 0, loiNhuan: -1 });
    expect(du.tinhTrangDon.tong).toBe(42);
  });
});

describe("taiDuLieuTrangChu — Bán chạy", () => {
  it("xếp theo SỐ LƯỢNG bán (khớp cột hiển thị), đồng hạng thì doanh số cao trước", async () => {
    const dong = (productId: string, soldQty: number, revenue: number) => ({
      ...spCanh(), productId, name: productId, soldQty, revenue, skus: [],
    });
    m.taiKhoiChiTietDashboard.mockResolvedValueOnce({
      productReport: {
        coQuyenGiaVon: true,
        rows: [dong("ITNHUNGDAT", 2, 9_000_000), dong("NHIEUHANG", 50, 1_000_000), dong("HOA-RE", 7, 700_000), dong("HOA-DAT", 7, 7_000_000)],
      },
      lowStock: { rows: [], total: 0 },
    });
    const du = await taiDuLieuTrangChu(nguoi("OWNER"), resolveRangePreset("this_month", NOW), NOW);
    expect(du.banChay?.map((r) => r.productId)).toEqual(["NHIEUHANG", "HOA-DAT", "HOA-RE", "ITNHUNGDAT"]);
  });
});

describe("taiDuLieuTrangChu — kỳ", () => {
  it("(c) Hôm nay ⇒ kỳ so = trọn hôm qua, biểu đồ 7 ngày, không đường kỳ trước", async () => {
    const du = await taiDuLieuTrangChu(nguoi("OWNER"), resolveRangePreset("today", NOW), NOW);
    const kyTruoc = m.calcPnl.mock.calls[1]?.[0] as DateRange;
    expect(format(kyTruoc.from, "yyyy-MM-dd HH:mm")).toBe("2026-10-30 00:00");
    expect(format(kyTruoc.to, "yyyy-MM-dd HH:mm:ss")).toBe("2026-10-30 23:59:59");
    expect(du.theVaBieuDo.motNgay).toBe(true);
    expect(du.theVaBieuDo.nhanKySoSanh).toBe("hôm qua");
    expect(du.theVaBieuDo.bieuDo).toHaveLength(7);
    expect(du.theVaBieuDo.bieuDo.every((d) => d.kyTruoc === null)).toBe(true);
    expect(du.theVaBieuDo.bieuDo.filter((d) => d.laNgayDangXem).map((d) => d.ngay)).toEqual(["2026-10-31"]);
    expect(m.computeDailySeries).toHaveBeenCalledTimes(1);
  });

  it("(d) Tháng này ⇒ kỳ so = lastMonthToSameDay(now), kỳ tính kẹp về hôm nay, ensure phủ đủ tháng", async () => {
    const du = await taiDuLieuTrangChu(nguoi("OWNER"), resolveRangePreset("this_month", NOW), NOW);
    expect(m.calcPnl.mock.calls[1]?.[0]).toEqual(lastMonthToSameDay(NOW));
    expect(du.kyDangXem).toEqual({ tu: "2026-10-01", den: "2026-10-31" });
    expect(du.theVaBieuDo.nhanKySoSanh).toBe("cùng kỳ tháng trước");
    expect(du.theVaBieuDo.bieuDo).toHaveLength(31);
    // Kỳ trước 30 ngày ⇒ điểm 31 không có đường kỳ trước.
    expect(du.theVaBieuDo.bieuDo[30]?.kyTruoc).toBeNull();
    expect(du.theVaBieuDo.bieuDo[29]?.kyTruoc).not.toBeNull();
    const thang = (m.ensureRecurringExpensesForMonths.mock.calls[0]?.[0] as Date[]).map((d) => format(d, "yyyy-MM"));
    expect(new Set(thang)).toEqual(new Set(["2026-10", "2026-09"]));
    expect(m.ensureRecurringExpensesForMonths.mock.invocationCallOrder[0]).toBeLessThan(
      m.calcPnl.mock.invocationCallOrder[0] ?? 0
    );
  });

  it("(d2) ngày 01, Tháng này ⇒ kỳ so 01/10 (không phải hôm qua), nhãn cùng kỳ tháng trước, biểu đồ không 7 ngày", async () => {
    const mung1 = new Date("2026-11-01T10:00:00+07:00");
    const du = await taiDuLieuTrangChu(nguoi("OWNER"), resolveRangePreset("this_month", mung1), mung1);
    const kyTruoc = m.calcPnl.mock.calls[1]?.[0] as DateRange;
    expect(kyTruoc).toEqual(lastMonthToSameDay(mung1));
    expect(format(kyTruoc.from, "yyyy-MM-dd HH:mm")).toBe("2026-10-01 00:00");
    expect(du.theVaBieuDo.nhanKySoSanh).toBe("cùng kỳ tháng trước");
    expect(du.theVaBieuDo.motNgay).toBe(false);
    expect(du.theVaBieuDo.bieuDo).toHaveLength(1);
    expect(du.theVaBieuDo.bieuDo[0]?.kyTruoc).not.toBeNull();
    expect(m.computeDailySeries.mock.calls[1]?.[0]).toEqual(lastMonthToSameDay(mung1));
  });

  it("(d3) ngày 01, Hôm nay ⇒ kỳ so trọn 31/10, nhãn hôm qua", async () => {
    const mung1 = new Date("2026-11-01T10:00:00+07:00");
    const du = await taiDuLieuTrangChu(nguoi("OWNER"), resolveRangePreset("today", mung1), mung1);
    const kyTruoc = m.calcPnl.mock.calls[1]?.[0] as DateRange;
    expect(format(kyTruoc.from, "yyyy-MM-dd HH:mm")).toBe("2026-10-31 00:00");
    expect(format(kyTruoc.to, "yyyy-MM-dd HH:mm:ss")).toBe("2026-10-31 23:59:59");
    expect(du.theVaBieuDo.nhanKySoSanh).toBe("hôm qua");
    expect(du.theVaBieuDo.motNgay).toBe(true);
  });

  it("(d4) Tháng trước (T9, now 31/10) ⇒ calcPnl lần 2 = TRỌN T8, nhãn 'tháng trước đó', biểu đồ kỳ trước cùng kỳ, ensure phủ T8", async () => {
    const t9 = resolveRangePreset("last_month", NOW);
    const du = await taiDuLieuTrangChu(nguoi("OWNER"), t9, NOW);
    const kyTruoc = m.calcPnl.mock.calls[1]?.[0] as DateRange;
    expect(format(kyTruoc.from, "yyyy-MM-dd HH:mm")).toBe("2026-08-01 00:00");
    expect(format(kyTruoc.to, "yyyy-MM-dd HH:mm")).toBe("2026-08-31 23:59");
    expect(du.theVaBieuDo.nhanKySoSanh).toBe("tháng trước đó");
    // Biểu đồ nhiều ngày ⇒ chuỗi kỳ trước = đúng kỳ so của thẻ (T8, 31 ngày); T9 có 30 ngày ⇒ mọi điểm có kỳ trước.
    expect(m.computeDailySeries.mock.calls[1]?.[0]).toEqual(kyTruoc);
    expect(du.theVaBieuDo.bieuDo).toHaveLength(30);
    expect(du.theVaBieuDo.bieuDo.every((d) => d.kyTruoc !== null)).toBe(true);
    const thang = (m.ensureRecurringExpensesForMonths.mock.calls[0]?.[0] as Date[]).map((d) => format(d, "yyyy-MM"));
    expect(new Set(thang)).toEqual(new Set(["2026-09", "2026-08"]));
  });

  it("(e) khoangServer = khoangServerThuocTinh(range gốc, KHÔNG kẹp); kyDangXem là kỳ đã kẹp", async () => {
    const giuaThang = new Date("2026-10-20T10:00:00+07:00");
    const range = resolveRangePreset("this_month", giuaThang);
    const du = await taiDuLieuTrangChu(nguoi("OWNER"), range, giuaThang);
    expect(du.khoangServer).toBe(khoangServerThuocTinh(range));
    expect(du.khoangServer).toBe("2026-10-01..2026-10-31");
    expect(du.kyDangXem).toEqual({ tu: "2026-10-01", den: "2026-10-20" });
  });
});
