import { Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";

import { getDefaultThreshold } from "./variants";

/**
 * Query danh sách sản phẩm GOM THEO PRODUCT (mỗi mẫu 1 dòng, biến thể là con) cho trang
 * `/san-pham` sau redesign 2026-07-17. Khác `variants.ts` (phẳng theo SKU): phân trang theo
 * SẢN PHẨM, KPI đếm theo sản phẩm. Vẫn dùng chung `getDefaultThreshold` + ngưỡng 2 cột raw SQL.
 */

const PAGE_SIZE = 20;

export type ProductVariantRow = {
  variantId: string;
  sku: string;
  label: string;
  sellPrice: number;
  stock: number;
  costPrice: number;
  lowStockThreshold: number | null;
  effectiveThreshold: number;
  isLow: boolean;
};

export type ProductRow = {
  productId: string;
  name: string;
  categoryName: string | null;
  imageUrl: string | null;
  variantCount: number;
  sellPriceMin: number;
  sellPriceMax: number;
  totalStock: number;
  isLow: boolean; // có ≥1 biến thể tồn ≤ ngưỡng (gồm hết hàng)
  isOutOfStock: boolean; // tổng tồn = 0
  hasMissingCost: boolean; // có ≥1 biến thể costPrice = 0
  /** Giá vốn chung nếu MỌI biến thể bằng nhau; null nếu lệch nhau (hiển thị ô cấp SP để trống). */
  uniformCost: number | null;
  variants: ProductVariantRow[];
};

export type ProductKpi = {
  totalProducts: number;
  totalVariants: number;
  missingCostProducts: number; // SP có ≥1 biến thể thiếu giá vốn
  lowStockProducts: number; // SP có ≥1 biến thể sắp hết/hết
  stockValue: number; // Σ tồn × giá vốn (bỏ biến thể costPrice = 0)
  productsWithoutCostInValue: number; // SP có biến thể costPrice=0 & tồn>0 (chú thích KPI giá trị tồn)
};

export type ProductListParams = {
  q?: string;
  missingCost?: boolean;
  /**
   * Hẹp hơn `missingCost`: chỉ sản phẩm có biến thể **đã bán trong đơn HỢP LỆ** mà giá vốn còn 0 —
   * tập DUY NHẤT mà nhập giá vốn làm đổi con số P&L. Biến thể chưa bán ngày nào nhập cũng không
   * đổi đồng nào, mà chúng chiếm gần hết bảng (đo prod 12/08: 1391 biến thể `costPrice=0`, chỉ 38
   * trong số đó từng bán) ⇒ lọc thường biến việc nhập giá vốn thành mò kim đáy bể.
   */
  soldMissingCost?: boolean;
  lowOnly?: boolean;
  page: number;
};

/**
 * "Đã bán" = có dòng hàng thuộc đơn HỢP LỆ. Định nghĩa đơn hợp lệ lấy ĐÚNG của `pnl.ts`
 * (status ∉ {RETURNED, CANCELLED}) để con số ở đây và cảnh báo thiếu giá vốn trên Dashboard không
 * bao giờ nói hai chuyện khác nhau. Viết dưới dạng `EXISTS` chứ không JOIN: một biến thể bán nhiều
 * lần vẫn chỉ tính một, và không làm phình aggregate của câu ngoài.
 */
function daBanTrongDonHopLe(cotVariantId: Prisma.Sql): Prisma.Sql {
  return Prisma.sql`EXISTS(
    SELECT 1 FROM "OrderItem" oi
    JOIN "Order" o ON o.id = oi."orderId"
    WHERE oi."variantId" = ${cotVariantId} AND o.status NOT IN ('RETURNED', 'CANCELLED')
  )`;
}

/** WHERE lọc ở CẤP SẢN PHẨM (EXISTS trên biến thể) — giữ toàn bộ biến thể trong aggregate. */
function buildProductWhere(
  d: number,
  p: Pick<ProductListParams, "q" | "missingCost" | "soldMissingCost" | "lowOnly">,
): Prisma.Sql {
  const conds: Prisma.Sql[] = [];
  if (p.q && p.q.trim()) {
    const like = `%${p.q.trim()}%`;
    conds.push(Prisma.sql`(p.name ILIKE ${like} OR EXISTS(
      SELECT 1 FROM "Variant" vq WHERE vq."productId" = p.id AND (vq.sku ILIKE ${like} OR vq.label ILIKE ${like})
    ))`);
  }
  if (p.missingCost) {
    conds.push(Prisma.sql`EXISTS(SELECT 1 FROM "Variant" vm WHERE vm."productId" = p.id AND vm."costPrice" = 0)`);
  }
  if (p.soldMissingCost) {
    conds.push(Prisma.sql`EXISTS(
      SELECT 1 FROM "Variant" vs
      WHERE vs."productId" = p.id AND vs."costPrice" = 0 AND ${daBanTrongDonHopLe(Prisma.sql`vs.id`)}
    )`);
  }
  if (p.lowOnly) {
    conds.push(
      Prisma.sql`EXISTS(SELECT 1 FROM "Variant" vl WHERE vl."productId" = p.id AND vl.stock <= COALESCE(vl."lowStockThreshold", ${d}))`,
    );
  }
  return conds.length ? Prisma.sql`WHERE ${Prisma.join(conds, " AND ")}` : Prisma.empty;
}

type RawProduct = {
  productId: string;
  name: string;
  categoryName: string | null;
  imageUrl: string | null;
  variantCount: number;
  sellPriceMin: number;
  sellPriceMax: number;
  totalStock: number;
  isLow: boolean;
  hasMissingCost: boolean;
};

type RawVariant = {
  variantId: string;
  productId: string;
  sku: string;
  label: string;
  sellPrice: number;
  stock: number;
  costPrice: number;
  lowStockThreshold: number | null;
  effectiveThreshold: number;
  isLow: boolean;
};

function toVariantRow(r: RawVariant): ProductVariantRow {
  return {
    variantId: r.variantId,
    sku: r.sku,
    label: r.label,
    sellPrice: r.sellPrice,
    stock: r.stock,
    costPrice: r.costPrice,
    lowStockThreshold: r.lowStockThreshold,
    effectiveThreshold: r.effectiveThreshold,
    isLow: r.isLow,
  };
}

/** Giá vốn chung của mẫu: mọi biến thể bằng nhau → giá đó; lệch nhau/không có biến thể → null. */
function computeUniformCost(variants: ProductVariantRow[]): number | null {
  if (variants.length === 0) return null;
  const first = variants[0].costPrice;
  return variants.every((v) => v.costPrice === first) ? first : null;
}

/** Trang danh sách sản phẩm gom theo product + KPI toàn cục (KPI KHÔNG theo filter — số tổng ổn định). */
export async function getProductListPage(
  p: ProductListParams,
): Promise<{ products: ProductRow[]; total: number; kpi: ProductKpi }> {
  const d = await getDefaultThreshold();
  const where = buildProductWhere(d, p);
  const offset = Math.max(0, (p.page - 1) * PAGE_SIZE);

  const rawProducts = await prisma.$queryRaw<RawProduct[]>`
    SELECT p.id AS "productId", p.name, p."categoryName", p."imageUrl",
           COUNT(v.id)::int AS "variantCount",
           COALESCE(MIN(v."sellPrice"), 0)::int AS "sellPriceMin",
           COALESCE(MAX(v."sellPrice"), 0)::int AS "sellPriceMax",
           COALESCE(SUM(v.stock), 0)::int AS "totalStock",
           COALESCE(BOOL_OR(v.stock <= COALESCE(v."lowStockThreshold", ${d})), false) AS "isLow",
           COALESCE(BOOL_OR(v."costPrice" = 0), false) AS "hasMissingCost"
    FROM "Product" p LEFT JOIN "Variant" v ON v."productId" = p.id
    ${where}
    GROUP BY p.id
    ORDER BY p.name ASC, p.id ASC
    LIMIT ${PAGE_SIZE} OFFSET ${offset}`;

  const totalRows = await prisma.$queryRaw<{ total: bigint }[]>`
    SELECT COUNT(*) AS total FROM "Product" p ${where}`;
  const total = totalRows[0] ? Number(totalRows[0].total) : 0;

  // Nạp toàn bộ biến thể của các sản phẩm trong trang (kể cả dòng thu gọn) — mở rộng tức thì, không fetch lại.
  const ids = rawProducts.map((r) => r.productId);
  const variantsByProduct = new Map<string, ProductVariantRow[]>();
  if (ids.length > 0) {
    const rawVariants = await prisma.$queryRaw<RawVariant[]>`
      SELECT v.id AS "variantId", v."productId", v.sku, v.label, v."sellPrice", v.stock, v."costPrice",
             v."lowStockThreshold",
             COALESCE(v."lowStockThreshold", ${d})::int AS "effectiveThreshold",
             (v.stock <= COALESCE(v."lowStockThreshold", ${d})) AS "isLow"
      FROM "Variant" v
      WHERE v."productId" IN (${Prisma.join(ids)})
      ORDER BY v."sellPrice" ASC, v.id ASC`;
    for (const rv of rawVariants) {
      const arr = variantsByProduct.get(rv.productId) ?? [];
      arr.push(toVariantRow(rv));
      variantsByProduct.set(rv.productId, arr);
    }
  }

  const products: ProductRow[] = rawProducts.map((r) => {
    const variants = variantsByProduct.get(r.productId) ?? [];
    return {
      productId: r.productId,
      name: r.name,
      categoryName: r.categoryName,
      imageUrl: r.imageUrl,
      variantCount: r.variantCount,
      sellPriceMin: r.sellPriceMin,
      sellPriceMax: r.sellPriceMax,
      totalStock: r.totalStock,
      isLow: r.isLow,
      isOutOfStock: r.totalStock === 0,
      hasMissingCost: r.hasMissingCost,
      uniformCost: computeUniformCost(variants),
      variants,
    };
  });

  const kpiRows = await prisma.$queryRaw<
    {
      totalProducts: number;
      totalVariants: number;
      missingCostProducts: number;
      lowStockProducts: number;
      stockValue: bigint;
      productsWithoutCostInValue: number;
    }[]
  >`
    SELECT COUNT(DISTINCT p.id)::int AS "totalProducts",
           COUNT(v.id)::int AS "totalVariants",
           COUNT(DISTINCT p.id) FILTER (WHERE v."costPrice" = 0)::int AS "missingCostProducts",
           COUNT(DISTINCT p.id) FILTER (WHERE v.stock <= COALESCE(v."lowStockThreshold", ${d}))::int AS "lowStockProducts",
           COALESCE(SUM(CASE WHEN v."costPrice" > 0 THEN v.stock::bigint * v."costPrice" ELSE 0 END), 0)::bigint AS "stockValue",
           COUNT(DISTINCT p.id) FILTER (WHERE v."costPrice" = 0 AND v.stock > 0)::int AS "productsWithoutCostInValue"
    FROM "Product" p LEFT JOIN "Variant" v ON v."productId" = p.id`;

  const k = kpiRows[0];
  return {
    products,
    total,
    kpi: {
      totalProducts: k?.totalProducts ?? 0,
      totalVariants: k?.totalVariants ?? 0,
      missingCostProducts: k?.missingCostProducts ?? 0,
      lowStockProducts: k?.lowStockProducts ?? 0,
      stockValue: k ? Number(k.stockValue) : 0,
      productsWithoutCostInValue: k?.productsWithoutCostInValue ?? 0,
    },
  };
}

export { PAGE_SIZE as PRODUCT_PAGE_SIZE };
