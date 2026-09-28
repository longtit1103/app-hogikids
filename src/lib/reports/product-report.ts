import { endOfDay } from "date-fns";

import { type DateRange } from "@/lib/date-range";
import { prisma } from "@/lib/prisma";

/**
 * Báo cáo theo SẢN PHẨM/SKU trong kỳ (bảng /bao-cao "Top sản phẩm", cột "Chậm
 * bán"). Chỉ đơn HỢP LỆ (status ∉ {RETURNED, CANCELLED}) — cùng bất biến pnl.ts.
 *
 * Doanh thu dòng = unitPrice × quantity − lineDiscount → Σ khớp Order.itemsTotal
 * (unitPrice = retail_price GỘP, lineDiscount = giảm giá dòng SHOP chịu — đã × quantity và
 * đã trừ phần sàn tài trợ, xem `src/lib/ingest/voucher-san-tai-tro.ts`). COGS/lãi
 * gộp dùng `Variant.costPrice` HIỆN HÀNH (không snapshot). `currentStock` mức
 * SẢN PHẨM = Σ stock TẤT CẢ biến thể của SP (kể cả chưa bán trong kỳ) — dùng
 * đúng cho sort "Chậm bán" (tồn cao, bán chậm). Dòng SKU con vẫn = tồn riêng
 * biến thể đó. Item không khớp variant (variantId null) gộp nhóm tổng hợp "SKU
 * không khớp", cogs 0 + stock 0, keyed theo productName.
 */

const UNMATCHED_PRODUCT_ID = "sku-khong-khop";
const UNMATCHED_PRODUCT_NAME = "SKU không khớp";

export interface ProductReportRow {
  productId: string;
  name: string;
  imageUrl: string | null;
  soldQty: number;
  revenue: number;
  cogs: number;
  grossProfit: number;
  marginPct: number | null;
  currentStock: number;
  orderCount: number;
  skus: Array<{
    variantId: string | null;
    sku: string;
    label: string;
    soldQty: number;
    revenue: number;
    cogs: number;
    grossProfit: number;
    currentStock: number;
  }>;
}

type SkuAgg = {
  variantId: string | null;
  sku: string;
  label: string;
  soldQty: number;
  revenue: number;
  cogs: number;
  currentStock: number;
};

type ProductAgg = {
  productId: string;
  name: string;
  imageUrl: string | null;
  orderIds: Set<string>;
  skus: Map<string, SkuAgg>; // key = variantId (khớp) | productName (không khớp)
};

export async function computeProductReport(
  range: DateRange,
  opts?: { channelId?: string; productId?: string }
): Promise<ProductReportRow[]> {
  const to = endOfDay(range.to);
  const orders = await prisma.order.findMany({
    where: {
      orderedAt: { gte: range.from, lte: to },
      status: { notIn: ["RETURNED", "CANCELLED"] },
      ...(opts?.channelId ? { channelId: opts.channelId } : {}),
    },
    select: {
      id: true,
      items: {
        select: {
          sku: true,
          productName: true,
          quantity: true,
          unitPrice: true,
          lineDiscount: true,
          variant: {
            select: {
              id: true,
              sku: true,
              label: true,
              costPrice: true,
              stock: true,
              product: { select: { id: true, name: true, imageUrl: true } },
            },
          },
        },
      },
    },
  });

  const products = new Map<string, ProductAgg>();

  for (const order of orders) {
    for (const it of order.items) {
      const lineRevenue = it.unitPrice * it.quantity - it.lineDiscount;

      // Xác định danh tính SP + SKU tùy item khớp variant hay không.
      const identity = it.variant
        ? {
            productId: it.variant.product.id,
            name: it.variant.product.name,
            imageUrl: it.variant.product.imageUrl,
            skuKey: it.variant.id,
            variantId: it.variant.id as string | null,
            sku: it.variant.sku,
            label: it.variant.label,
            lineCogs: it.quantity * it.variant.costPrice,
            stock: it.variant.stock,
          }
        : {
            productId: UNMATCHED_PRODUCT_ID,
            name: UNMATCHED_PRODUCT_NAME,
            imageUrl: null,
            skuKey: it.productName,
            variantId: null,
            sku: it.sku,
            label: it.productName,
            lineCogs: 0,
            stock: 0,
          };

      // Lọc theo 1 SP: sentinel "sku-khong-khop" không khớp cuid nào → nhóm không khớp tự loại.
      if (opts?.productId && identity.productId !== opts.productId) continue;

      let product = products.get(identity.productId);
      if (!product) {
        product = {
          productId: identity.productId,
          name: identity.name,
          imageUrl: identity.imageUrl,
          orderIds: new Set(),
          skus: new Map(),
        };
        products.set(identity.productId, product);
      }
      product.orderIds.add(order.id);

      let sku = product.skus.get(identity.skuKey);
      if (!sku) {
        sku = {
          variantId: identity.variantId,
          sku: identity.sku,
          label: identity.label,
          soldQty: 0,
          revenue: 0,
          cogs: 0,
          currentStock: identity.stock, // tồn biến thể là hằng — set 1 lần lúc tạo dòng SKU
        };
        product.skus.set(identity.skuKey, sku);
      }
      sku.soldQty += it.quantity;
      sku.revenue += lineRevenue;
      sku.cogs += identity.lineCogs;
    }
  }

  // currentStock mức SẢN PHẨM = Σ stock TẤT CẢ biến thể (không chỉ biến thể đã bán
  // trong kỳ) — Σ dòng SKU con sẽ thiếu biến thể chưa bán, làm sai list "Chậm bán"
  // (sort theo tồn desc). Sentinel "sku-khong-khop" không khớp productId thật nào
  // → groupBy bỏ qua, mặc định 0 (đúng ý: nhóm không khớp không có variant/stock).
  const productIds = [...products.keys()].filter((id) => id !== UNMATCHED_PRODUCT_ID);
  const stockSums = productIds.length
    ? await prisma.variant.groupBy({
        by: ["productId"],
        where: { productId: { in: productIds } },
        _sum: { stock: true },
      })
    : [];
  const stockByProduct = new Map(stockSums.map((s) => [s.productId, s._sum.stock ?? 0]));

  const rows: ProductReportRow[] = [...products.values()].map((p) => {
    const skus = [...p.skus.values()].sort((a, b) => b.revenue - a.revenue);
    const soldQty = skus.reduce((s, x) => s + x.soldQty, 0);
    const revenue = skus.reduce((s, x) => s + x.revenue, 0);
    const cogs = skus.reduce((s, x) => s + x.cogs, 0);
    const currentStock = stockByProduct.get(p.productId) ?? 0;
    const grossProfit = revenue - cogs;
    return {
      productId: p.productId,
      name: p.name,
      imageUrl: p.imageUrl,
      soldQty,
      revenue,
      cogs,
      grossProfit,
      marginPct: revenue ? (grossProfit / revenue) * 100 : null,
      currentStock,
      orderCount: p.orderIds.size,
      skus: skus.map((s) => ({
        variantId: s.variantId,
        sku: s.sku,
        label: s.label,
        soldQty: s.soldQty,
        revenue: s.revenue,
        cogs: s.cogs,
        grossProfit: s.revenue - s.cogs,
        currentStock: s.currentStock,
      })),
    };
  });

  return rows.sort((a, b) => b.revenue - a.revenue);
}
