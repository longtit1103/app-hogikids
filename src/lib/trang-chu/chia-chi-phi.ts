import { pnlPercentBase } from "@/lib/reports/pnl-percent-base";

import type { PnlBreakdown } from "@/lib/reports/pnl";

/**
 * Gộp dòng `PnlBreakdown` cho trang chủ (spec trang chủ §4.3): "Chi phí" và "Tiền bán hàng đi đâu"
 * là phép CỘNG các field có sẵn — KHÔNG tính lại công thức P&L (nguồn duy nhất `pnl.ts`, bất biến #1).
 * `loiNhuan` lấy thẳng `netProfit`, không suy bằng hiệu.
 *
 * Module THUẦN, chỉ `import type` từ `pnl.ts`: Client Component dùng gián tiếp (thanh tiền đi đâu),
 * import giá trị từ `pnl.ts` là kéo Prisma vào browser bundle.
 */

export type ChiaChiPhi = {
  doanhSo: number; // b.revenue
  voucher: number; // b.voucher
  giaVon: number; // b.cogs
  quangCao: number; // b.ads (đã trừ tín dụng TikTok tặng)
  phiSan: number; // b.platformFee
  vanHanhKhac: number; // shipping + packaging + returnBom + fixed + interest + other + returnedOrderFee
  chiPhi: number; // giaVon + quangCao + phiSan + voucher + vanHanhKhac (số trên thẻ Chi phí)
  thuNhapTaiChinh: number; // b.financialIncome
  loiNhuan: number; // b.netProfit (KHÔNG tự tính lại)
  mauSo: number; // pnlPercentBase(b)
};

/**
 * Phân loại TỪNG field của `PnlBreakdown`. `Record` trên `keyof PnlBreakdown` ⇒ ai thêm field mới vào
 * `PnlBreakdown` mà quên phân loại thì `tsc` đỏ; test `chia-chi-phi.test.ts` còn so khoá runtime.
 * `khongCong` = field không phải một vế tiền trừ/cộng riêng (tổng trung gian, số đếm, chi tiết đã gồm
 * trong field khác — vd `adsBySource`/`adsTinDungTang` đã nằm trong `ads`).
 */
export const PHAN_LOAI_TRUONG_PNL: Record<
  keyof PnlBreakdown,
  "giaVon" | "quangCao" | "phiSan" | "voucher" | "vanHanhKhac" | "thuNhap" | "khongCong"
> = {
  revenue: "khongCong",
  platformFee: "phiSan",
  returnedOrderFee: "vanHanhKhac",
  voucher: "voucher",
  netRevenue: "khongCong",
  cogs: "giaVon",
  grossProfit: "khongCong",
  ads: "quangCao",
  adsBySource: "khongCong",
  adsTinDungTang: "khongCong",
  shipping: "vanHanhKhac",
  packaging: "vanHanhKhac",
  returnBom: "vanHanhKhac",
  fixed: "vanHanhKhac",
  financialIncome: "thuNhap",
  interest: "vanHanhKhac",
  other: "vanHanhKhac",
  otherCategoryIds: "khongCong",
  netProfit: "khongCong",
  orderCount: "khongCong",
  returnBomOrderCount: "khongCong",
  skuMissingCount: "khongCong",
  skuUnknownLineCount: "khongCong",
};

export function chiaChiPhi(b: PnlBreakdown): ChiaChiPhi {
  const vanHanhKhac =
    b.shipping + b.packaging + b.returnBom + b.fixed + b.interest + b.other + b.returnedOrderFee;
  return {
    doanhSo: b.revenue,
    voucher: b.voucher,
    giaVon: b.cogs,
    quangCao: b.ads,
    phiSan: b.platformFee,
    vanHanhKhac,
    chiPhi: b.cogs + b.ads + b.platformFee + b.voucher + vanHanhKhac,
    thuNhapTaiChinh: b.financialIncome,
    loiNhuan: b.netProfit,
    mauSo: pnlPercentBase(b),
  };
}

// ─── Hình học thanh "Tiền bán hàng đi đâu" ─────────────────────────────────────────────────────────

export type KhoaDoan = "giaVon" | "quangCao" | "phiSan" | "vanHanhKhac" | "loiNhuan";

export type ThanhTienDiDau = {
  thang: number; // 0 ⇒ không vẽ
  doan: Array<{ khoa: KhoaDoan; giaTri: number; rong: number /* 0..100 */ }>; // theo thứ tự; loiNhuan chỉ khi > 0
  vachTongVao: number | null; // % vị trí vạch "hết tiền vào", CHỈ khi lỗ
  lo: number; // |loiNhuan| khi lỗ, 0 khi lãi
};

const KHOA_CHI_PHI = ["giaVon", "quangCao", "phiSan", "vanHanhKhac"] as const;

/**
 * Độ dài đoạn trên thanh TÁCH khỏi cột % chữ (cột % luôn `x / mauSo`, có thể cộng ≠ 100%):
 * - `tongVao = mauSo + thuNhapTaiChinh`, `tongRa = giá vốn + quảng cáo + phí sàn + vận hành`
 *   (voucher KHÔNG có đoạn — đã trừ trong mẫu số). Theo pnl.ts: `tongVao − tongRa === loiNhuan`.
 * - `thang = max(tongVao, tongRa)` = 100% chiều dài. Lãi ⇒ đoạn chi phí + đoạn lợi nhuận phủ đủ thanh.
 *   Lỗ ⇒ đoạn chi phí phủ đủ thanh, vạch dọc tại `tongVao / thang`.
 * - Giá trị đoạn âm (dữ liệu dị) ⇒ rộng 0; `tongRa` cộng phần dương để thanh vẫn phủ đúng 100%.
 *   Đoạn lợi nhuận rộng theo phần dư hình học `tongVao − tongRa` (= `loiNhuan` khi dữ liệu lành),
 *   nhãn vẫn mang `loiNhuan` thật.
 */
export function tinhThanhTienDiDau(c: ChiaChiPhi): ThanhTienDiDau {
  const tongVao = Math.max(0, c.mauSo + c.thuNhapTaiChinh);
  const tongRa = KHOA_CHI_PHI.reduce((s, k) => s + Math.max(0, c[k]), 0);
  const thang = Math.max(tongVao, tongRa);
  if (thang <= 0) return { thang: 0, doan: [], vachTongVao: null, lo: 0 };

  const doan: ThanhTienDiDau["doan"] = KHOA_CHI_PHI.map((k) => ({
    khoa: k,
    giaTri: c[k],
    rong: (Math.max(0, c[k]) / thang) * 100,
  }));

  if (c.loiNhuan > 0) {
    doan.push({ khoa: "loiNhuan", giaTri: c.loiNhuan, rong: (Math.max(0, tongVao - tongRa) / thang) * 100 });
    return { thang, doan, vachTongVao: null, lo: 0 };
  }
  if (c.loiNhuan < 0) {
    return { thang, doan, vachTongVao: (tongVao / thang) * 100, lo: Math.abs(c.loiNhuan) };
  }
  return { thang, doan, vachTongVao: null, lo: 0 };
}
