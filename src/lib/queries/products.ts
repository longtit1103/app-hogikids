import { Prisma } from "@/generated/prisma/client";

import { prisma } from "@/lib/prisma";

import type { KetQuaChe, QuyenGiaVon } from "./che-gia-von-types";
import { getDefaultThreshold } from "./variants";

/**
 * Query danh sách sản phẩm GOM THEO PRODUCT (mỗi mẫu 1 dòng, biến thể là con) cho trang
 * `/san-pham` sau redesign 2026-07-17. Khác `variants.ts` (phẳng theo SKU): phân trang theo
 * SẢN PHẨM, KPI đếm theo sản phẩm. Vẫn dùng chung `getDefaultThreshold` + ngưỡng 2 cột raw SQL.
 *
 * Thiếu `gia-von-loi-nhuan:xem` (spec phân quyền §4.1): không select `costPrice`, không tính cờ/đếm
 * "thiếu giá vốn" (cờ đó là giá vốn = 0 nói bằng chữ), không tính giá trị tồn; hai bộ lọc theo giá
 * vốn bị bỏ qua.
 */

const PAGE_SIZE = 20;

/** Trường biến thể KHÔNG nhạy cảm — danh sách được phép (pick). */
export type ProductVariantRowChe = {
  variantId: string;
  sku: string;
  label: string;
  sellPrice: number;
  stock: number;
  lowStockThreshold: number | null;
  effectiveThreshold: number;
  isLow: boolean;
};

export type ProductVariantRow = ProductVariantRowChe & { costPrice: number };

/** Trường sản phẩm KHÔNG nhạy cảm — danh sách được phép (pick). */
export type ProductRowChe = {
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
  variants: ProductVariantRowChe[];
};

export type ProductRow = Omit<ProductRowChe, "variants"> & {
  hasMissingCost: boolean; // có ≥1 biến thể costPrice = 0
  /** Giá vốn chung nếu MỌI biến thể bằng nhau; null nếu lệch nhau (hiển thị ô cấp SP để trống). */
  uniformCost: number | null;
  variants: ProductVariantRow[];
};

export type ProductKpiChe = {
  totalProducts: number;
  totalVariants: number;
  lowStockProducts: number; // SP có ≥1 biến thể sắp hết/hết
};

export type ProductKpi = ProductKpiChe & {
  missingCostProducts: number; // SP có ≥1 biến thể thiếu giá vốn
  stockValue: number; // Σ tồn × giá vốn (bỏ biến thể costPrice = 0)
  productsWithoutCostInValue: number; // SP có biến thể costPrice=0 & tồn>0 (chú thích KPI giá trị tồn)
};

export type ProductListPage = KetQuaChe<
  { products: ProductRow[]; total: number; kpi: ProductKpi },
  { products: ProductRowChe[]; total: number; kpi: ProductKpiChe }
>;

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

/**
 * WHERE lọc ở CẤP SẢN PHẨM (EXISTS trên biến thể) — giữ toàn bộ biến thể trong aggregate. Thiếu quyền
 * giá vốn: bỏ hai bộ lọc theo giá vốn (kết quả lọc "thiếu giá vốn" chính là giá vốn = 0).
 */
function buildProductWhere(
  d: number,
  p: Pick<ProductListParams, "q" | "missingCost" | "soldMissingCost" | "lowOnly">,
  quyen: QuyenGiaVon,
): Prisma.Sql {
  const conds: Prisma.Sql[] = [];
  if (p.q && p.q.trim()) {
    const like = `%${p.q.trim()}%`;
    conds.push(Prisma.sql`(p.name ILIKE ${like} OR EXISTS(
      SELECT 1 FROM "Variant" vq WHERE vq."productId" = p.id AND (vq.sku ILIKE ${like} OR vq.label ILIKE ${like})
    ))`);
  }
  if (quyen.coQuyenGiaVon && p.missingCost) {
    conds.push(Prisma.sql`EXISTS(SELECT 1 FROM "Variant" vm WHERE vm."productId" = p.id AND vm."costPrice" = 0)`);
  }
  if (quyen.coQuyenGiaVon && p.soldMissingCost) {
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
  hasMissingCost?: boolean; // chỉ có ở nhánh đủ quyền
};

type RawVariantChe = ProductVariantRowChe & { productId: string };
type RawVariant = RawVariantChe & { costPrice: number };

function toVariantRowChe(r: RawVariantChe): ProductVariantRowChe {
  return {
    variantId: r.variantId,
    sku: r.sku,
    label: r.label,
    sellPrice: r.sellPrice,
    stock: r.stock,
    lowStockThreshold: r.lowStockThreshold,
    effectiveThreshold: r.effectiveThreshold,
    isLow: r.isLow,
  };
}

function toVariantRow(r: RawVariant): ProductVariantRow {
  return { ...toVariantRowChe(r), costPrice: r.costPrice };
}

/** Giá vốn chung của mẫu: mọi biến thể bằng nhau → giá đó; lệch nhau/không có biến thể → null. */
function computeUniformCost(variants: ProductVariantRow[]): number | null {
  if (variants.length === 0) return null;
  const first = variants[0].costPrice;
  return variants.every((v) => v.costPrice === first) ? first : null;
}

function toProductRowChe<V>(r: RawProduct, variants: V[]): Omit<ProductRowChe, "variants"> & { variants: V[] } {
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
    variants,
  };
}

/** Gom biến thể theo sản phẩm, giữ thứ tự ORDER BY của câu query. */
function gomTheoSanPham<R extends { productId: string }, V>(rows: R[], map: (r: R) => V): Map<string, V[]> {
  const theoSp = new Map<string, V[]>();
  for (const r of rows) {
    const arr = theoSp.get(r.productId) ?? [];
    arr.push(map(r));
    theoSp.set(r.productId, arr);
  }
  return theoSp;
}

/** Trang danh sách sản phẩm gom theo product + KPI toàn cục (KPI KHÔNG theo filter — số tổng ổn định). */
export async function getProductListPage(p: ProductListParams, quyen: QuyenGiaVon): Promise<ProductListPage> {
  const d = await getDefaultThreshold();
  const where = buildProductWhere(d, p, quyen);
  const offset = Math.max(0, (p.page - 1) * PAGE_SIZE);
  const cotThieuGiaVon = quyen.coQuyenGiaVon
    ? Prisma.sql`, COALESCE(BOOL_OR(v."costPrice" = 0), false) AS "hasMissingCost"`
    : Prisma.empty;

  const rawProducts = await prisma.$queryRaw<RawProduct[]>`
    SELECT p.id AS "productId", p.name, p."categoryName", p."imageUrl",
           COUNT(v.id)::int AS "variantCount",
           COALESCE(MIN(v."sellPrice"), 0)::int AS "sellPriceMin",
           COALESCE(MAX(v."sellPrice"), 0)::int AS "sellPriceMax",
           COALESCE(SUM(v.stock), 0)::int AS "totalStock",
           COALESCE(BOOL_OR(v.stock <= COALESCE(v."lowStockThreshold", ${d})), false) AS "isLow"
           ${cotThieuGiaVon}
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
  const cotBienThe = Prisma.sql`v.id AS "variantId", v."productId", v.sku, v.label, v."sellPrice", v.stock,
             v."lowStockThreshold",
             COALESCE(v."lowStockThreshold", ${d})::int AS "effectiveThreshold",
             (v.stock <= COALESCE(v."lowStockThreshold", ${d})) AS "isLow"`;

  if (!quyen.coQuyenGiaVon) {
    const rawVariants = ids.length
      ? await prisma.$queryRaw<RawVariantChe[]>`
          SELECT ${cotBienThe}
          FROM "Variant" v
          WHERE v."productId" IN (${Prisma.join(ids)})
          ORDER BY v."sellPrice" ASC, v.id ASC`
      : [];
    const theoSp = gomTheoSanPham(rawVariants, toVariantRowChe);
    const kpiRows = await prisma.$queryRaw<ProductKpiChe[]>`
      SELECT COUNT(DISTINCT p.id)::int AS "totalProducts",
             COUNT(v.id)::int AS "totalVariants",
             COUNT(DISTINCT p.id) FILTER (WHERE v.stock <= COALESCE(v."lowStockThreshold", ${d}))::int AS "lowStockProducts"
      FROM "Product" p LEFT JOIN "Variant" v ON v."productId" = p.id`;
    const k = kpiRows[0];
    return {
      coQuyenGiaVon: false,
      products: rawProducts.map((r) => toProductRowChe(r, theoSp.get(r.productId) ?? [])),
      total,
      kpi: {
        totalProducts: k?.totalProducts ?? 0,
        totalVariants: k?.totalVariants ?? 0,
        lowStockProducts: k?.lowStockProducts ?? 0,
      },
    };
  }

  const rawVariants = ids.length
    ? await prisma.$queryRaw<RawVariant[]>`
        SELECT ${cotBienThe}, v."costPrice"
        FROM "Variant" v
        WHERE v."productId" IN (${Prisma.join(ids)})
        ORDER BY v."sellPrice" ASC, v.id ASC`
    : [];
  const theoSp = gomTheoSanPham(rawVariants, toVariantRow);

  const products: ProductRow[] = rawProducts.map((r) => {
    const variants = theoSp.get(r.productId) ?? [];
    return {
      ...toProductRowChe(r, variants),
      hasMissingCost: r.hasMissingCost ?? false,
      uniformCost: computeUniformCost(variants),
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
    coQuyenGiaVon: true,
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
