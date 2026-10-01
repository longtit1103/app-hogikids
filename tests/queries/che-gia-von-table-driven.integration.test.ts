import { endOfMonth, startOfMonth } from "date-fns";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { prisma } from "@/lib/prisma";
import { computeDailySeries } from "@/lib/reports/daily-series";
import { computeMonthlyTrend } from "@/lib/reports/monthly-trend";
import { calcPnl, computeChannelPnl } from "@/lib/reports/pnl";
import { channelPnlTheoQuyen, dailySeriesTheoQuyen, pnlTheoQuyen } from "@/lib/reports/pnl-che";
import { computeProductReport } from "@/lib/reports/product-report";
import type { QuyenGiaVon } from "@/lib/queries/che-gia-von-types";
import { getOrderDetail, getOrderListPage } from "@/lib/queries/orders";
import { getProductListPage } from "@/lib/queries/products";
import { getLowStockPreview, getVariantListPage, getVariantsForExport } from "@/lib/queries/variants";

import { seedReference, truncateBusinessTables } from "../helpers/test-db";

/**
 * CHE GIÁ VỐN TỪ SERVER — lưới table-driven qua MỌI hàm trả dữ liệu có trường nhạy cảm (spec phân
 * quyền §4.1, §8.3 tầng 1).
 *
 * Với `{ coQuyenGiaVon: false }`: quét SÂU kết quả (đệ quy object/array) ⇒ không key nào là trường
 * giá vốn/lợi nhuận, VÀ `JSON.stringify` không chứa giá vốn "độc" `7331117`. Với `true`: có ít nhất
 * một key nhạy cảm (đối chứng — chứng minh phép quét không mù) và, ở hàm đọc thẳng giá vốn, có chuỗi
 * độc. Sentinel CHỈ nằm ở `Variant.costPrice` — SKU/tên/giá bán/số lượng cố ý không chứa nó.
 */

const GIA_VON_DOC = 7331117;
const SENTINEL = String(GIA_VON_DOC);
const SKU = "SKU-DO-GIA-VON";

/** Tên trường cấm theo plan + khuôn chung (bắt cả trường mới đặt tên kiểu `...Cost`/`...Profit`). */
const KEY_CAM =
  /^(costPrice|stockValue|cogs|grossProfit|netProfit|margin|marginPct|profit|loiNhuan|giaVon|lineCogs|tongGiaTriTon)$|cost|profit|margin|cogs|stockvalue|giavon|loinhuan/i;

function keyNhayCam(x: unknown, duongDan = "$"): string[] {
  if (Array.isArray(x)) return x.flatMap((v, i) => keyNhayCam(v, `${duongDan}[${i}]`));
  if (x === null || typeof x !== "object" || x instanceof Date) return [];
  return Object.entries(x).flatMap(([k, v]) => [
    // `coQuyenGiaVon` là cờ phân biệt nhánh (boolean), không phải dữ liệu giá vốn.
    ...(k !== "coQuyenGiaVon" && KEY_CAM.test(k) ? [`${duongDan}.${k}`] : []),
    ...keyNhayCam(v, `${duongDan}.${k}`),
  ]);
}

let orderId = "";

type Ca = { ten: string; goi: (q: QuyenGiaVon) => Promise<unknown>; docThangGiaVon: boolean; coSku?: boolean };

const CAC_HAM: Ca[] = [
  { ten: "getVariantListPage", goi: (q) => getVariantListPage({ page: 1 }, q), docThangGiaVon: true, coSku: true },
  { ten: "getVariantsForExport", goi: (q) => getVariantsForExport({}, q), docThangGiaVon: true, coSku: true },
  { ten: "getProductListPage", goi: (q) => getProductListPage({ page: 1 }, q), docThangGiaVon: true, coSku: true },
  { ten: "getOrderDetail", goi: (q) => getOrderDetail(orderId, q), docThangGiaVon: true, coSku: true },
  { ten: "computeProductReport", goi: (q) => computeProductReport(thangNay(), undefined, q), docThangGiaVon: false, coSku: true },
  { ten: "computeMonthlyTrend", goi: (q) => computeMonthlyTrend(6, q), docThangGiaVon: false },
  // Dashboard / Kênh: công thức chạy đủ trong pnl.ts rồi chiếu DTO che (ngoại lệ chốt 30/09).
  { ten: "dashboard: calcPnl → pnlTheoQuyen", goi: async (q) => pnlTheoQuyen(await calcPnl(thangNay()), q), docThangGiaVon: false },
  {
    ten: "kênh: computeChannelPnl → channelPnlTheoQuyen",
    goi: async (q) => channelPnlTheoQuyen(await computeChannelPnl(thangNay()), q),
    docThangGiaVon: false,
  },
  {
    ten: "biểu đồ ngày: computeDailySeries → dailySeriesTheoQuyen",
    goi: async (q) => dailySeriesTheoQuyen(await computeDailySeries(thangNay()), q),
    docThangGiaVon: false,
  },
];

function thangNay() {
  const now = new Date();
  return { from: startOfMonth(now), to: endOfMonth(now) };
}

beforeAll(async () => {
  await seedReference();
  await truncateBusinessTables();
  const now = new Date();
  const product = await prisma.product.create({
    data: { pancakeId: "DO-P1", name: "Áo dò giá vốn", imageUrl: null, syncedAt: now },
  });
  const variant = await prisma.variant.create({
    data: {
      pancakeId: "DO-V1",
      productId: product.id,
      sku: SKU,
      label: "90/Đỏ",
      sellPrice: 250_000,
      stock: 3,
      costPrice: GIA_VON_DOC,
      syncedAt: now,
    },
  });
  const order = await prisma.order.create({
    data: {
      pancakeId: "DO-ORD-1",
      code: "DO1",
      channelId: "shopee",
      status: "COMPLETED",
      orderedAt: now,
      itemsTotal: 500_000,
      platformFeeEst: 50_000,
      syncedAt: now,
    },
  });
  orderId = order.id;
  await prisma.orderItem.create({
    data: { orderId, variantId: variant.id, sku: SKU, productName: "Áo dò giá vốn", quantity: 2, unitPrice: 250_000 },
  });
}, 60_000);

afterAll(async () => {
  await truncateBusinessTables();
  await prisma.$disconnect();
});

describe("che giá vốn — mọi hàm có tham số quyền", () => {
  it.each(CAC_HAM.map((c) => [c.ten, c] as const))("%s: thiếu quyền ⇒ không key nhạy cảm, không giá vốn độc", async (_ten, ca) => {
    const kq = await ca.goi({ coQuyenGiaVon: false });
    expect(kq, "hàm phải trả dữ liệu (lưới không được xanh vì rỗng)").toBeTruthy();
    expect((kq as { coQuyenGiaVon: boolean }).coQuyenGiaVon).toBe(false);
    expect(keyNhayCam(kq)).toEqual([]);
    const json = JSON.stringify(kq);
    // Có dữ liệu THẬT của đơn/biến thể dò — nhánh che không được xanh vì trả rỗng.
    if (ca.coSku) expect(json).toContain(SKU);
    else expect(json).toContain("500000"); // doanh thu đơn dò
    expect(json).not.toContain(SENTINEL);
  });

  it.each(CAC_HAM.map((c) => [c.ten, c] as const))("%s: đủ quyền ⇒ CÓ trường nhạy cảm (đối chứng phép dò)", async (_ten, ca) => {
    const kq = await ca.goi({ coQuyenGiaVon: true });
    expect((kq as { coQuyenGiaVon: boolean }).coQuyenGiaVon).toBe(true);
    expect(keyNhayCam(kq).length).toBeGreaterThan(0);
    if (ca.docThangGiaVon) expect(JSON.stringify(kq)).toContain(SENTINEL);
  });

  it("hàm KHÔNG nhận quyền (danh sách đơn, tồn thấp dashboard) không bao giờ mang trường nhạy cảm", async () => {
    for (const kq of [await getOrderListPage({ page: 1 }), await getLowStockPreview()]) {
      expect(keyNhayCam(kq)).toEqual([]);
      expect(JSON.stringify(kq)).not.toContain(SENTINEL);
    }
    expect(JSON.stringify(await getLowStockPreview())).toContain(SKU);
  });

  it("chính phép quét: bắt key lồng sâu trong mảng, bỏ qua key thường", () => {
    expect(keyNhayCam({ a: [{ b: { costPrice: 1 } }], revenue: 2 })).toEqual(["$.a[0].b.costPrice"]);
    expect(keyNhayCam({ hasMissingCost: true, uniformCost: 1 })).toHaveLength(2);
    expect(keyNhayCam({ revenue: 1, orderCount: 2, stock: 3, sku: "x" })).toEqual([]);
  });
});
