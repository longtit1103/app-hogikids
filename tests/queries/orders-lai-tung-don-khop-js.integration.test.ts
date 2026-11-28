import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { OrderStatus } from "@/generated/prisma/client";
import { parseDateRange } from "@/lib/date-range";
import type { BoLocDonHang, DongDonHang } from "@/lib/orders/don-hang-kieu-du-lieu";
import { calcOrderCogs, calcOrderProfit } from "@/lib/orders/order-profit";
import { isProvisionalPlatformFee, returnedOrderFeeDisplay } from "@/lib/orders/provisional-fee";
import { prisma } from "@/lib/prisma";
import { getDonHangXuat } from "@/lib/queries/orders-xuat-don-hang";
import { getTrangDonHang } from "@/lib/queries/orders-trang-don-hang";

import { seedReference, truncateBusinessTables } from "../helpers/test-db";

/**
 * Lãi từng đơn tính ở DATABASE phải BẰNG công thức JS của drawer (`calcOrderProfit` + `calcOrderCogs`)
 * trên cùng dữ liệu — không có công thức lãi thứ hai. So TỪNG đơn, không so tổng (tổng khớp vẫn che
 * được hai đơn lệch bù nhau).
 *
 * Fixture cố ý phủ các ca SQL dễ lệch JS: giá vốn 0 vs không khớp biến thể (NULL sau LEFT JOIN), đơn
 * không dòng hàng (LATERAL rỗng), tích SL × giá vốn vượt int4, đơn hoàn/hủy = −returnedFee, và phí tạm
 * tính hai nhánh (hợp lệ theo tỉ lệ, hoàn/hủy theo tuổi đơn so với `now`).
 */

const NOW = new Date(2026, 10, 27, 12, 0, 0); // 27/11/2026 12:00 giờ VN
const NGAY = 86_400_000;
const THANG_10 = parseDateRange({ tu: "2026-10-01", den: "2026-10-31" })!;

type DongSeed = { sku: string; ten: string; quantity: number; unitPrice: number; costPrice: number | "khong-khop" };
type DonSeed = {
  ma: string;
  channelId: string;
  status: OrderStatus;
  orderedAt: Date;
  itemsTotal: number;
  discount?: number;
  platformFeeEst: number;
  returnedFee?: number;
  dong: DongSeed[];
};

const okt = (ngay: number) => new Date(2026, 9, ngay, 10, 0, 0);

/** A–H: kênh shopee, tháng 10 — tập dùng cho phép thử thẻ tổng. */
const DON_SHOPEE: DonSeed[] = [
  {
    ma: "A", channelId: "shopee", status: "COMPLETED", orderedAt: okt(1),
    itemsTotal: 200_000, discount: 10_000, platformFeeEst: 50_000,
    dong: [
      { sku: "SKU-A1", ten: "Áo A", quantity: 2, unitPrice: 60_000, costPrice: 40_000 },
      { sku: "SKU-A2", ten: "Quần A", quantity: 1, unitPrice: 80_000, costPrice: 30_000 },
    ],
  },
  {
    ma: "B", channelId: "shopee", status: "PENDING", orderedAt: okt(2),
    itemsTotal: 150_000, platformFeeEst: 20_000,
    dong: [{ sku: "SKU-B", ten: "Váy B", quantity: 1, unitPrice: 150_000, costPrice: 0 }],
  },
  {
    ma: "C", channelId: "shopee", status: "SHIPPING", orderedAt: okt(3),
    itemsTotal: 120_000, discount: 5_000, platformFeeEst: 15_000,
    dong: [{ sku: "SKU-C", ten: "Mũ C", quantity: 1, unitPrice: 120_000, costPrice: "khong-khop" }],
  },
  {
    // Dòng giá vốn 0 trên đơn HOÀN: không được tính là "thiếu giá vốn" (đơn không vào lãi).
    ma: "D", channelId: "shopee", status: "RETURNED", orderedAt: okt(4),
    itemsTotal: 300_000, discount: 20_000, platformFeeEst: 40_000, returnedFee: 12_000,
    dong: [{ sku: "SKU-D", ten: "Giày D", quantity: 1, unitPrice: 300_000, costPrice: 0 }],
  },
  {
    ma: "E", channelId: "shopee", status: "CANCELLED", orderedAt: okt(5),
    itemsTotal: 80_000, platformFeeEst: 25_000, returnedFee: 0,
    dong: [{ sku: "SKU-E", ten: "Tất E", quantity: 1, unitPrice: 80_000, costPrice: 20_000 }],
  },
  { ma: "F", channelId: "shopee", status: "COMPLETED", orderedAt: okt(6), itemsTotal: 50_000, platformFeeEst: 5_000, dong: [] },
  {
    // 1.000 × 3.000.000 = 3 tỷ > int4; 10 × phí 600 triệu cũng > int4.
    ma: "G", channelId: "shopee", status: "COMPLETED", orderedAt: okt(7),
    itemsTotal: 2_000_000_000, platformFeeEst: 600_000_000,
    dong: [{ sku: "SKU-G", ten: "Lô G", quantity: 1_000, unitPrice: 2_000_000, costPrice: 3_000_000 }],
  },
  {
    ma: "H", channelId: "shopee", status: "COMPLETED", orderedAt: okt(8),
    itemsTotal: 100_000, platformFeeEst: 30_000,
    dong: [{ sku: "SKU-H", ten: "Bộ H", quantity: 1, unitPrice: 100_000, costPrice: 90_000 }],
  },
];

/** Đơn dò "phí tạm tính" — kênh khác shopee để không lẫn vào thẻ tổng của A–H. */
const DON_PHI_TAM: DonSeed[] = [
  { ma: "T-HOP-LE-4", channelId: "tiktok", status: "COMPLETED", orderedAt: okt(9), itemsTotal: 100_000, platformFeeEst: 4_000, dong: [] },
  { ma: "T-HOAN-10N", channelId: "tiktok", status: "RETURNED", orderedAt: new Date(NOW.getTime() - 10 * NGAY), itemsTotal: 90_000, platformFeeEst: 30_000, returnedFee: 0, dong: [] },
  { ma: "T-HOAN-40N", channelId: "tiktok", status: "RETURNED", orderedAt: new Date(NOW.getTime() - 40 * NGAY), itemsTotal: 90_000, platformFeeEst: 30_000, returnedFee: 0, dong: [] },
  // Đúng 30 ngày: JS `ageDays <= 30` ⇒ còn tạm tính; SQL phải dùng `>=` mốc, không `>`.
  { ma: "T-HUY-30N", channelId: "tiktok", status: "CANCELLED", orderedAt: new Date(NOW.getTime() - 30 * NGAY), itemsTotal: 90_000, platformFeeEst: 30_000, returnedFee: 0, dong: [] },
  { ma: "T-HUY-DA-CHOT", channelId: "tiktok", status: "CANCELLED", orderedAt: new Date(NOW.getTime() - 10 * NGAY), itemsTotal: 90_000, platformFeeEst: 30_000, returnedFee: 5_000, dong: [] },
  { ma: "W-1PT", channelId: "website", status: "COMPLETED", orderedAt: okt(10), itemsTotal: 100_000, platformFeeEst: 1_000, dong: [] },
];

const TAT_CA = [...DON_SHOPEE, ...DON_PHI_TAM];

async function seedDon(list: DonSeed[]): Promise<void> {
  const product = await prisma.product.create({ data: { pancakeId: "LTD-P", name: "SP lãi đơn", syncedAt: NOW } });
  let iv = 0;
  for (const d of list) {
    const o = await prisma.order.create({
      data: {
        pancakeId: `LTD-${d.ma}`, code: d.ma, channelId: d.channelId, status: d.status, orderedAt: d.orderedAt,
        itemsTotal: d.itemsTotal, discount: d.discount ?? 0, platformFeeEst: d.platformFeeEst,
        returnedFee: d.returnedFee ?? 0, customerName: `Khách ${d.ma}`, syncedAt: NOW,
      },
    });
    for (const it of d.dong) {
      let variantId: string | null = null;
      if (it.costPrice !== "khong-khop") {
        const v = await prisma.variant.create({
          data: { pancakeId: `LTD-V${iv++}`, productId: product.id, sku: it.sku, label: it.sku, costPrice: it.costPrice, syncedAt: NOW },
        });
        variantId = v.id;
      }
      await prisma.orderItem.create({
        data: { orderId: o.id, variantId, sku: it.sku, productName: it.ten, quantity: it.quantity, unitPrice: it.unitPrice },
      });
    }
  }
}

/** Kết quả đối chứng tính bằng JS từ dữ liệu ĐỌC LẠI qua Prisma, dựng giá vốn y như `getOrderDetail`. */
async function doiChungJs() {
  const orders = await prisma.order.findMany({
    include: { items: { include: { variant: { select: { costPrice: true } } } } },
  });
  return new Map(
    orders.map((o) => {
      const { cogs, missingCostCount } = calcOrderCogs(
        o.items.map((it) => ({ quantity: it.quantity, costPrice: it.variantId ? (it.variant?.costPrice ?? null) : null })),
      );
      const hopLe = o.status !== "RETURNED" && o.status !== "CANCELLED";
      const hien = returnedOrderFeeDisplay(o, NOW);
      return [
        o.code,
        {
          laiDon: hopLe ? calcOrderProfit({ itemsTotal: o.itemsTotal, discount: o.discount, platformFeeEst: o.platformFeeEst, cogs }) : 0 - o.returnedFee, // "0 −" tránh −0 của JS khi returnedFee = 0
          giaVon: cogs,
          thieuGiaVon: hopLe && missingCostCount > 0,
          phiTamTinh: hien.show ? hien.provisional : isProvisionalPlatformFee(o),
        },
      ] as const;
    }),
  );
}

const boLoc = (p: Partial<BoLocDonHang> = {}): BoLocDonHang => ({
  ky: { loai: "tat_ca" }, statuses: [], channels: [], q: "", loc: [], sx: "moi", trang: 1, don: null, ...p,
});

const QUYEN = { coQuyenGiaVon: true } as const;

beforeAll(async () => {
  await seedReference();
  await truncateBusinessTables();
  await seedDon(TAT_CA);
}, 60_000);

afterAll(async () => {
  await truncateBusinessTables();
  await prisma.$disconnect();
});

describe("lãi từng đơn ở database = calcOrderProfit/calcOrderCogs", () => {
  it("mọi đơn fixture: laiDon, giá vốn, thiếu giá vốn, phí tạm tính khớp JS từng đơn", async () => {
    const kq = await getDonHangXuat(boLoc(), QUYEN, NOW);
    if (!kq.coQuyenGiaVon) throw new Error("phải là nhánh đủ quyền");
    expect(kq.vuotTran).toBe(false);
    expect(kq.rows).toHaveLength(TAT_CA.length);

    const js = await doiChungJs();
    for (const r of kq.rows) {
      const mong = js.get(r.code)!;
      expect({ code: r.code, laiDon: r.laiDon, giaVon: r.giaVon, thieuGiaVon: r.thieuGiaVon, phiTamTinh: r.phiTamTinh }).toEqual({
        code: r.code,
        ...mong,
      });
    }
  });

  it("giá trị tường minh từng ca", async () => {
    const kq = await getDonHangXuat(boLoc(), QUYEN, NOW);
    if (!kq.coQuyenGiaVon) throw new Error("phải là nhánh đủ quyền");
    const theoMa = new Map(kq.rows.map((r) => [r.code, r]));
    const r = (ma: string) => theoMa.get(ma)!;

    expect([r("A").laiDon, r("A").thieuGiaVon, r("A").giaVon]).toEqual([30_000, false, 110_000]);
    expect([r("B").laiDon, r("B").thieuGiaVon, r("B").giaVon]).toEqual([130_000, true, 0]);
    expect([r("C").laiDon, r("C").thieuGiaVon]).toEqual([100_000, true]);
    expect([r("D").laiDon, r("D").thieuGiaVon]).toEqual([-12_000, false]);
    expect([r("E").laiDon, r("E").thieuGiaVon]).toEqual([0, false]);
    expect([r("F").laiDon, r("F").thieuGiaVon, r("F").sanPhamDau, r("F").soDongHang, r("F").tongSoLuong]).toEqual([45_000, false, null, 0, 0]);
    expect([r("G").giaVon, r("G").laiDon]).toEqual([3_000_000_000, 2_000_000_000 - 600_000_000 - 3_000_000_000]);
    expect(r("H").laiDon).toBe(-20_000);

    // Sản phẩm đầu = dòng có `OrderItem.id` nhỏ nhất; đếm dòng + tổng SL.
    expect([r("A").soDongHang, r("A").tongSoLuong]).toEqual([2, 3]);
    expect(["Áo A", "Quần A"]).toContain(r("A").sanPhamDau?.ten);

    expect(r("T-HOP-LE-4").phiTamTinh).toBe(true);
    expect(r("T-HOAN-10N").phiTamTinh).toBe(true);
    expect(r("T-HOAN-40N").phiTamTinh).toBe(false);
    expect(r("T-HUY-30N").phiTamTinh).toBe(true);
    expect(r("T-HUY-DA-CHOT").phiTamTinh).toBe(false);
    expect(r("W-1PT").phiTamTinh).toBe(false);
  });

  it("danh sách trang trả cùng laiDon như bản xuất (một bộ dựng SQL)", async () => {
    const [trang, xuat] = await Promise.all([getTrangDonHang(boLoc(), QUYEN, NOW), getDonHangXuat(boLoc(), QUYEN, NOW)]);
    if (!trang.coQuyenGiaVon || !xuat.coQuyenGiaVon) throw new Error("phải là nhánh đủ quyền");
    const laiXuat = new Map(xuat.rows.map((r) => [r.id, r.laiDon]));
    expect(trang.rows.length).toBeGreaterThan(0);
    for (const r of trang.rows as DongDonHang[]) expect(r.laiDon).toBe(laiXuat.get(r.id));
  });
});

describe("thẻ tổng trên A–H (shopee, tháng 10)", () => {
  it("Tiền hàng/Thực nhận chỉ đơn hợp lệ; Lãi = Σ lãi hợp lệ − phí sàn giữ đơn hoàn/hủy đúng một lần", async () => {
    const kq = await getTrangDonHang(boLoc({ ky: { loai: "khoang", ...THANG_10, nguon: "url" }, channels: ["shopee"] }), QUYEN, NOW);
    if (!kq.coQuyenGiaVon) throw new Error("phải là nhánh đủ quyền");

    const js = await doiChungJs();
    const hopLe = DON_SHOPEE.filter((d) => d.status !== "RETURNED" && d.status !== "CANCELLED");
    const sum = (xs: number[]) => xs.reduce((s, x) => s + x, 0);
    const tienHang = sum(hopLe.map((d) => d.itemsTotal));
    const voucher = sum(hopLe.map((d) => d.discount ?? 0));
    const phiSan = sum(hopLe.map((d) => d.platformFeeEst));
    const laiHopLe = sum(hopLe.map((d) => js.get(d.ma)!.laiDon));

    expect(kq.tong).toEqual({
      soDon: 8,
      soHopLe: 6,
      soHoanHuy: 2,
      tienHang,
      voucher,
      phiSan,
      thucNhan: tienHang - voucher - phiSan,
      phiSanGiuHoanHuy: 12_000,
      laiHopLe,
      lai: laiHopLe - 12_000,
      soDonThieuGiaVon: DON_SHOPEE.filter((d) => js.get(d.ma)!.thieuGiaVon).length,
    });
    expect(kq.tong.soDonThieuGiaVon).toBeGreaterThan(0);
    // Số tường minh: D (300.000 tiền hàng, 40.000 phí tạm) KHÔNG được lọt vào thẻ.
    expect(kq.tong.tienHang).toBe(2_000_620_000);
    expect(kq.tong.phiSan).toBe(600_120_000);
    expect(kq.tong.lai).toBe(-1_599_727_000);
  });
});
