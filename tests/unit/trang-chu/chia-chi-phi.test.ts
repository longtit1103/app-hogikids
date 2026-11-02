import { describe, expect, it } from "vitest";

import {
  calcPnlCore,
  type PnlBreakdown,
  type PnlExpenseInput,
  type PnlOrderInput,
} from "@/lib/reports/pnl";
import {
  chiaChiPhi,
  PHAN_LOAI_TRUONG_PNL,
  tinhThanhTienDiDau,
  type ChiaChiPhi,
  type ThanhTienDiDau,
} from "@/lib/trang-chu/chia-chi-phi";

/**
 * Trang chủ gộp các dòng `PnlBreakdown` thành "Chi phí" + "Tiền bán hàng đi đâu" (spec §4.3). Bẫy
 * cần canh: quên `financialIncome` (đúng lớp lỗi `buildOpexGroup`) hoặc quên một field mới thêm vào
 * `PnlBreakdown` — cả hai làm số trang chủ lệch tab Lãi/Lỗ mà không màn nào báo.
 */

const NGAY = "2026-10-10";

const DON: PnlOrderInput[] = [
  {
    status: "COMPLETED",
    channelId: "shopee",
    itemsTotal: 1_000_000,
    discount: 50_000,
    platformFeeEst: 120_000,
    items: [{ sku: "A1", quantity: 2, costPrice: 200_000 }],
  },
  {
    status: "SHIPPING",
    channelId: "tiktok",
    itemsTotal: 600_000,
    discount: 30_000,
    platformFeeEst: 60_000,
    items: [{ sku: "B1", quantity: 1, costPrice: 250_000 }],
  },
  {
    status: "RETURNED",
    channelId: "shopee",
    itemsTotal: 300_000,
    discount: 0,
    platformFeeEst: 30_000,
    returnedFee: 15_000,
    items: [{ sku: "C1", quantity: 1, costPrice: 100_000 }],
  },
];

const chiPhiSo = (categoryId: string, amount: number, adsSource: string | null = null): PnlExpenseInput => ({
  categoryId,
  adsSource,
  channelId: null,
  amount,
  ngay: NGAY,
});

const CHI_PHI_KHONG_NHAP_HANG: PnlExpenseInput[] = [
  chiPhiSo("ads", 100_000, "META"),
  { ...chiPhiSo("ads", 80_000, "TIKTOK_ADS"), channelId: "tiktok" },
  chiPhiSo("shipping", 20_000),
  chiPhiSo("packaging", 10_000),
  chiPhiSo("return_bom", 5_000),
  chiPhiSo("fixed", 200_000),
  chiPhiSo("interest", 30_000),
  chiPhiSo("other", 7_000),
  chiPhiSo("tu-tao-marketing", 3_000),
];

const OPTS = {
  incomes: [{ amount: 40_000 }],
  tinDungTang: [{ channelId: "tiktok", amount: 25_000, ngay: NGAY }],
};

const bDayDu = (): PnlBreakdown =>
  calcPnlCore(DON, [...CHI_PHI_KHONG_NHAP_HANG, chiPhiSo("purchase", 5_000_000)], OPTS);

const tongRong = (t: ThanhTienDiDau) => t.doan.reduce((s, d) => s + d.rong, 0);

/** ChiaChiPhi tổng hợp cho các ca hình học — `loiNhuan` dựng ĐÚNG đồng nhất của pnl.ts. */
function chia(p: { mauSo: number; thuNhap?: number; giaVon: number; quangCao: number; phiSan: number; vanHanhKhac: number }): ChiaChiPhi {
  const thuNhapTaiChinh = p.thuNhap ?? 0;
  const loiNhuan = p.mauSo + thuNhapTaiChinh - (p.giaVon + p.quangCao + p.phiSan + p.vanHanhKhac);
  return {
    doanhSo: p.mauSo,
    voucher: 0,
    giaVon: p.giaVon,
    quangCao: p.quangCao,
    phiSan: p.phiSan,
    vanHanhKhac: p.vanHanhKhac,
    chiPhi: p.giaVon + p.quangCao + p.phiSan + p.vanHanhKhac,
    thuNhapTaiChinh,
    loiNhuan,
    mauSo: p.mauSo,
  };
}

describe("chiaChiPhi — gộp dòng PnlBreakdown cho trang chủ", () => {
  it("đồng nhất: doanhSo − chiPhi + thuNhapTaiChinh === loiNhuan", () => {
    const b = bDayDu();
    // Fixture phải phủ đủ mọi vế, nếu không đồng nhất xanh giả.
    expect(b.financialIncome).toBe(40_000);
    expect(b.adsTinDungTang).toBe(25_000);
    expect(b.returnedOrderFee).toBe(15_000);
    expect(b.voucher).toBe(80_000);
    expect(b.other).toBe(10_000); // "other" + danh mục tự tạo

    const c = chiaChiPhi(b);
    expect(c.doanhSo - c.chiPhi + c.thuNhapTaiChinh).toBe(c.loiNhuan);
    expect(c.loiNhuan).toBe(b.netProfit);
    expect(c.quangCao).toBe(155_000); // 180k − 25k tín dụng tặng
    expect(c.vanHanhKhac).toBe(20_000 + 10_000 + 5_000 + 200_000 + 30_000 + 10_000 + 15_000);

    // "Nhập hàng" là dòng tiền — thêm/bớt KHÔNG đổi chi phí.
    const khongNhapHang = chiaChiPhi(calcPnlCore(DON, CHI_PHI_KHONG_NHAP_HANG, OPTS));
    expect(khongNhapHang.chiPhi).toBe(c.chiPhi);
    expect(khongNhapHang.loiNhuan).toBe(c.loiNhuan);
  });

  it("chiPhi = Σ các field phân loại tiền theo PHAN_LOAI_TRUONG_PNL", () => {
    const b = bDayDu();
    // Mọi field runtime của PnlBreakdown đều đã phân loại (field mới mà quên ⇒ đỏ cả tsc lẫn ở đây).
    expect(Object.keys(PHAN_LOAI_TRUONG_PNL).sort()).toEqual(Object.keys(b).sort());

    let tong = 0;
    let thuNhap = 0;
    for (const k of Object.keys(PHAN_LOAI_TRUONG_PNL) as (keyof PnlBreakdown)[]) {
      const loai = PHAN_LOAI_TRUONG_PNL[k];
      if (loai === "khongCong") continue;
      const v = b[k];
      if (typeof v !== "number") throw new Error(`field ${k} phân loại tiền nhưng không phải số`);
      if (loai === "thuNhap") thuNhap += v;
      else tong += v;
    }
    const c = chiaChiPhi(b);
    expect(c.chiPhi).toBe(tong);
    expect(c.thuNhapTaiChinh).toBe(thuNhap);
    expect(b.revenue - tong + thuNhap).toBe(b.netProfit);
  });

  it("kỳ lỗ: loiNhuan âm giữ nguyên dấu", () => {
    const b = calcPnlCore(DON, [...CHI_PHI_KHONG_NHAP_HANG, chiPhiSo("fixed", 5_000_000)], OPTS);
    const c = chiaChiPhi(b);
    expect(b.netProfit).toBeLessThan(0);
    expect(c.loiNhuan).toBe(b.netProfit);
    expect(c.doanhSo - c.chiPhi + c.thuNhapTaiChinh).toBe(c.loiNhuan);
  });

  it("kỳ rỗng: mọi số 0, mauSo 0", () => {
    const c = chiaChiPhi(calcPnlCore([], []));
    expect(c).toEqual({
      doanhSo: 0,
      voucher: 0,
      giaVon: 0,
      quangCao: 0,
      phiSan: 0,
      vanHanhKhac: 0,
      chiPhi: 0,
      thuNhapTaiChinh: 0,
      loiNhuan: 0,
      mauSo: 0,
    });
  });
});

describe("tinhThanhTienDiDau — hình học thanh tách khỏi cột %", () => {
  it("đồng nhất tongVao − tongRa === loiNhuan trên fixture calcPnlCore, thanh phủ đúng 100%", () => {
    const c = chiaChiPhi(bDayDu());
    const tongVao = c.mauSo + c.thuNhapTaiChinh;
    const tongRa = c.giaVon + c.quangCao + c.phiSan + c.vanHanhKhac;
    expect(tongVao - tongRa).toBe(c.loiNhuan);
    const t = tinhThanhTienDiDau(c);
    expect(t.thang).toBe(Math.max(tongVao, tongRa));
    expect(Math.abs(tongRong(t) - 100)).toBeLessThan(1e-9);
  });

  it("lãi + thu nhập tài chính: mauSo 100, chi phí 80, thu nhập 10 ⇒ lợi nhuận 30, Σ rong = 100, đoạn lợi nhuận rong ≈ 27,27", () => {
    const c = chia({ mauSo: 100, thuNhap: 10, giaVon: 40, quangCao: 20, phiSan: 10, vanHanhKhac: 10 });
    expect(c.loiNhuan).toBe(30);
    const t = tinhThanhTienDiDau(c);
    expect(t.thang).toBe(110);
    expect(t.doan.map((d) => d.khoa)).toEqual(["giaVon", "quangCao", "phiSan", "vanHanhKhac", "loiNhuan"]);
    expect(Math.abs(tongRong(t) - 100)).toBeLessThan(1e-9);
    const ln = t.doan.find((d) => d.khoa === "loiNhuan");
    expect(ln?.giaTri).toBe(30);
    expect(ln?.rong).toBeCloseTo(27.2727, 3);
    expect(t.vachTongVao).toBeNull();
    expect(t.lo).toBe(0);
  });

  it("lỗ: mauSo 100, chi phí 130 ⇒ Σ rong = 100, không đoạn loiNhuan, vachTongVao ≈ 76,92, lo = 30", () => {
    const t = tinhThanhTienDiDau(chia({ mauSo: 100, giaVon: 70, quangCao: 30, phiSan: 20, vanHanhKhac: 10 }));
    expect(t.thang).toBe(130);
    expect(Math.abs(tongRong(t) - 100)).toBeLessThan(1e-9);
    expect(t.doan.some((d) => d.khoa === "loiNhuan")).toBe(false);
    expect(t.vachTongVao).toBeCloseTo(76.923, 2);
    expect(t.lo).toBe(30);
  });

  it("lỗ có thu nhập tài chính: mauSo 100, thu nhập 10, chi phí 130 ⇒ vachTongVao ≈ 84,62, lo = 20", () => {
    const t = tinhThanhTienDiDau(chia({ mauSo: 100, thuNhap: 10, giaVon: 70, quangCao: 30, phiSan: 20, vanHanhKhac: 10 }));
    expect(Math.abs(tongRong(t) - 100)).toBeLessThan(1e-9);
    expect(t.vachTongVao).toBeCloseTo(84.615, 2);
    expect(t.lo).toBe(20);
  });

  it("hoà vốn: tongVao === tongRa ⇒ Σ rong = 100, vachTongVao null, lo 0", () => {
    const t = tinhThanhTienDiDau(chia({ mauSo: 100, giaVon: 50, quangCao: 25, phiSan: 15, vanHanhKhac: 10 }));
    expect(Math.abs(tongRong(t) - 100)).toBeLessThan(1e-9);
    expect(t.doan.some((d) => d.khoa === "loiNhuan")).toBe(false);
    expect(t.vachTongVao).toBeNull();
    expect(t.lo).toBe(0);
  });

  it("kỳ rỗng ⇒ thang 0, doan rỗng", () => {
    const t = tinhThanhTienDiDau(chiaChiPhi(calcPnlCore([], [])));
    expect(t).toEqual({ thang: 0, doan: [], vachTongVao: null, lo: 0 });
  });

  it("đoạn âm ⇒ rong 0", () => {
    const t = tinhThanhTienDiDau(chia({ mauSo: 100, giaVon: 50, quangCao: -5, phiSan: 10, vanHanhKhac: 10 }));
    const qc = t.doan.find((d) => d.khoa === "quangCao");
    expect(qc?.giaTri).toBe(-5);
    expect(qc?.rong).toBe(0);
    expect(t.doan.every((d) => d.rong >= 0)).toBe(true);
    expect(Math.abs(tongRong(t) - 100)).toBeLessThan(1e-9);
  });
});
