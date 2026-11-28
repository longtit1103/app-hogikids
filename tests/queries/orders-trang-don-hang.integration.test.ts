import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import type { OrderStatus, Prisma } from "@/generated/prisma/client";
import { parseDateRange } from "@/lib/date-range";
import type { BoLocDonHang } from "@/lib/orders/don-hang-kieu-du-lieu";
import { prisma } from "@/lib/prisma";
import { getOrderDetail } from "@/lib/queries/orders";
import { getTrangDonHang } from "@/lib/queries/orders-trang-don-hang";

import { seedReference, truncateBusinessTables } from "../helpers/test-db";

/**
 * Trang danh sách đơn mới: che giá vốn hai lớp (tập + thứ tự không đổi khi người thiếu quyền cố gõ chip/
 * sắp theo lãi), chip lọc, đếm tab bỏ qua chính bộ lọc trạng thái, tìm kiếm thoát ký tự đại diện, biên
 * kỳ giờ VN trên cột `timestamp` naive UTC, so kỳ trước, phân trang, và tên khách chỉ cho kênh `direct`.
 */

const NOW = new Date(2026, 10, 27, 12, 0, 0); // 27/11/2026 giờ VN
const THANG_10 = parseDateRange({ tu: "2026-10-01", den: "2026-10-31" })!;
const KY_10 = { loai: "khoang", ...THANG_10, nguon: "url" } as const;
const DAY = { coQuyenGiaVon: true } as const;
const CHE = { coQuyenGiaVon: false } as const;

type DonSeed = {
  ma: string;
  channelId: string;
  status: OrderStatus;
  orderedAt: Date;
  itemsTotal: number;
  platformFeeEst?: number;
  returnedFee?: number;
  customerName?: string;
  dong?: { sku: string; ten: string; costPrice: number | null }[]; // null = không khớp biến thể
};

const okt = (ngay: number, gio = 10) => new Date(2026, 9, ngay, gio, 0, 0);

const DON: DonSeed[] = [
  { ma: "DH-A", channelId: "shopee", status: "COMPLETED", orderedAt: okt(1), itemsTotal: 200_000, platformFeeEst: 50_000, customerName: "Khách A",
    dong: [{ sku: "SKU-A", ten: "tên sản phẩm A", costPrice: 120_000 }] }, // lãi 30.000
  { ma: "DH-B", channelId: "shopee", status: "PENDING", orderedAt: okt(2), itemsTotal: 150_000, platformFeeEst: 20_000,
    dong: [{ sku: "SKU-B", ten: "Váy B", costPrice: 0 }] }, // thiếu giá vốn
  { ma: "DH-C", channelId: "tiktok", status: "SHIPPING", orderedAt: okt(3), itemsTotal: 120_000, platformFeeEst: 15_000,
    dong: [{ sku: "SKU-C", ten: "Mũ C", costPrice: null }] }, // thiếu (không khớp biến thể)
  { ma: "DH-D", channelId: "shopee", status: "RETURNED", orderedAt: okt(4), itemsTotal: 300_000, platformFeeEst: 40_000, returnedFee: 12_000,
    dong: [{ sku: "SKU-D", ten: "Giày D", costPrice: 0 }] }, // −12.000, KHÔNG lỗ, KHÔNG thiếu
  { ma: "DH-E", channelId: "shopee", status: "CANCELLED", orderedAt: okt(5), itemsTotal: 80_000, platformFeeEst: 25_000 },
  { ma: "DH-H", channelId: "shopee", status: "COMPLETED", orderedAt: okt(6), itemsTotal: 100_000, platformFeeEst: 30_000,
    dong: [{ sku: "SKU-H", ten: "Bộ H", costPrice: 90_000 }] }, // lỗ −20.000
  { ma: "DH-P", channelId: "direct", status: "COMPLETED", orderedAt: okt(7), itemsTotal: 70_000, customerName: "Chị Lan",
    dong: [{ sku: "SKU-P", ten: "Khăn P", costPrice: 30_000 }] },
  { ma: "500", channelId: "website", status: "COMPLETED", orderedAt: okt(8), itemsTotal: 500_000, platformFeeEst: 5_000 },
  // Biên kỳ giờ VN: 31/10 23:30 VN = 16:30 UTC (vào tháng 10); 01/11 00:10 VN = 31/10 17:10 UTC (KHÔNG vào).
  { ma: "BIEN-TRONG", channelId: "shopee", status: "COMPLETED", orderedAt: new Date(2026, 9, 31, 23, 30, 0), itemsTotal: 10_000 },
  { ma: "BIEN-NGOAI", channelId: "shopee", status: "COMPLETED", orderedAt: new Date(2026, 10, 1, 0, 10, 0), itemsTotal: 10_000 },
  // Tháng 9 — kỳ so sánh của tháng 10.
  { ma: "T9-1", channelId: "shopee", status: "COMPLETED", orderedAt: new Date(2026, 8, 10, 10), itemsTotal: 60_000 },
  { ma: "T9-2", channelId: "tiktok", status: "COMPLETED", orderedAt: new Date(2026, 8, 20, 10), itemsTotal: 40_000 },
  { ma: "T9-3", channelId: "shopee", status: "RETURNED", orderedAt: new Date(2026, 8, 30, 23, 30), itemsTotal: 90_000, returnedFee: 3_000 },
];

const MA_THANG_10 = DON.filter((d) => d.orderedAt >= THANG_10.from && d.orderedAt <= THANG_10.to).map((d) => d.ma);

async function seedDon(list: DonSeed[]): Promise<void> {
  const product = await prisma.product.create({ data: { pancakeId: `TDH-P-${list.length}`, name: "SP", syncedAt: NOW } });
  let iv = 0;
  for (const d of list) {
    const o = await prisma.order.create({
      data: {
        pancakeId: `TDH-${d.ma}`, code: d.ma, channelId: d.channelId, status: d.status, orderedAt: d.orderedAt,
        itemsTotal: d.itemsTotal, platformFeeEst: d.platformFeeEst ?? 0, returnedFee: d.returnedFee ?? 0,
        customerName: d.customerName ?? null, syncedAt: NOW,
      },
    });
    for (const it of d.dong ?? []) {
      const variantId =
        it.costPrice === null
          ? null
          : (await prisma.variant.create({
              data: { pancakeId: `TDH-V-${d.ma}-${iv++}`, productId: product.id, sku: it.sku, label: it.sku, costPrice: it.costPrice, syncedAt: NOW },
            })).id;
      await prisma.orderItem.create({
        data: { orderId: o.id, variantId, sku: it.sku, productName: it.ten, quantity: 1, unitPrice: d.itemsTotal },
      });
    }
  }
}

const boLoc = (p: Partial<BoLocDonHang> = {}): BoLocDonHang => ({
  ky: KY_10, statuses: [], channels: [], q: "", loc: [], sx: "moi", trang: 1, don: null, ...p,
});
const ma = (rows: { code: string }[]) => rows.map((r) => r.code);

afterAll(async () => {
  await truncateBusinessTables();
  await prisma.$disconnect();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("bộ dữ liệu nhiều ca (tháng 9–11/2026)", () => {
  beforeAll(async () => {
    await seedReference();
    await truncateBusinessTables();
    await seedDon(DON);
  }, 60_000);

  describe("che giá vốn", () => {
    it("không quyền: không có trường lãi; chip/sắp theo lãi cố gõ vượt bộ đọc URL ⇒ tập + thứ tự y như không lọc", async () => {
      const goc = await getTrangDonHang(boLoc(), CHE, NOW);
      const coGo = await getTrangDonHang(boLoc({ loc: ["thieu_gv", "lo"], sx: "lai_thap" }), CHE, NOW);
      expect(goc.coQuyenGiaVon).toBe(false);
      expect("laiDon" in goc.rows[0]).toBe(false);
      expect("thieuGiaVon" in goc.rows[0]).toBe(false);
      expect("lai" in goc.tong).toBe(false);
      expect("laiHopLe" in goc.tong).toBe(false);
      expect("soDonThieuGiaVon" in goc.tong).toBe(false);
      // Phí sàn đơn hoàn/hủy không phải giá vốn ⇒ người thiếu quyền vẫn có (DH-D giữ 12.000).
      expect(goc.tong.phiSanGiuHoanHuy).toBe(12_000);
      expect(ma(coGo.rows)).toEqual(ma(goc.rows));
      expect(coGo.tong).toEqual(goc.tong);
      expect(coGo.demTheoTrangThai).toEqual(goc.demTheoTrangThai);
      expect(coGo.kyTruoc).toEqual(goc.kyTruoc);
      expect(coGo.kyTruoc && "lai" in coGo.kyTruoc.tong).toBe(false);
    });

    it("không quyền: câu SQL KHÔNG chạm bảng Variant/giá vốn (đối chứng: đủ quyền thì có)", async () => {
      const textCacCau = async (quyen: { coQuyenGiaVon: boolean }) => {
        const spy = vi.spyOn(prisma, "$queryRaw");
        await getTrangDonHang(boLoc(), quyen, NOW);
        const cau = spy.mock.calls.map((c) => (c[0] as Prisma.Sql).strings.join("?"));
        spy.mockRestore();
        return cau;
      };
      const che = await textCacCau(CHE);
      expect(che.length).toBeGreaterThan(0);
      for (const c of che) expect(c).not.toMatch(/Variant|costPrice/);
      const day = await textCacCau(DAY);
      expect(day.some((c) => /"Variant"/.test(c) && /costPrice/.test(c))).toBe(true);
    });
  });

  describe("chip + sắp xếp (đủ quyền)", () => {
    it("loc lo ⇒ chỉ H (đơn hoàn −12.000 không phải đơn lỗ)", async () => {
      expect(ma((await getTrangDonHang(boLoc({ loc: ["lo"] }), DAY, NOW)).rows)).toEqual(["DH-H"]);
    });

    it("loc thieu_gv ⇒ B, C (D hoàn có dòng giá vốn 0 KHÔNG tính)", async () => {
      expect(ma((await getTrangDonHang(boLoc({ loc: ["thieu_gv"] }), DAY, NOW)).rows).sort()).toEqual(["DH-B", "DH-C"]);
    });

    it("sx lai_thap ⇒ H đầu, A sau H; dãy lãi không giảm", async () => {
      const kq = await getTrangDonHang(boLoc({ sx: "lai_thap" }), DAY, NOW);
      if (!kq.coQuyenGiaVon) throw new Error("phải đủ quyền");
      const codes = ma(kq.rows);
      expect(codes[0]).toBe("DH-H");
      expect(codes.indexOf("DH-H")).toBeLessThan(codes.indexOf("DH-A"));
      const lai = kq.rows.map((r) => r.laiDon);
      expect(lai).toEqual([...lai].sort((a, b) => a - b));
    });

    it("sx tien_cao ⇒ tiền hàng giảm dần, hoà thì mới hơn trước", async () => {
      const kq = await getTrangDonHang(boLoc({ sx: "tien_cao" }), DAY, NOW);
      const mong = DON.filter((d) => MA_THANG_10.includes(d.ma))
        .sort((a, b) => b.itemsTotal - a.itemsTotal || b.orderedAt.getTime() - a.orderedAt.getTime())
        .map((d) => d.ma);
      expect(ma(kq.rows)).toEqual(mong);
    });
  });

  describe("đếm tab + thẻ", () => {
    it("thẻ đủ quyền đếm đơn thiếu giá vốn trong tập lọc (B, C); hoàn/hủy có dòng giá vốn 0 không tính", async () => {
      const kq = await getTrangDonHang(boLoc(), DAY, NOW);
      if (!kq.coQuyenGiaVon) throw new Error("phải đủ quyền");
      expect(kq.tong.soDonThieuGiaVon).toBe(2);
      const shopee = await getTrangDonHang(boLoc({ channels: ["shopee"] }), DAY, NOW);
      if (!shopee.coQuyenGiaVon) throw new Error("phải đủ quyền");
      expect(shopee.tong.soDonThieuGiaVon).toBe(1);
    });

    it("bật chip Phí tạm tính ⇒ không so kỳ trước (tạm tính phụ thuộc thời điểm xem)", async () => {
      expect((await getTrangDonHang(boLoc({ loc: ["phi_tam"] }), DAY, NOW)).kyTruoc).toBeNull();
      expect((await getTrangDonHang(boLoc({ loc: ["phi_tam"] }), CHE, NOW)).kyTruoc).toBeNull();
      expect((await getTrangDonHang(boLoc({ loc: ["lo"] }), DAY, NOW)).kyTruoc).not.toBeNull();
    });

    it("lọc COMPLETED: đếm tab vẫn đủ RETURNED/CANCELLED; thẻ chỉ đơn COMPLETED", async () => {
      const kq = await getTrangDonHang(boLoc({ statuses: ["COMPLETED"] }), DAY, NOW);
      expect(kq.demTheoTrangThai).toEqual({ PENDING: 1, SHIPPING: 1, COMPLETED: 5, RETURNED: 1, CANCELLED: 1 });
      expect(kq.tong.soDon).toBe(5);
      expect(ma(kq.rows).sort()).toEqual(["500", "BIEN-TRONG", "DH-A", "DH-H", "DH-P"]);
    });
  });

  describe("tìm kiếm", () => {
    it("theo SKU và theo tên sản phẩm", async () => {
      expect(ma((await getTrangDonHang(boLoc({ q: "SKU-A" }), DAY, NOW)).rows)).toEqual(["DH-A"]);
      expect(ma((await getTrangDonHang(boLoc({ q: "tên sản phẩm A" }), DAY, NOW)).rows)).toEqual(["DH-A"]);
    });

    it("'50%' KHÔNG khớp code '500' (thoát ký tự đại diện); '500' thì khớp", async () => {
      expect(ma((await getTrangDonHang(boLoc({ q: "50%" }), DAY, NOW)).rows)).toEqual([]);
      expect(ma((await getTrangDonHang(boLoc({ q: "500" }), DAY, NOW)).rows)).toEqual(["500"]);
    });
  });

  describe("biên kỳ + kỳ trước", () => {
    it("31/10 23:30 VN vào tháng 10; 01/11 00:10 VN không vào", async () => {
      const codes = ma((await getTrangDonHang(boLoc(), DAY, NOW)).rows);
      expect(codes).toContain("BIEN-TRONG");
      expect(codes).not.toContain("BIEN-NGOAI");
      expect(codes.sort()).toEqual([...MA_THANG_10].sort());
    });

    it("kỳ tháng 10 ⇒ so tháng 9 cùng bộ lọc; có q hoặc tất cả thời gian ⇒ không so", async () => {
      const kq = await getTrangDonHang(boLoc(), DAY, NOW);
      expect(kq.kyTruoc?.nhan).toBe("tháng trước đó");
      expect(kq.kyTruoc?.tong).toMatchObject({ soDon: 3, soHopLe: 2, soHoanHuy: 1, tienHang: 100_000, phiSanGiuHoanHuy: 3_000 });

      const theoKenh = await getTrangDonHang(boLoc({ channels: ["shopee"] }), DAY, NOW);
      expect(theoKenh.kyTruoc?.tong.soDon).toBe(2);

      expect((await getTrangDonHang(boLoc({ q: "DH" }), DAY, NOW)).kyTruoc).toBeNull();
      expect((await getTrangDonHang(boLoc({ ky: { loai: "tat_ca" } }), DAY, NOW)).kyTruoc).toBeNull();
    });
  });

  describe("tên khách", () => {
    it("chỉ kênh direct mang tên khách", async () => {
      const kq = await getTrangDonHang(boLoc(), DAY, NOW);
      const r = (m: string) => kq.rows.find((x) => x.code === m)!;
      expect(r("DH-A").tenKhach).toBeNull();
      expect(r("DH-P").tenKhach).toBe("Chị Lan");
      expect(r("DH-P").maSan).toBeNull();
      expect(r("DH-A").maSan).toBe("TDH-DH-A");
    });

    it("drawer (getOrderDetail) cũng chỉ trả tên khách cho kênh direct — payload đơn sàn không mang PII", async () => {
      const id = async (code: string) => (await prisma.order.findFirstOrThrow({ where: { code }, select: { id: true } })).id;
      for (const quyen of [DAY, CHE]) {
        const san = await getOrderDetail(await id("DH-A"), quyen);
        const taiShop = await getOrderDetail(await id("DH-P"), quyen);
        expect(san?.code).toBe("DH-A");
        expect(san?.customerName).toBeNull();
        expect(JSON.stringify(san)).not.toContain("Khách A");
        expect(taiShop?.customerName).toBe("Chị Lan");
      }
    });
  });
});

describe("phân trang (25 đơn)", () => {
  beforeAll(async () => {
    await truncateBusinessTables();
    await seedDon(
      Array.from({ length: 25 }, (_, i) => ({
        ma: `PT-${String(i).padStart(2, "0")}`, channelId: "shopee", status: "COMPLETED" as const,
        orderedAt: okt(1 + i), itemsTotal: 100_000 + i * 1_000, platformFeeEst: 20_000,
      })),
    );
  }, 60_000);

  it("trang 2 có 5 dòng cũ nhất; tổng + đếm giống trang 1", async () => {
    const [t1, t2] = await Promise.all([getTrangDonHang(boLoc(), DAY, NOW), getTrangDonHang(boLoc({ trang: 2 }), DAY, NOW)]);
    expect(t1.rows).toHaveLength(20);
    expect(ma(t2.rows)).toEqual(["PT-04", "PT-03", "PT-02", "PT-01", "PT-00"]);
    expect(t2.tong).toEqual(t1.tong);
    expect(t2.demTheoTrangThai).toEqual(t1.demTheoTrangThai);
    expect(t1.tong.soDon).toBe(25);
  });
});
