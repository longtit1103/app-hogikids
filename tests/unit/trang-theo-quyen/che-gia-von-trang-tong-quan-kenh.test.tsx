import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Quyen } from "@/lib/quyen/danh-muc-quyen";
import type { NguoiDung } from "@/lib/quyen/nguoi-dung-phien";
import type { ChannelPnl, PnlBreakdown } from "@/lib/reports/pnl";
import { nguoiDungGia } from "../../helpers/nguoi-dung-gia";
import { choChuaSoCanh, khoaTrongCay } from "./quet-cay-phan-tu";

/**
 * Che giá vốn ở TẦNG PAGE (`/`, `/kenh`, `/kenh/[id]`): nguồn số (`calcPnl`, `computeChannelPnl`,
 * `computeDailySeries`) được mock trả số CANH ở `cogs`/`grossProfit`/`netProfit`/`marginPct` — rồi gọi
 * chính Server Component của trang và quét TOÀN BỘ props của cây trả về.
 *
 * Người thiếu `gia-von-loi-nhuan:xem` ⇒ không một số canh nào có mặt (không trong payload client,
 * không trong HTML server). Chủ shop ⇒ có (chứng minh phép quét nhìn thấy chúng, không xanh giả).
 * Test helper (`pnlTheoQuyen`…) riêng lẻ KHÔNG đủ: bỏ quên một lời gọi che ở page thì helper vẫn xanh.
 */

let nguoiHienTai: NguoiDung | null = null;

vi.mock("@/lib/quyen/nguoi-dung-phien", async (goc) => ({
  ...(await goc<typeof import("@/lib/quyen/nguoi-dung-phien")>()),
  docNguoiDungPhien: async () => nguoiHienTai,
}));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`REDIRECT:${url}`);
  },
  useRouter: () => ({ refresh: () => {}, replace: () => {}, push: () => {} }),
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams(),
}));

const CANH = { cogs: 9_131_717, gross: 8_272_721, net: 6_363_631, netKenh: 5_454_541, margin: 47.123, ngay: 4_545_451, lai: 3_939_393 };

const m = vi.hoisted(() => ({
  calcPnl: vi.fn(),
  computeChannelPnl: vi.fn(),
  computeDailySeries: vi.fn(),
  computeChannelDailyRevenue: vi.fn(),
  computeChannelRevenueAdsSeries: vi.fn(),
  sumThuNhapTaiChinh: vi.fn(),
  computeProductReport: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    syncLog: { count: async () => 1 },
    order: { count: async () => 1 },
    channel: {
      findMany: async () => [
        { id: "shopee", name: "Shopee", color: "#f60", isActive: true, platformFeePct: 0, paymentFeePct: 0, sortOrder: 1 },
      ],
      findUnique: async () => ({ id: "shopee", name: "Shopee", color: "#f60", isActive: true, platformFeePct: 0, paymentFeePct: 0 }),
    },
    expense: { findMany: async () => [] },
    expenseCategory: { findMany: async () => [] },
  },
}));
vi.mock("@/lib/reports/pnl", () => ({
  calcPnl: m.calcPnl,
  computeChannelPnl: m.computeChannelPnl,
  sumThuNhapTaiChinh: m.sumThuNhapTaiChinh,
}));
vi.mock("@/lib/reports/daily-series", () => ({
  computeDailySeries: m.computeDailySeries,
  computeChannelDailyRevenue: m.computeChannelDailyRevenue,
  computeChannelRevenueAdsSeries: m.computeChannelRevenueAdsSeries,
}));
vi.mock("@/lib/reports/product-report", () => ({ computeProductReport: m.computeProductReport }));
vi.mock("@/lib/queries/orders", () => ({ getOrderListPage: async () => ({ rows: [], total: 0 }) }));
vi.mock("@/lib/dashboard/khoi-chi-tiet-theo-quyen", () => ({
  SYNC_KINDS_DASHBOARD: [],
  taiKhoiChiTietDashboard: async () => ({ productReport: null, lowStock: null, syncLogs: null }),
}));
vi.mock("@/lib/expenses/ensure-recurring-expenses", () => ({
  ensureRecurringExpensesForMonths: async () => undefined,
  monthStartsInRange: () => [],
}));
vi.mock("@/lib/date-range-cookie-server", () => ({ docLuaChonDaLuu: async () => null }));
vi.mock("@/components/shell/page-title", () => ({ PageTitle: () => null }));

import DashboardPage from "@/app/(app)/page";
import KenhChiTietPage from "@/app/(app)/kenh/[id]/page";
import KenhPage from "@/app/(app)/kenh/page";

/** P&L đầy đủ mang số canh ở mọi trường nhạy cảm. */
function pnlCanh(): PnlBreakdown {
  return {
    revenue: 100_000_000,
    voucher: 1_000_000,
    platformFee: 5_000_000,
    netRevenue: 94_000_000,
    cogs: CANH.cogs,
    grossProfit: CANH.gross,
    ads: 2_000_000,
    netProfit: CANH.net,
    orderCount: 40,
    returnBomOrderCount: 2,
  } as unknown as PnlBreakdown;
}

function kenhCanh(): ChannelPnl {
  return {
    channelId: "shopee",
    name: "Shopee",
    color: "#f60",
    isActive: true,
    revenue: 100_000_000,
    orderCount: 40,
    aov: 2_500_000,
    ads: 2_000_000,
    platformFee: 5_000_000,
    returnBomOrderCount: 2,
    returnBomRatePct: 4.7,
    netProfit: CANH.netKenh,
    roas: 50,
    marginPct: CANH.margin,
  };
}

/** Mọi chỗ trong cây mang một số canh nào đó. */
function choLo(el: unknown): string[] {
  return [CANH.cogs, CANH.gross, CANH.net, CANH.netKenh, CANH.margin, CANH.ngay, CANH.lai].flatMap((so) =>
    choChuaSoCanh(el, so).map((d) => `${so} @ ${d}`),
  );
}

const KHOA_CAM = ["cogs", "grossProfit", "netProfit", "marginPct"];

function dat(role: "OWNER" | "STAFF", ...q: Quyen[]) {
  nguoiHienTai = nguoiDungGia({ role, quyen: new Set(q) });
}

beforeEach(() => {
  vi.clearAllMocks();
  m.calcPnl.mockImplementation(async () => pnlCanh());
  m.computeChannelPnl.mockImplementation(async () => [kenhCanh()]);
  m.computeDailySeries.mockResolvedValue([{ date: "2026-10-01", revenue: 1_000_000, netProfit: CANH.ngay }]);
  m.computeChannelDailyRevenue.mockResolvedValue([]);
  m.computeChannelRevenueAdsSeries.mockResolvedValue([]);
  m.sumThuNhapTaiChinh.mockResolvedValue(CANH.lai);
  m.computeProductReport.mockImplementation(async (_r: unknown, _o: unknown, q: { coQuyenGiaVon: boolean }) => ({
    coQuyenGiaVon: q.coQuyenGiaVon,
    rows: [],
  }));
});

const dungDashboard = () => DashboardPage({ searchParams: Promise.resolve({}) });
const dungKenh = () => KenhPage({ searchParams: Promise.resolve({}) });
const dungKenhChiTiet = () =>
  KenhChiTietPage({ params: Promise.resolve({ id: "shopee" }), searchParams: Promise.resolve({}) });

describe.each([
  { ten: "Dashboard /", quyen: "tong-quan:xem" as Quyen, dung: dungDashboard },
  { ten: "/kenh", quyen: "kenh:xem" as Quyen, dung: dungKenh },
  { ten: "/kenh/[id]", quyen: "kenh:xem" as Quyen, dung: dungKenhChiTiet },
])("$ten — che giá vốn ở tầng page", ({ quyen, dung }) => {
  it("thiếu giá vốn ⇒ KHÔNG số canh nào, không khoá nhạy cảm nào trong props cây trang", async () => {
    dat("STAFF", quyen);
    const el = await dung();
    expect(choLo(el)).toEqual([]);
    const khoa = khoaTrongCay(el);
    for (const k of KHOA_CAM) expect(khoa.has(k), `khoá ${k}`).toBe(false);
  });

  it("chủ shop ⇒ có số canh (phép quét nhìn thấy chúng thật)", async () => {
    dat("OWNER");
    const el = await dung();
    expect(choLo(el).length).toBeGreaterThan(0);
  });
});

describe("/kenh — chú thích lãi tiết kiệm (thành phần LN ròng) chỉ khi có giá vốn", () => {
  it("thiếu giá vốn ⇒ không đọc thu nhập tài chính, không chú thích", async () => {
    dat("STAFF", "kenh:xem");
    const el = await dungKenh();
    expect(m.sumThuNhapTaiChinh).not.toHaveBeenCalled();
    expect(choChuaSoCanh(el, CANH.lai)).toEqual([]);
  });

  it("có giá vốn ⇒ chú thích nêu đúng số lãi", async () => {
    dat("STAFF", "kenh:xem", "gia-von-loi-nhuan:xem");
    const el = await dungKenh();
    expect(m.sumThuNhapTaiChinh).toHaveBeenCalledTimes(1);
    expect(choChuaSoCanh(el, CANH.lai).length).toBeGreaterThan(0);
  });
});
