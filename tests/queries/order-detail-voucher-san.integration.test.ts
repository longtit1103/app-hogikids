import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { getOrderDetail } from "@/lib/queries/orders";
import { prisma } from "@/lib/prisma";
import { seedReference, truncateBusinessTables } from "../helpers/test-db";

/**
 * VOUCHER SÀN TÀI TRỢ hiện ở drawer chi tiết đơn.
 *
 * Bẫy đã dính thật (bắt được bằng mắt khi chụp màn, KHÔNG test nào canh): lấy
 * `voucherSanApDung(marketplace_voucher, Σ OrderItem.lineDiscount)` là kẹp bằng
 * chính con số đã trừ voucher đi rồi — `lineDiscount` là phần SHOP CHỊU
 * (`pancake-mapping.ts` → `giamGiaShopTheoDong`). Đơn có giảm giá dòng thô 40.000
 * và voucher sàn 35.000 sẽ hiện 5.000, tức nuốt mất 30.000 tiền sàn tài trợ.
 *
 * Con số đúng suy từ CHÊNH LỆCH: Σ (giảm giá mỗi đơn vị × số lượng) của payload
 * gốc trừ đi Σ `lineDiscount` đã lưu.
 */

const IN_RANGE = new Date(2026, 7, 5);

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
 * Dựng đơn ĐÚNG như ingest đã lưu: `lineDiscount` là phần shop chịu (thô trừ
 * voucher sàn), còn `raw.items[].discount_each_product` giữ số THÔ mỗi đơn vị.
 */
async function taoDon(opts: {
  pancakeId: string;
  soLuong: number;
  giamGiaMoiDonVi: number;
  voucherSanTho: number;
  lineDiscountShopChiu: number;
}): Promise<string> {
  const order = await prisma.order.create({
    data: {
      pancakeId: opts.pancakeId,
      code: opts.pancakeId,
      channelId: "tiktok",
      status: "COMPLETED",
      orderedAt: IN_RANGE,
      syncedAt: IN_RANGE,
      itemsTotal: 750_000,
      discount: 20_000,
      platformFeeEst: 100_000,
      raw: {
        items: [{ quantity: opts.soLuong, discount_each_product: opts.giamGiaMoiDonVi }],
        advanced_platform_fee: { marketplace_voucher: opts.voucherSanTho },
      },
      items: {
        create: [
          {
            sku: "VS-SKU",
            productName: "SP voucher sàn",
            quantity: opts.soLuong,
            unitPrice: 259_000,
            lineDiscount: opts.lineDiscountShopChiu,
          },
        ],
      },
    },
  });
  return order.id;
}

describe("getOrderDetail — voucher sàn tài trợ", () => {
  it("giảm giá dòng thô 40.000, sàn tài trợ 35.000 → hiện ĐỦ 35.000 (không phải 5.000 phần shop chịu)", async () => {
    const id = await taoDon({
      pancakeId: "VS-1",
      soLuong: 2,
      giamGiaMoiDonVi: 20_000, // thô = 2 × 20.000 = 40.000
      voucherSanTho: 35_000,
      lineDiscountShopChiu: 5_000, // 40.000 − 35.000
    });

    const d = await getOrderDetail(id);
    expect(d?.marketplaceFunded).toBe(35_000);
  });

  it("sàn không tài trợ gì → 0, không âm", async () => {
    const id = await taoDon({
      pancakeId: "VS-2",
      soLuong: 2,
      giamGiaMoiDonVi: 20_000,
      voucherSanTho: 0,
      lineDiscountShopChiu: 40_000, // shop chịu trọn
    });

    expect((await getOrderDetail(id))?.marketplaceFunded).toBe(0);
  });

  it("sàn gánh TRỌN phần giảm giá dòng → hiện đúng toàn bộ", async () => {
    const id = await taoDon({
      pancakeId: "VS-3",
      soLuong: 3,
      giamGiaMoiDonVi: 10_000, // thô = 30.000
      voucherSanTho: 30_000,
      lineDiscountShopChiu: 0,
    });

    expect((await getOrderDetail(id))?.marketplaceFunded).toBe(30_000);
  });

  /**
   * Ingest có luật suy bù khi Pancake QUÊN khai `marketplace_voucher`
   * (`suy-voucher-san-tu-cod.ts`): lúc đó `lineDiscount` đã trừ phần bù nhưng
   * field gốc vẫn là 0. Đọc thẳng field sẽ ra 0 và mất hẳn khoản sàn chịu —
   * suy theo chênh lệch thì tự động đúng.
   */
  it("Pancake quên khai voucher nhưng ingest đã suy bù → vẫn hiện đúng phần sàn chịu", async () => {
    const id = await taoDon({
      pancakeId: "VS-4",
      soLuong: 2,
      giamGiaMoiDonVi: 20_000, // thô = 40.000
      voucherSanTho: 0, // Pancake để trống
      lineDiscountShopChiu: 12_000, // ingest suy ra sàn gánh 28.000
    });

    expect((await getOrderDetail(id))?.marketplaceFunded).toBe(28_000);
  });

  it("đơn Shopee KHÔNG tra quyết toán TikTok — kể cả khi Bronze có giao dịch trùng mã", async () => {
    // `RawTiktokShopTransaction` là dữ liệu TikTok thuần: đơn Shopee quét bảng đó vừa tốn một lượt
    // seq-scan mỗi lần mở drawer (bảng append-only, phình dần), vừa có thể NHẬN NHẦM khối "Sàn
    // quyết toán" nếu mã đơn hai sàn trùng nhau — trồng sẵn một giao dịch trùng mã để chứng minh.
    await prisma.rawTiktokShopTransaction.deleteMany();
    await prisma.rawTiktokShopTransaction.create({
      data: {
        shopId: "100975192",
        externalId: "txn-trung-ma",
        payloadHash: "h-txn-trung-ma",
        payload: { order_id: "SP-TRUNG", type: "ORDER", settlement_amount: "123456", revenue_amount: "150000" },
      },
    });
    const order = await prisma.order.create({
      data: {
        pancakeId: "SP-TRUNG",
        code: "SP-TRUNG",
        channelId: "shopee",
        status: "COMPLETED",
        orderedAt: IN_RANGE,
        syncedAt: IN_RANGE,
        itemsTotal: 150_000,
        discount: 0,
        platformFeeEst: 40_000,
        raw: {},
      },
    });

    expect((await getOrderDetail(order.id))?.quyetToan).toBeNull();
  });

  it("đơn TikTok vẫn tra được quyết toán (guard không giết đường thật)", async () => {
    await prisma.rawTiktokShopTransaction.deleteMany();
    await prisma.rawTiktokShopTransaction.create({
      data: {
        shopId: "100975192",
        externalId: "txn-tt",
        payloadHash: "h-txn-tt",
        payload: { order_id: "TT-1", type: "ORDER", settlement_amount: "123456", revenue_amount: "150000" },
      },
    });
    const order = await prisma.order.create({
      data: {
        pancakeId: "TT-1",
        code: "TT-1",
        channelId: "tiktok",
        status: "COMPLETED",
        orderedAt: IN_RANGE,
        syncedAt: IN_RANGE,
        itemsTotal: 150_000,
        discount: 0,
        platformFeeEst: 26_544,
        raw: {},
      },
    });

    expect((await getOrderDetail(order.id))?.quyetToan?.settlement).toBe(123_456);
  });

  it("payload không có mảng items (dữ liệu lạ) → 0, không văng lỗi", async () => {
    const order = await prisma.order.create({
      data: {
        pancakeId: "VS-5",
        code: "VS-5",
        channelId: "tiktok",
        status: "COMPLETED",
        orderedAt: IN_RANGE,
        syncedAt: IN_RANGE,
        itemsTotal: 100_000,
        discount: 0,
        platformFeeEst: 0,
        raw: { advanced_platform_fee: { marketplace_voucher: 50_000 } },
      },
    });

    expect((await getOrderDetail(order.id))?.marketplaceFunded).toBe(0);
  });
});
