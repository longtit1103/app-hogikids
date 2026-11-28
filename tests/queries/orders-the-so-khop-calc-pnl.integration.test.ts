import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { OrderStatus } from "@/generated/prisma/client";
import { parseDateRange } from "@/lib/date-range";
import type { BoLocDonHang, TongDonHang } from "@/lib/orders/don-hang-kieu-du-lieu";
import { khopBangLaiLo } from "@/lib/orders/khop-bang-lai-lo";
import { prisma } from "@/lib/prisma";
import { getTrangDonHang } from "@/lib/queries/orders-trang-don-hang";
import { calcPnl } from "@/lib/reports/pnl";

import { seedReference, truncateBusinessTables } from "../helpers/test-db";

/**
 * Lưới cố định cho câu "khớp bảng Lãi/Lỗ" dưới các thẻ số trang Đơn hàng: chạy `calcPnl` (nguồn chuẩn duy nhất
 * của Lãi/Lỗ) và `getTrangDonHang` trên CÙNG dữ liệu, CÙNG tháng trọn, rồi khẳng định từng đẳng thức mà chú
 * thích tuyên bố — bằng số cụ thể tính tay từ fixture (không lấy vế này làm kỳ vọng cho vế kia, để cả hai
 * cùng sai một kiểu cũng đỏ).
 *
 * Fixture tháng 10/2026 phủ: nhiều dòng hàng, giá vốn 0 (thiếu), đơn không dòng hàng, kênh direct/facebook,
 * đơn hoàn có phí sàn giữ, đơn hủy kênh không phí thật vẫn có `returnedFee`, và hai đơn sát biên tháng.
 */

const NOW = new Date(2026, 10, 27, 12, 0, 0);
const THANG_10 = parseDateRange({ tu: "2026-10-01", den: "2026-10-31" })!;
const DAY = { coQuyenGiaVon: true } as const;
const CHE = { coQuyenGiaVon: false } as const;
const HOP_LE: OrderStatus[] = ["PENDING", "SHIPPING", "COMPLETED"];
const HOAN_HUY: OrderStatus[] = ["RETURNED", "CANCELLED"];

type Seed = {
  ma: string;
  channelId: string;
  status: OrderStatus;
  orderedAt: Date;
  itemsTotal: number;
  discount?: number;
  platformFeeEst?: number;
  returnedFee?: number;
  dong?: { quantity: number; costPrice: number }[];
};

const okt = (ngay: number) => new Date(2026, 9, ngay, 10, 0, 0);

const DON: Seed[] = [
  // Lãi 300.000 − 10.000 − 60.000 − (2×50.000 + 30.000) = 100.000
  { ma: "K-A", channelId: "shopee", status: "COMPLETED", orderedAt: okt(2), itemsTotal: 300_000, discount: 10_000, platformFeeEst: 60_000,
    dong: [{ quantity: 2, costPrice: 50_000 }, { quantity: 1, costPrice: 30_000 }] },
  // Thiếu giá vốn (costPrice 0) ⇒ lãi 160.000
  { ma: "K-B", channelId: "tiktok", status: "SHIPPING", orderedAt: okt(3), itemsTotal: 200_000, platformFeeEst: 40_000,
    dong: [{ quantity: 1, costPrice: 0 }] },
  // Lỗ −75.000
  { ma: "K-C", channelId: "shopee", status: "PENDING", orderedAt: okt(4), itemsTotal: 150_000, discount: 5_000, platformFeeEst: 20_000,
    dong: [{ quantity: 1, costPrice: 200_000 }] },
  // Bán tại shop, không phí sàn ⇒ 50.000
  { ma: "K-D", channelId: "direct", status: "COMPLETED", orderedAt: okt(5), itemsTotal: 80_000, dong: [{ quantity: 1, costPrice: 30_000 }] },
  // Không dòng hàng ⇒ giá vốn 0, lãi 112.000
  { ma: "K-E", channelId: "facebook", status: "COMPLETED", orderedAt: okt(6), itemsTotal: 120_000, discount: 2_000, platformFeeEst: 6_000 },
  // Hoàn/hủy: chỉ phí sàn giữ đi vào Lãi/Lỗ (22.000 + 0 + 4.000 = 26.000)
  { ma: "K-R", channelId: "shopee", status: "RETURNED", orderedAt: okt(7), itemsTotal: 500_000, platformFeeEst: 90_000, returnedFee: 22_000,
    dong: [{ quantity: 1, costPrice: 100_000 }] },
  { ma: "K-X", channelId: "tiktok", status: "CANCELLED", orderedAt: okt(8), itemsTotal: 400_000, platformFeeEst: 50_000 },
  { ma: "K-Y", channelId: "facebook", status: "CANCELLED", orderedAt: okt(9), itemsTotal: 90_000, returnedFee: 4_000 },
  // Ngoài tháng (giờ VN): 30/09 23:30 và 01/11 00:10 — lọt vào là số vỡ to.
  { ma: "K-T9", channelId: "shopee", status: "COMPLETED", orderedAt: new Date(2026, 8, 30, 23, 30), itemsTotal: 1_000_000, platformFeeEst: 1 },
  { ma: "K-T11", channelId: "shopee", status: "RETURNED", orderedAt: new Date(2026, 10, 1, 0, 10), itemsTotal: 1_000_000, returnedFee: 99_000 },
];

/** Số tính tay từ fixture cho tháng 10 — vế kỳ vọng độc lập của cả `calcPnl` lẫn trang Đơn hàng. */
const TAY = {
  tienHang: 850_000,
  voucher: 17_000,
  phiSan: 126_000,
  thucNhan: 707_000,
  cogs: 360_000,
  lnGop: 347_000,
  phiSanHoanHuy: 26_000,
  soHopLe: 5,
  soHoanHuy: 3,
};

async function seed(): Promise<void> {
  const product = await prisma.product.create({ data: { pancakeId: "KCP-P", name: "SP", syncedAt: NOW } });
  let iv = 0;
  for (const d of DON) {
    const o = await prisma.order.create({
      data: {
        pancakeId: `KCP-${d.ma}`, code: d.ma, channelId: d.channelId, status: d.status, orderedAt: d.orderedAt,
        itemsTotal: d.itemsTotal, discount: d.discount ?? 0, platformFeeEst: d.platformFeeEst ?? 0,
        returnedFee: d.returnedFee ?? 0, syncedAt: NOW,
      },
    });
    for (const it of d.dong ?? []) {
      const sku = `KCP-SKU-${iv++}`;
      const v = await prisma.variant.create({
        data: { pancakeId: `KCP-V-${sku}`, productId: product.id, sku, label: sku, costPrice: it.costPrice, syncedAt: NOW },
      });
      await prisma.orderItem.create({
        data: { orderId: o.id, variantId: v.id, sku, productName: sku, quantity: it.quantity, unitPrice: d.itemsTotal },
      });
    }
  }
}

const boLoc = (statuses: OrderStatus[]): BoLocDonHang => ({
  ky: { loai: "khoang", ...THANG_10, nguon: "url" },
  statuses,
  channels: [],
  q: "",
  loc: [],
  sx: "moi",
  trang: 1,
  don: null,
});

async function tongDay(statuses: OrderStatus[]): Promise<TongDonHang> {
  const kq = await getTrangDonHang(boLoc(statuses), DAY, NOW);
  if (!kq.coQuyenGiaVon) throw new Error("phải đủ quyền giá vốn");
  return kq.tong;
}

beforeAll(async () => {
  await seedReference();
  await truncateBusinessTables();
  await seed();
}, 60_000);

afterAll(async () => {
  await truncateBusinessTables();
  await prisma.$disconnect();
});

describe("thẻ số trang Đơn hàng ↔ calcPnl, cùng fixture, cùng tháng trọn", () => {
  it("calcPnl ra đúng số tính tay (vế chuẩn không trôi theo trang Đơn hàng)", async () => {
    const pnl = await calcPnl(THANG_10);
    expect(pnl).toMatchObject({
      revenue: TAY.tienHang,
      voucher: TAY.voucher,
      platformFee: TAY.phiSan,
      netRevenue: TAY.thucNhan,
      cogs: TAY.cogs,
      grossProfit: TAY.lnGop,
      returnedOrderFee: TAY.phiSanHoanHuy,
      orderCount: TAY.soHopLe,
      returnBomOrderCount: TAY.soHoanHuy,
    });
  });

  it("lọc đúng đơn hợp lệ (khớp trọn): Tiền hàng − voucher = Doanh thu, phí sàn, Thực nhận, Lãi đơn = LN gộp", async () => {
    expect(khopBangLaiLo(boLoc(HOP_LE)).kieu).toBe("khop_tron");
    const [pnl, t] = await Promise.all([calcPnl(THANG_10), tongDay(HOP_LE)]);
    expect(t.tienHang - t.voucher).toBe(833_000);
    expect(t.tienHang - t.voucher).toBe(pnl.revenue - pnl.voucher);
    expect(t.phiSan).toBe(pnl.platformFee);
    expect(t.thucNhan).toBe(pnl.netRevenue);
    expect(t.lai).toBe(TAY.lnGop);
    expect(t.lai).toBe(pnl.grossProfit);
    expect(t.soDon).toBe(pnl.orderCount);
    expect(t.phiSanGiuHoanHuy).toBe(0);
  });

  it("màn mặc định mọi trạng thái: các số tiền vẫn khớp; Lãi đơn = LN gộp − Phí sàn đơn hoàn/hủy", async () => {
    expect(khopBangLaiLo(boLoc([])).kieu).toBe("khop_tru_phi_hoan_huy");
    const [pnl, t] = await Promise.all([calcPnl(THANG_10), tongDay([])]);
    expect(t.tienHang - t.voucher).toBe(pnl.revenue - pnl.voucher);
    expect(t.phiSan).toBe(pnl.platformFee);
    expect(t.thucNhan).toBe(pnl.netRevenue);
    expect(t.phiSanGiuHoanHuy).toBe(TAY.phiSanHoanHuy);
    expect(t.phiSanGiuHoanHuy).toBe(pnl.returnedOrderFee);
    expect(t.lai).toBe(321_000);
    expect(t.lai).toBe(pnl.grossProfit - pnl.returnedOrderFee);
    expect(t.soHopLe).toBe(pnl.orderCount);
    expect(t.soHoanHuy).toBe(pnl.returnBomOrderCount);
  });

  it("đường bấm 'Phí sàn đơn hoàn/hủy': tập hoàn/hủy ⇒ phí sàn đơn hoàn/hủy = dòng cùng tên, cả nhánh che", async () => {
    expect(khopBangLaiLo(boLoc(HOAN_HUY)).kieu).toBe("khop_phi_hoan_huy");
    const [pnl, day, che] = await Promise.all([
      calcPnl(THANG_10),
      tongDay(HOAN_HUY),
      getTrangDonHang(boLoc(HOAN_HUY), CHE, NOW),
    ]);
    expect(day.phiSanGiuHoanHuy).toBe(pnl.returnedOrderFee);
    expect(che.tong.phiSanGiuHoanHuy).toBe(TAY.phiSanHoanHuy);
    expect(day).toMatchObject({ tienHang: 0, phiSan: 0, thucNhan: 0, lai: -TAY.phiSanHoanHuy, soDon: TAY.soHoanHuy });
  });

  it("số đơn thiếu giá vốn của thẻ = số đơn hợp lệ có dòng giá vốn 0 (K-B)", async () => {
    expect((await tongDay([])).soDonThieuGiaVon).toBe(1);
  });
});
