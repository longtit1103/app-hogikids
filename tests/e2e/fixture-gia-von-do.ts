import type { PrismaClient } from "@prisma/client";

/**
 * Dữ liệu "dò giá vốn" cho e2e che payload. Giá vốn `7331117` là con số DUY NHẤT trong DB e2e mang
 * chuỗi này — SKU, tên, số lượng, giá bán, mã đơn đều KHÔNG chứa nó. Nhờ vậy `7331117` xuất hiện
 * trong một phản hồi HTML/RSC/CSV thì chỉ có thể đến từ `Variant.costPrice` (hoặc số suy ra từ nó:
 * giá trị tồn, COGS…) — và người không có quyền giá vốn tuyệt đối không được thấy.
 *
 * Import TƯƠNG ĐỐI, nhận `PrismaClient` từ caller: dùng chung cho `global-setup.ts` (runner) và spec
 * (spec nào cần chắc dữ liệu còn đó gọi lại — `ingest.spec.ts` xoá sạch sản phẩm/đơn nên không thể chỉ
 * dựa vào lần seed ở setup).
 */
export const GIA_VON_DO = 7_331_117;
export const CHUOI_DO_GIA_VON = String(GIA_VON_DO);
export const SKU_DO_GIA_VON = "SKU-DO-GIA-VON";
export const TEN_SP_DO_GIA_VON = "Áo dò giá vốn";

const PANCAKE_SP = "E2E-DO-GIA-VON-SP";
const PANCAKE_BIEN_THE = "E2E-DO-GIA-VON-BT";
const PANCAKE_DON = "E2E-DO-GIA-VON-DON";

/** Idempotent: 1 sản phẩm + 1 biến thể giá vốn `7331117` + 1 đơn Shopee COMPLETED dùng SKU đó. */
export async function seedDoGiaVon(prisma: PrismaClient): Promise<void> {
  const bayGio = new Date();
  await prisma.$transaction(async (tx) => {
    const sp = await tx.product.upsert({
      where: { pancakeId: PANCAKE_SP },
      create: { pancakeId: PANCAKE_SP, name: TEN_SP_DO_GIA_VON, syncedAt: bayGio },
      update: { name: TEN_SP_DO_GIA_VON },
    });
    const bienThe = await tx.variant.upsert({
      where: { pancakeId: PANCAKE_BIEN_THE },
      create: {
        pancakeId: PANCAKE_BIEN_THE,
        productId: sp.id,
        sku: SKU_DO_GIA_VON,
        label: "Mặc định",
        sellPrice: 120_000,
        stock: 9,
        costPrice: GIA_VON_DO,
        syncedAt: bayGio,
      },
      update: { productId: sp.id, sku: SKU_DO_GIA_VON, sellPrice: 120_000, stock: 9, costPrice: GIA_VON_DO },
    });
    await tx.order.deleteMany({ where: { pancakeId: PANCAKE_DON } });
    await tx.order.create({
      data: {
        pancakeId: PANCAKE_DON,
        code: "DO-GIA-VON-01",
        channelId: "shopee",
        status: "COMPLETED",
        orderedAt: bayGio,
        itemsTotal: 240_000,
        syncedAt: bayGio,
        items: {
          create: {
            variantId: bienThe.id,
            sku: SKU_DO_GIA_VON,
            productName: TEN_SP_DO_GIA_VON,
            quantity: 2,
            unitPrice: 120_000,
          },
        },
      },
    });
  });
}
