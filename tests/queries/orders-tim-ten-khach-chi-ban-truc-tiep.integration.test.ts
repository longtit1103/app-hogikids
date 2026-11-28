import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { parseDateRange } from "@/lib/date-range";
import type { BoLocDonHang } from "@/lib/orders/don-hang-kieu-du-lieu";
import { prisma } from "@/lib/prisma";
import { getDonKeBen } from "@/lib/queries/orders-don-ke-ben";
import { getTrangDonHang } from "@/lib/queries/orders-trang-don-hang";
import { getDonHangXuat } from "@/lib/queries/orders-xuat-don-hang";

import { seedReference, truncateBusinessTables } from "../helpers/test-db";

/**
 * Ô tìm của trang Đơn hàng chỉ so TÊN KHÁCH với đơn bán trực tiếp (kênh `direct`) — cùng phạm vi với chỗ
 * hiển thị tên khách. Nếu kênh sàn vẫn khớp theo tên thì gõ một cái tên là lọc ra được đơn sàn của người
 * đó dù màn hình đã ẩn tên (máy dò tên khách). Mã đơn / mã sàn / SKU / tên sản phẩm vẫn tìm ở mọi kênh.
 * Mọi nơi dùng chung điều kiện tìm (danh sách, thẻ số, đếm tab, đơn kề bên, Excel) phải cùng một tập.
 */

const NOW = new Date(2026, 10, 27, 12, 0, 0);
const THANG_10 = parseDateRange({ tu: "2026-10-01", den: "2026-10-31" })!;
const DAY = { coQuyenGiaVon: true } as const;
const CHE = { coQuyenGiaVon: false } as const;
const TEN = "Tran Thi Do Ten";

const boLoc = (p: Partial<BoLocDonHang> = {}): BoLocDonHang => ({
  ky: { loai: "khoang", ...THANG_10, nguon: "url" }, statuses: [], channels: [], q: "", loc: [], sx: "moi", trang: 1, don: null, ...p,
});

type Don = { ma: string; channelId: string; status: "COMPLETED" | "RETURNED"; customerName: string | null; ten: string };
const DON: Don[] = [
  { ma: "TK-SHOPEE", channelId: "shopee", status: "COMPLETED", customerName: TEN, ten: "Váy A" }, // chỉ khớp tên khách đơn sàn
  { ma: "TK-TIKTOK-HOAN", channelId: "tiktok", status: "RETURNED", customerName: TEN, ten: "Mũ B" }, // idem, đơn hoàn
  { ma: "TK-DIRECT", channelId: "direct", status: "COMPLETED", customerName: TEN, ten: "Khăn C" }, // bán tại shop
  { ma: "TK-SP", channelId: "shopee", status: "COMPLETED", customerName: "Người khác", ten: `Áo ${TEN}` }, // tên nằm trong tên SP
  { ma: "TK-KHAC", channelId: "shopee", status: "COMPLETED", customerName: "Người khác", ten: "Giày D" },
];
const MONG_DOI = ["TK-DIRECT", "TK-SP"];

const idTheoMa = new Map<string, string>();

beforeAll(async () => {
  await seedReference();
  await truncateBusinessTables();
  const product = await prisma.product.create({ data: { pancakeId: "TTK-P", name: "SP", syncedAt: NOW } });
  let i = 0;
  for (const d of DON) {
    const o = await prisma.order.create({
      data: {
        pancakeId: `TTK-${d.ma}`, code: d.ma, channelId: d.channelId, status: d.status,
        orderedAt: new Date(2026, 9, 1 + i, 10, 0, 0), itemsTotal: 100_000, platformFeeEst: d.channelId === "direct" ? 0 : 10_000,
        customerName: d.customerName, syncedAt: NOW,
      },
    });
    const v = await prisma.variant.create({
      data: { pancakeId: `TTK-V-${i}`, productId: product.id, sku: `TTK-SKU-${i}`, label: "v", costPrice: 40_000, syncedAt: NOW },
    });
    await prisma.orderItem.create({
      data: { orderId: o.id, variantId: v.id, sku: `TTK-SKU-${i}`, productName: d.ten, quantity: 1, unitPrice: 100_000 },
    });
    idTheoMa.set(d.ma, o.id);
    i++;
  }
}, 60_000);

afterAll(async () => {
  await truncateBusinessTables();
  await prisma.$disconnect();
});

const ma = (rows: { code: string }[]) => rows.map((r) => r.code).sort();

describe.each([
  ["có quyền giá vốn", DAY],
  ["che giá vốn", CHE],
] as const)("tìm theo tên khách — %s", (_nhan, quyen) => {
  it.each([TEN, TEN.toUpperCase(), TEN.toLowerCase()])(
    "q = %j ⇒ chỉ đơn bán trực tiếp + đơn có tên trong tên sản phẩm; thẻ số, đếm tab, đơn kề bên, Excel cùng tập",
    async (q) => {
      const kq = await getTrangDonHang(boLoc({ q }), quyen, NOW);
      expect(ma(kq.rows)).toEqual(MONG_DOI);
      expect(kq.tong.soDon).toBe(MONG_DOI.length);
      expect(Object.values(kq.demTheoTrangThai).reduce((s, n) => s + n, 0)).toBe(MONG_DOI.length);

      const keBen = await getDonKeBen(boLoc({ q }), idTheoMa.get("TK-DIRECT")!, quyen, NOW);
      expect(keBen.tong).toBe(MONG_DOI.length);

      const xuat = await getDonHangXuat(boLoc({ q }), quyen, NOW);
      expect(xuat.rows.length).toBe(MONG_DOI.length);
      expect(ma(xuat.rows)).toEqual(MONG_DOI);
    },
  );

  it("đơn sàn chỉ khớp theo tên khách không lọt vào đơn kề bên (vị trí null)", async () => {
    const keBen = await getDonKeBen(boLoc({ q: TEN }), idTheoMa.get("TK-SHOPEE")!, quyen, NOW);
    expect(keBen.viTri).toBeNull();
  });

  it("mã đơn vẫn tìm được ở kênh sàn (không chỉ riêng kênh direct)", async () => {
    const kq = await getTrangDonHang(boLoc({ q: "TK-SHOPEE" }), quyen, NOW);
    expect(ma(kq.rows)).toEqual(["TK-SHOPEE"]);
  });
});
