import { endOfMonth, startOfMonth } from "date-fns";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { prisma } from "@/lib/prisma";
import { getVariantsForExport } from "@/lib/queries/variants";
import { computeProductReport } from "@/lib/reports/product-report";

import { seedReference, truncateBusinessTables } from "../helpers/test-db";

/**
 * Hai lỗ mà lưới "đầu ra sạch" (`che-gia-von-table-driven`) KHÔNG thấy được:
 *  - THỨ TỰ: file xuất tồn kho của người thiếu giá vốn phải sắp theo SKU — sắp theo giá vốn thì từng
 *    dòng không mang số nào mà thứ tự vẫn lộ ai đắt ai rẻ;
 *  - CÂU ĐỌC: nhánh che của báo cáo sản phẩm KHÔNG được đưa `Variant.costPrice` vào SELECT (spec §4.1
 *    "không select", không phải "đọc rồi bỏ") — đầu ra vẫn sạch nếu đọc rồi bỏ, nên phải soi tham số
 *    câu truy vấn.
 */

const now = new Date();
const thangNay = () => ({ from: startOfMonth(now), to: endOfMonth(now) });

beforeAll(async () => {
  await seedReference();
  await truncateBusinessTables();
  const product = await prisma.product.create({
    data: { pancakeId: "TT-P1", name: "Áo thứ tự", imageUrl: null, syncedAt: now },
  });
  // SKU tăng dần ↔ giá vốn TĂNG dần: sắp giá vốn GIẢM dần (nhánh đủ quyền) ra thứ tự ngược hẳn SKU.
  for (const [i, sku] of ["TT-A", "TT-B", "TT-C"].entries()) {
    await prisma.variant.create({
      data: {
        pancakeId: `TT-V${i}`,
        productId: product.id,
        sku,
        label: sku,
        sellPrice: 300_000,
        stock: 5,
        costPrice: 30_000 * (i + 1) + 1,
        syncedAt: now,
      },
    });
  }
  const v = await prisma.variant.findFirstOrThrow({ where: { sku: "TT-A" } });
  const order = await prisma.order.create({
    data: {
      pancakeId: "TT-ORD-1",
      code: "TT1",
      channelId: "shopee",
      status: "COMPLETED",
      orderedAt: now,
      itemsTotal: 300_000,
      platformFeeEst: 30_000,
      syncedAt: now,
    },
  });
  await prisma.orderItem.create({
    data: { orderId: order.id, variantId: v.id, sku: "TT-A", productName: "Áo thứ tự", quantity: 1, unitPrice: 300_000 },
  });
}, 60_000);

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await truncateBusinessTables();
  await prisma.$disconnect();
});

describe("xuất tồn kho — thứ tự dòng theo quyền giá vốn", () => {
  it("thiếu giá vốn ⇒ sắp theo SKU (không lộ thứ tự giá vốn)", async () => {
    const kq = await getVariantsForExport({}, { coQuyenGiaVon: false });
    expect(kq.rows.map((r) => r.sku)).toEqual(["TT-A", "TT-B", "TT-C"]);
  });

  it("đối chứng: đủ quyền ⇒ sắp theo giá vốn giảm dần (ngược SKU) — chứng minh dữ liệu dò phân biệt được hai thứ tự", async () => {
    const kq = await getVariantsForExport({}, { coQuyenGiaVon: true });
    expect(kq.rows.map((r) => r.sku)).toEqual(["TT-C", "TT-B", "TT-A"]);
  });
});

describe("báo cáo sản phẩm — nhánh che không SELECT giá vốn", () => {
  /** `select.items.select.variant.select.costPrice` của lời gọi `order.findMany` đầu tiên. */
  async function costPriceTrongSelect(coQuyenGiaVon: boolean): Promise<unknown> {
    const spy = vi.spyOn(prisma.order, "findMany");
    await computeProductReport(thangNay(), undefined, { coQuyenGiaVon });
    const arg = spy.mock.calls[0]?.[0] as {
      select: { items: { select: { variant: { select: Record<string, unknown> } } } };
    };
    return arg.select.items.select.variant.select.costPrice;
  }

  it("thiếu giá vốn ⇒ costPrice KHÔNG được chọn", async () => {
    expect(await costPriceTrongSelect(false)).not.toBe(true);
  });

  it("đối chứng: đủ quyền ⇒ costPrice được chọn (phép soi nhìn thấy tham số thật)", async () => {
    expect(await costPriceTrongSelect(true)).toBe(true);
  });
});
