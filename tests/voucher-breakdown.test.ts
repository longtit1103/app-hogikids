import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { mapPancakeOrder } from "@/lib/ingest/pancake-mapping";
import { pancakeOrderSchema } from "@/lib/ingest/pancake-schemas";
import { upsertOneOrder, type UpsertStats } from "@/lib/ingest/pancake-upsert";
import { prisma } from "@/lib/prisma";
import { calcPnl } from "@/lib/reports/pnl";
import { computeVoucherBreakdown } from "@/lib/reports/voucher-breakdown";
import { seedReference, truncateBusinessTables } from "./helpers/test-db";

/**
 * Ba thành phần giảm giá cho khách (`hogikids_test`).
 *
 * Bất biến kiểm: `shopLineLevel + marketplaceFunded = Σ quantity ×
 * discount_each_product` — đúng cách `pancake-mapping.ts` tách phần shop chịu
 * khỏi phần sàn tài trợ. Lệch đẳng thức này nghĩa là con số "shop giảm bao
 * nhiêu" đang sai, mà đó chính là số chủ shop dùng để quyết định còn giảm nữa
 * hay thôi.
 */

const RANGE = { from: new Date(2026, 5, 1), to: new Date(2026, 5, 30) };
const IN_RANGE = new Date(2026, 5, 15);

beforeAll(async () => {
  await seedReference();
}, 60_000);

beforeEach(async () => {
  await truncateBusinessTables();
});

afterAll(async () => {
  await prisma.$disconnect();
});

/**
 * Dựng đơn ĐÚNG như mapping đã lưu: `itemsTotal = Σ qty×unitPrice − Σ lineDiscount`,
 * `lineDiscount` = phần SHOP CHỊU (thô − voucher sàn đã áp). Breakdown đọc HIỆU
 * `Σ qty×discount_each_product (raw) − Σ lineDiscount (Silver)` — KHÔNG đọc
 * `advanced_platform_fee.marketplace_voucher` nữa, nên helper cố ý không nhận
 * field đó (nhận là gây ảo giác nó còn được kiểm). Luật kẹp/suy của mapping được
 * kiểm bằng các ca ĐI ĐƯỜNG THẬT `mapPancakeOrder → upsertOneOrder` bên dưới.
 */
async function taoDon(opts: {
  id: string;
  status?: "COMPLETED" | "RETURNED";
  orderedAt?: Date;
  channelId?: string;
  discountMucDon?: number;
  items: { qty: number | string; unitPrice: number; discountEachProduct: number | string; lineDiscount: number }[];
}): Promise<void> {
  const itemsTotal = opts.items.reduce((s, it) => s + Number(it.qty) * it.unitPrice - it.lineDiscount, 0);
  await prisma.order.create({
    data: {
      pancakeId: opts.id,
      code: opts.id,
      channelId: opts.channelId ?? "tiktok",
      status: opts.status ?? "COMPLETED",
      orderedAt: opts.orderedAt ?? IN_RANGE,
      syncedAt: IN_RANGE,
      itemsTotal,
      discount: opts.discountMucDon ?? 0,
      platformFeeEst: 0,
      raw: {
        items: opts.items.map((it) => ({
          quantity: it.qty,
          discount_each_product: it.discountEachProduct,
        })),
      },
      items: {
        create: opts.items.map((it, i) => ({
          sku: `SKU-${opts.id}-${i}`,
          productName: "SP",
          // Silver luôn là số thật (schema coerce) — chỉ `raw` ở trên mới giữ nguyên kiểu chuỗi.
          quantity: Number(it.qty),
          unitPrice: it.unitPrice,
          lineDiscount: it.lineDiscount,
        })),
      },
    },
  });
}

/** Ingest THẬT một payload Pancake vào Silver — cùng đường với sync/webhook. */
async function ingestThat(payload: unknown): Promise<void> {
  const raw = pancakeOrderSchema.parse(payload);
  const mo = mapPancakeOrder(raw, { channels: { tiktok: { platformFeePct: 0, paymentFeePct: 0 } } });
  const stats: UpsertStats = {
    productsUpserted: 0, variantsUpserted: 0, ordersUpserted: 0, ordersSkippedMirror: 0,
    ordersSkippedStale: 0, ordersDiscardedGiuaChung: 0, skipped: 0, boQuaCoChuDich: 0, unknownStatusOrders: 0,
    settlementsUpserted: 0, adsUpserted: 0, paymentsUpserted: 0, shopeeUpserted: 0, adsExpensesUpserted: 0,
  };
  await upsertOneOrder(mo, raw, stats, []);
}

describe("computeVoucherBreakdown", () => {
  it("tách đúng phần shop chịu và phần sàn tài trợ của đơn thật", async () => {
    // Đơn 583601650514297876: giá 400.000, giảm giá dòng thô 70.000, Silver lưu shop chịu 50.000
    // ⇒ hiệu 20.000 là phần sàn tài trợ, doanh thu ghi nhận 350.000.
    await taoDon({
      id: "V-THAT",
      items: [{ qty: 1, unitPrice: 400_000, discountEachProduct: 70_000, lineDiscount: 50_000 }],
    });

    expect(await computeVoucherBreakdown(RANGE)).toEqual({
      shopLineLevel: 50_000,
      marketplaceFunded: 20_000,
    });
  });

  it("giảm giá dòng nhân SỐ LƯỢNG (không phải mỗi đơn vị)", async () => {
    await taoDon({
      id: "V-QTY",
      items: [{ qty: 3, unitPrice: 100_000, discountEachProduct: 10_000, lineDiscount: 24_000 }],
    });

    const v = await computeVoucherBreakdown(RANGE);
    // Σ qty×dep = 30.000 = 24.000 shop + 6.000 sàn (không phải 10.000)
    expect(v.shopLineLevel + v.marketplaceFunded).toBe(30_000);
    expect(v.marketplaceFunded).toBe(6_000);
  });

  it("Pancake khai voucher sàn VƯỢT Σ giảm giá dòng → khớp luật kẹp của mapping (đường thật)", async () => {
    // Đi trọn đường mapping → upsert → breakdown: mapping kẹp 99.000 về 30.000 và ghi lineDiscount
    // 0; breakdown lấy hiệu theo TỪNG ĐƠN nên tự ra đúng 30.000. Đơn thường bên cạnh (shop chịu
    // trọn 40.000) chứng minh phần vượt không tràn sang đơn khác — kẹp trên tổng kỳ sẽ ra 70.000.
    await ingestThat({
      id: "V-VUOT-THAT",
      status: 3,
      inserted_at: "2026-06-15T04:00:00.000000",
      order_sources_name: "Tiktok",
      marketplace_id: "-9",
      total_price: 200_000,
      total_discount: 0,
      fee_marketplace: 20_000,
      advanced_platform_fee: { marketplace_voucher: 99_000 },
      items: [
        { quantity: 1, variation_id: "v-vt", discount_each_product: 30_000, variation_info: { display_id: "SKU-VT", name: "SP", retail_price: 200_000 } },
      ],
    });
    await taoDon({
      id: "V-THUONG",
      items: [{ qty: 1, unitPrice: 200_000, discountEachProduct: 40_000, lineDiscount: 40_000 }],
    });

    expect((await computeVoucherBreakdown(RANGE)).marketplaceFunded).toBe(30_000);
  });

  it("dòng 'Voucher' của P&L độc lập với hai khoản này (không đếm chồng)", async () => {
    await taoDon({
      id: "V-CA-HAI",
      discountMucDon: 15_000,
      items: [{ qty: 2, unitPrice: 100_000, discountEachProduct: 20_000, lineDiscount: 32_000 }],
    });

    const [pnl, v] = await Promise.all([calcPnl(RANGE), computeVoucherBreakdown(RANGE)]);
    expect(pnl.voucher).toBe(15_000); // voucher mức đơn — KHÔNG gồm 32.000 lẫn 8.000
    expect(v).toEqual({ shopLineLevel: 32_000, marketplaceFunded: 8_000 });
    // Doanh thu gộp đã trừ sẵn phần shop chịu trên từng SP, không trừ phần sàn.
    expect(pnl.revenue).toBe(2 * 100_000 - 32_000);
  });

  it("loại đơn hoàn/hủy và đơn ngoài kỳ — khớp tập đơn của calcPnl", async () => {
    await taoDon({
      id: "V-HOAN",
      status: "RETURNED",
      items: [{ qty: 1, unitPrice: 100_000, discountEachProduct: 10_000, lineDiscount: 10_000 }],
    });
    await taoDon({
      id: "V-CU",
      orderedAt: new Date(2026, 4, 15),
      items: [{ qty: 1, unitPrice: 100_000, discountEachProduct: 10_000, lineDiscount: 10_000 }],
    });

    expect(await computeVoucherBreakdown(RANGE)).toEqual({ shopLineLevel: 0, marketplaceFunded: 0 });
  });

  it("lọc theo kênh", async () => {
    await taoDon({
      id: "V-TT",
      channelId: "tiktok",
      items: [{ qty: 1, unitPrice: 100_000, discountEachProduct: 10_000, lineDiscount: 7_000 }],
    });
    await taoDon({
      id: "V-SP",
      channelId: "shopee",
      items: [{ qty: 1, unitPrice: 200_000, discountEachProduct: 20_000, lineDiscount: 20_000 }],
    });

    expect(await computeVoucherBreakdown(RANGE, { channelId: "tiktok" })).toEqual({
      shopLineLevel: 7_000,
      marketplaceFunded: 3_000,
    });
    expect(await computeVoucherBreakdown(RANGE, { channelId: "shopee" })).toEqual({
      shopLineLevel: 20_000,
      marketplaceFunded: 0,
    });
  });

  it("gồm cả phần suy từ cod lúc ingest — đường thật mapping → upsert → breakdown", async () => {
    // Đơn #148 thật (đo prod 2026-08-05): Pancake BỎ TRỐNG marketplace_voucher nhưng `cod` cho thấy
    // sàn tài trợ 33.460 — ingest suy ra và ghi lineDiscount 111.000 (= 144.460 − 33.460). Đọc thẳng
    // field gốc sẽ ra 0: drawer hiện 33.460 mà bảng P&L kỳ hiện 0 cho CÙNG một đơn.
    const raw = pancakeOrderSchema.parse({
      id: "V-SUY-COD",
      status: 3,
      inserted_at: "2026-06-15T03:00:00.000000",
      order_sources_name: "Tiktok",
      marketplace_id: "-9",
      total_price: 350_000,
      total_discount: 0,
      fee_marketplace: 55_604,
      cod: 183_396,
      items: [
        { quantity: 1, variation_id: "v-suy", discount_each_product: 144_460, variation_info: { display_id: "SKU-SUY", name: "SP", retail_price: 350_000 } },
      ],
    });
    const mo = mapPancakeOrder(raw, { channels: { tiktok: { platformFeePct: 0, paymentFeePct: 0 } } });
    expect(mo.itemsTotal).toBe(239_000); // 350.000 − 111.000: phần suy ĐÃ cộng lại vào doanh thu
    const stats: UpsertStats = {
      productsUpserted: 0, variantsUpserted: 0, ordersUpserted: 0, ordersSkippedMirror: 0,
      ordersSkippedStale: 0, ordersDiscardedGiuaChung: 0, skipped: 0, boQuaCoChuDich: 0, unknownStatusOrders: 0,
      settlementsUpserted: 0, adsUpserted: 0, paymentsUpserted: 0, shopeeUpserted: 0, adsExpensesUpserted: 0,
    };
    await upsertOneOrder(mo, raw, stats, []);

    expect(await computeVoucherBreakdown(RANGE)).toEqual({
      shopLineLevel: 111_000,
      marketplaceFunded: 33_460,
    });
  });

  it("số dạng CHUỖI trong raw tính như số — khớp schema coerce và drawer", async () => {
    // Schema ingest `z.coerce` chấp nhận `"quantity":"1"`/`"discount_each_product":"10000"` nên
    // Silver lưu lineDiscount đúng; nếu SQL coi chuỗi là 0 thì phần sàn tài trợ của đúng đơn đó
    // thành 0 trong khi drawer (JS `Number()`) vẫn hiện — hai màn lệch nhau cho cùng một đơn.
    await taoDon({
      id: "V-CHUOI-DEP",
      items: [{ qty: 1, unitPrice: 100_000, discountEachProduct: "10000", lineDiscount: 7_000 }],
    });
    await taoDon({
      id: "V-CHUOI-QTY",
      items: [{ qty: "2", unitPrice: 100_000, discountEachProduct: 5_000, lineDiscount: 8_000 }],
    });

    expect(await computeVoucherBreakdown(RANGE)).toEqual({
      shopLineLevel: 15_000, // 7.000 + 8.000
      marketplaceFunded: 5_000, // (10.000 − 7.000) + (2×5.000 − 8.000)
    });
  });

  it("payload lệch kiểu (chuỗi rác/thiếu items) không làm hỏng cả kỳ", async () => {
    await taoDon({
      id: "V-NULL",
      items: [{ qty: 1, unitPrice: 100_000, discountEachProduct: 10_000, lineDiscount: 10_000 }],
    });
    await taoDon({
      id: "V-RAC",
      // Chuỗi KHÔNG phải số → coi 0 (regex chặn cast văng lỗi), hiệu kẹp GREATEST(0,…) không ra
      // số âm — truy vấn sống, đơn khác trong kỳ vẫn tính đúng.
      items: [{ qty: 1, unitPrice: 100_000, discountEachProduct: "abc", lineDiscount: 4_000 }],
    });
    await prisma.order.create({
      data: {
        pancakeId: "V-KHONG-ITEMS",
        code: "V-KHONG-ITEMS",
        channelId: "tiktok",
        status: "COMPLETED",
        orderedAt: IN_RANGE,
        syncedAt: IN_RANGE,
        itemsTotal: 50_000,
        discount: 0,
        platformFeeEst: 0,
        raw: { items: null },
      },
    });

    expect(await computeVoucherBreakdown(RANGE)).toEqual({
      shopLineLevel: 14_000, // 10.000 + 4.000 (dòng rác vẫn tính phần shop chịu từ Silver)
      marketplaceFunded: 0,
    });
  });
});
