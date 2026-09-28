/**
 * Seed DATA MẪU MINH HOẠ cho PREVIEW (chỉ DB test hogikids_test) — để xem UI trang
 * /san-pham với đủ trạng thái: thiếu giá vốn (áp hàng loạt), giá đồng nhất, nhiều mức,
 * 1 biến thể, sắp hết/hết hàng. KHÔNG dùng cho prod. Idempotent (upsert theo pancakeId).
 *
 * Chạy: DATABASE_URL="<...hogikids_test...>" npx tsx scripts/seed-preview-products.ts
 * (guard từ chối nếu DATABASE_URL không trỏ DB *_test — tránh đụng data thật).
 */
import { PrismaClient } from "@prisma/client";

const dbUrl = process.env.DATABASE_URL ?? "";
const dbName = dbUrl.replace(/.*\/([^/?]+)(\?.*)?$/, "$1");
if (!/_test$/.test(dbName)) {
  console.error(`❌ DATABASE_URL trỏ DB "${dbName}" — không phải *_test. Từ chối seed để tránh đụng prod.`);
  process.exit(1);
}

const prisma = new PrismaClient();

type V = { sku: string; label: string; sellPrice: number; stock: number; costPrice: number };
type P = { pancakeId: string; name: string; categoryName: string; variants: V[] };

// 5 sản phẩm phủ mọi trạng thái UI của redesign:
const PRODUCTS: P[] = [
  {
    pancakeId: "PREVIEW-P1",
    name: "Set Bộ Baby Girl Cổ Bèo",
    categoryName: "Set bộ",
    // 5 biến thể, TẤT CẢ thiếu giá vốn (costPrice 0) → showcase "Áp giá vốn cho tất cả biến thể".
    variants: [90, 100, 110, 120, 130].map((s) => ({
      sku: `PV-SET-${s}`,
      label: `${s}/Hồng`,
      sellPrice: 350000,
      stock: 30,
      costPrice: 0,
    })),
  },
  {
    pancakeId: "PREVIEW-P2",
    name: "Váy Đầm Hoa Nhí",
    categoryName: "Váy đầm",
    // 4 biến thể, giá vốn ĐỒNG NHẤT 95.000 → ô cấp SP hiện đúng 1 giá.
    variants: [
      { sku: "PV-VAY-90V", label: "90/Vàng", sellPrice: 199000, stock: 12, costPrice: 95000 },
      { sku: "PV-VAY-100V", label: "100/Vàng", sellPrice: 199000, stock: 9, costPrice: 95000 },
      { sku: "PV-VAY-90X", label: "90/Xanh", sellPrice: 199000, stock: 15, costPrice: 95000 },
      { sku: "PV-VAY-100X", label: "100/Xanh", sellPrice: 199000, stock: 7, costPrice: 95000 },
    ],
  },
  {
    pancakeId: "PREVIEW-P3",
    name: "Áo Khoác Gió Bé Trai",
    categoryName: "Áo khoác",
    // Giá vốn LỆCH nhau → ô cấp SP hiện "Nhiều mức"; + 1 sắp hết, 1 hết hàng.
    variants: [
      { sku: "PV-AK-100", label: "100/Xám", sellPrice: 259000, stock: 3, costPrice: 80000 },
      { sku: "PV-AK-110", label: "110/Xám", sellPrice: 259000, stock: 0, costPrice: 85000 },
      { sku: "PV-AK-120", label: "120/Xám", sellPrice: 259000, stock: 8, costPrice: 0 },
    ],
  },
  {
    pancakeId: "PREVIEW-P4",
    name: "Nơ Cài Tóc Ren",
    categoryName: "Phụ kiện",
    // 1 biến thể → sửa giá vốn cấp SP KHÔNG bung confirm (áp thẳng).
    variants: [{ sku: "PV-NO-FS", label: "Freesize/Trắng", sellPrice: 39000, stock: 50, costPrice: 8000 }],
  },
  {
    pancakeId: "PREVIEW-P5",
    name: "Bộ Thun Cotton Gấu",
    categoryName: "Bộ thun",
    // Đồng nhất giá + tồn thấp/hết → badge "Sắp hết" / "Hết hàng" ở tổng tồn.
    variants: [
      { sku: "PV-BT-80", label: "80/Nâu", sellPrice: 175000, stock: 2, costPrice: 45000 },
      { sku: "PV-BT-90", label: "90/Nâu", sellPrice: 175000, stock: 0, costPrice: 45000 },
    ],
  },
];

async function main() {
  const now = new Date();
  for (const p of PRODUCTS) {
    const product = await prisma.product.upsert({
      where: { pancakeId: p.pancakeId },
      update: { name: p.name, categoryName: p.categoryName, syncedAt: now },
      create: { pancakeId: p.pancakeId, name: p.name, categoryName: p.categoryName, syncedAt: now },
    });
    for (const v of p.variants) {
      await prisma.variant.upsert({
        where: { pancakeId: `${p.pancakeId}-${v.sku}` },
        update: { sellPrice: v.sellPrice, stock: v.stock, syncedAt: now }, // KHÔNG đè costPrice khi update (app-owned)
        create: {
          pancakeId: `${p.pancakeId}-${v.sku}`,
          productId: product.id,
          sku: v.sku,
          label: v.label,
          sellPrice: v.sellPrice,
          stock: v.stock,
          costPrice: v.costPrice,
          syncedAt: now,
        },
      });
    }
  }
  const [products, variants] = await Promise.all([prisma.product.count(), prisma.variant.count()]);
  console.log(`✅ Seed preview xong: ${products} sản phẩm, ${variants} biến thể (DB ${dbName}).`);
}

main()
  .catch((e) => {
    console.error("Seed preview thất bại:", e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
