import { Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";

export type VariantRow = {
  variantId: string;
  sku: string;
  productName: string;
  label: string;
  imageUrl: string | null;
  sellPrice: number;
  stock: number;
  costPrice: number;
  lowStockThreshold: number | null;
  effectiveThreshold: number;
  isLow: boolean;
  stockValue: number;
};

export type VariantListParams = {
  q?: string;
  missingCost?: boolean;
  /** Hẹp hơn `missingCost` — chỉ biến thể ĐÃ BÁN trong đơn hợp lệ. Xem `ProductListParams`. */
  soldMissingCost?: boolean;
  lowOnly?: boolean;
  sort?: "ton" | "von";
  dir?: "asc" | "desc";
  page: number;
};

export type VariantKpi = {
  totalSku: number;
  missingCost: number;
  totalStock: number;
  lowCount: number;
  stockValue: number;
  skusWithoutCostInValue: number;
};

const PAGE_SIZE = 20;

/** Ngưỡng cảnh báo mặc định (Setting.defaultLowStockThreshold; parse int, fallback 5). Dùng cho placeholder UI + biểu thức lọc. */
export async function getDefaultThreshold(): Promise<number> {
  const s = await prisma.setting.findUnique({ where: { key: "defaultLowStockThreshold" } });
  const n = Number.parseInt(s?.value ?? "", 10);
  return Number.isFinite(n) && n >= 0 ? n : 5;
}

/** WHERE lọc dùng chung (list + export). Ngưỡng so 2 cột nên PHẢI raw: `stock <= COALESCE(lowStockThreshold, d)`. */
function buildWhere(d: number, p: Pick<VariantListParams, "q" | "missingCost" | "soldMissingCost" | "lowOnly">): Prisma.Sql {
  const conds: Prisma.Sql[] = [];
  if (p.q && p.q.trim()) {
    const like = `%${p.q.trim()}%`;
    conds.push(Prisma.sql`(v.sku ILIKE ${like} OR p.name ILIKE ${like} OR v.label ILIKE ${like})`);
  }
  if (p.missingCost) conds.push(Prisma.sql`v."costPrice" = 0`);
  // Hẹp hơn `missingCost` — xem chú thích ở `ProductListParams.soldMissingCost` (products.ts):
  // chỉ biến thể ĐÃ BÁN trong đơn HỢP LỆ, tức tập nhập giá vốn vào là đổi số P&L thật.
  if (p.soldMissingCost) {
    conds.push(Prisma.sql`v."costPrice" = 0 AND EXISTS(
      SELECT 1 FROM "OrderItem" oi
      JOIN "Order" o ON o.id = oi."orderId"
      WHERE oi."variantId" = v.id AND o.status NOT IN ('RETURNED', 'CANCELLED')
    )`);
  }
  if (p.lowOnly) conds.push(Prisma.sql`v.stock <= COALESCE(v."lowStockThreshold", ${d})`);
  return conds.length ? Prisma.sql`WHERE ${Prisma.join(conds, " AND ")}` : Prisma.empty;
}

type RawVariant = {
  variantId: string;
  sku: string;
  productName: string;
  label: string;
  imageUrl: string | null;
  sellPrice: number;
  stock: number;
  costPrice: number;
  lowStockThreshold: number | null;
  effectiveThreshold: number;
  isLow: boolean;
  stockValue: bigint;
};

function selectExpr(d: number): Prisma.Sql {
  return Prisma.sql`
    v.id AS "variantId", v.sku, p.name AS "productName", v.label, p."imageUrl",
    v."sellPrice", v.stock, v."costPrice", v."lowStockThreshold",
    COALESCE(v."lowStockThreshold", ${d})::int AS "effectiveThreshold",
    (v.stock <= COALESCE(v."lowStockThreshold", ${d})) AS "isLow",
    (v.stock::bigint * v."costPrice") AS "stockValue"`;
}

function toRow(r: RawVariant): VariantRow {
  return {
    variantId: r.variantId,
    sku: r.sku,
    productName: r.productName,
    label: r.label,
    imageUrl: r.imageUrl,
    sellPrice: r.sellPrice,
    stock: r.stock,
    costPrice: r.costPrice,
    lowStockThreshold: r.lowStockThreshold,
    effectiveThreshold: r.effectiveThreshold,
    isLow: r.isLow,
    stockValue: Number(r.stockValue),
  };
}

/** Trang danh sách variant + KPI toàn cục (KPI KHÔNG theo filter — số tổng để card hiển thị ổn định). */
export async function getVariantListPage(
  p: VariantListParams,
): Promise<{ rows: VariantRow[]; total: number; kpi: VariantKpi }> {
  const d = await getDefaultThreshold();
  const where = buildWhere(d, p);
  const sortCol = p.sort === "ton" ? Prisma.sql`v.stock` : Prisma.sql`v."costPrice"`;
  const dir = p.dir === "asc" ? Prisma.sql`ASC` : Prisma.sql`DESC`;
  const offset = Math.max(0, (p.page - 1) * PAGE_SIZE);

  const rows = await prisma.$queryRaw<RawVariant[]>`
    SELECT ${selectExpr(d)}
    FROM "Variant" v JOIN "Product" p ON p.id = v."productId"
    ${where}
    ORDER BY ${sortCol} ${dir}, v.id ASC
    LIMIT ${PAGE_SIZE} OFFSET ${offset}`;

  // total từ COUNT ĐỘC LẬP (không dùng COUNT(*) OVER() — trang vượt trả 0 rows sẽ làm total sập về 0
  // dù còn dữ liệu ở trang 1, lệch với KPI).
  const totalRows = await prisma.$queryRaw<{ total: bigint }[]>`
    SELECT COUNT(*) AS total
    FROM "Variant" v JOIN "Product" p ON p.id = v."productId"
    ${where}`;
  const total = totalRows[0] ? Number(totalRows[0].total) : 0;

  const kpiRows = await prisma.$queryRaw<
    { totalSku: number; missingCost: number; totalStock: bigint; lowCount: number; stockValue: bigint; skusWithoutCostInValue: number }[]
  >`
    SELECT COUNT(*)::int AS "totalSku",
           COUNT(*) FILTER (WHERE v."costPrice" = 0)::int AS "missingCost",
           COALESCE(SUM(v.stock), 0)::bigint AS "totalStock",
           COUNT(*) FILTER (WHERE v.stock <= COALESCE(v."lowStockThreshold", ${d}))::int AS "lowCount",
           COALESCE(SUM(CASE WHEN v."costPrice" > 0 THEN v.stock::bigint * v."costPrice" ELSE 0 END), 0)::bigint AS "stockValue",
           COUNT(*) FILTER (WHERE v."costPrice" = 0 AND v.stock > 0)::int AS "skusWithoutCostInValue"
    FROM "Variant" v JOIN "Product" p ON p.id = v."productId"`;

  const k = kpiRows[0];
  return {
    rows: rows.map(toRow),
    total,
    kpi: {
      totalSku: k?.totalSku ?? 0,
      missingCost: k?.missingCost ?? 0,
      totalStock: k ? Number(k.totalStock) : 0,
      lowCount: k?.lowCount ?? 0,
      stockValue: k ? Number(k.stockValue) : 0,
      skusWithoutCostInValue: k?.skusWithoutCostInValue ?? 0,
    },
  };
}

/** Xuất (không phân trang) — dùng cho CSV/xlsx. */
export async function getVariantsForExport(
  p: Pick<VariantListParams, "q" | "lowOnly" | "missingCost" | "soldMissingCost">,
): Promise<VariantRow[]> {
  const d = await getDefaultThreshold();
  const where = buildWhere(d, p);
  const rows = await prisma.$queryRaw<RawVariant[]>`
    SELECT ${selectExpr(d)}
    FROM "Variant" v JOIN "Product" p ON p.id = v."productId"
    ${where}
    ORDER BY v."costPrice" DESC, v.id ASC`;
  return rows.map(toRow);
}

/** Số SKU thiếu giá vốn (costPrice = 0) — badge sidebar + KPI. */
export async function countMissingCostVariants(): Promise<number> {
  return prisma.variant.count({ where: { costPrice: 0 } });
}

export type LowStockPreviewRow = {
  variantId: string;
  sku: string;
  productName: string;
  label: string;
  stock: number;
};

/**
 * 5 biến thể tồn thấp nhất + tổng số đang cảnh báo — dùng cho Dashboard
 * `low-stock-card`. Dùng LẠI `buildWhere`/`selectExpr`/`toRow` (không viết lại
 * predicate ngưỡng SQL lần 2).
 */
export async function getLowStockPreview(limit = 5): Promise<{ rows: LowStockPreviewRow[]; total: number }> {
  const d = await getDefaultThreshold();
  const where = buildWhere(d, { lowOnly: true });
  const rows = await prisma.$queryRaw<RawVariant[]>`
    SELECT ${selectExpr(d)}
    FROM "Variant" v JOIN "Product" p ON p.id = v."productId"
    ${where}
    ORDER BY v.stock ASC, v.id ASC
    LIMIT ${limit}`;
  const totalRows = await prisma.$queryRaw<{ total: bigint }[]>`
    SELECT COUNT(*) AS total
    FROM "Variant" v JOIN "Product" p ON p.id = v."productId"
    ${where}`;
  return {
    rows: rows.map(toRow),
    total: totalRows[0] ? Number(totalRows[0].total) : 0,
  };
}

/** Có ≥1 SKU dưới ngưỡng cảnh báo (gồm hết hàng) — chấm warning sidebar Tồn kho. */
export async function hasLowStockVariants(): Promise<boolean> {
  const d = await getDefaultThreshold();
  const rows = await prisma.$queryRaw<{ exists: boolean }[]>`
    SELECT EXISTS(
      SELECT 1 FROM "Variant" v WHERE v.stock <= COALESCE(v."lowStockThreshold", ${d})
    ) AS "exists"`;
  return rows[0]?.exists ?? false;
}

/** Số dòng mỗi trang danh sách tồn kho — trang `/ton-kho` cần để kẹp `?trang=` vượt cuối. */
export { PAGE_SIZE as VARIANT_PAGE_SIZE };
