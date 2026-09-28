import { beforeEach, describe, expect, it } from "vitest";

import { landRaw } from "@/lib/bronze/land-raw";
import { KEY_SHOP_ID, xoaCacheCauHinhShop } from "@/lib/ket-noi/cau-hinh-shop";
import { chanDoiShopIdKhiCoDuLieu } from "@/lib/ket-noi/chan-doi-shop-id";
import { prisma } from "@/lib/prisma";

import { SHOP_KHO } from "../helpers/shop-ids-fixture";

/**
 * Lưới chặn đổi shop ID khi kho thô đã có dữ liệu id cũ (red-team 21/08): Bronze append-only nên
 * đổi id là toàn bộ lịch sử thành mồ côi ÂM THẦM — COGS về 0, đối soát im. Action lưu khóa phải
 * TỪ CHỐI, không cảnh cáo suông.
 */

const DON = `{"id":"D1","status":3,"inserted_at":"2026-07-01T10:00:00.000000",
  "order_sources_name":"Affiliate","marketplace_id":"-3",
  "total_price":1000,"total_discount":0,"fee_marketplace":0,"items":[]}`;

beforeEach(async () => {
  await prisma.rawPancakeOrder.deleteMany();
  await prisma.rawPancakeProduct.deleteMany();
  await prisma.rawShopeeWalletTxn.deleteMany();
  await prisma.rawPancakeWebhookEvent.deleteMany();
  await prisma.setting.upsert({
    where: { key: KEY_SHOP_ID.kho },
    create: { key: KEY_SHOP_ID.kho, value: SHOP_KHO },
    update: { value: SHOP_KHO },
  });
  xoaCacheCauHinhShop();
});

describe("chanDoiShopIdKhiCoDuLieu", () => {
  it("kho thô rỗng → điền/đổi tự do (bản clone mới setup)", async () => {
    expect(await chanDoiShopIdKhiCoDuLieu([[KEY_SHOP_ID.kho, "888888888"]])).toBeNull();
  });

  it("giá trị không phải chuỗi số → từ chối", async () => {
    expect(await chanDoiShopIdKhiCoDuLieu([[KEY_SHOP_ID.kho, "abc123"]])).toMatch(/không hợp lệ/);
  });

  it("giữ nguyên giá trị đang lưu → cho qua (lưu lại form không đổi gì)", async () => {
    await landRaw("orders", SHOP_KHO, `{"success":true,"data":[${DON}]}`);
    expect(await chanDoiShopIdKhiCoDuLieu([[KEY_SHOP_ID.kho, SHOP_KHO]])).toBeNull();
  });

  it("ĐỔI id khi Bronze còn dữ liệu id cũ → từ chối, nêu số dòng sẽ mồ côi", async () => {
    await landRaw("orders", SHOP_KHO, `{"success":true,"data":[${DON}]}`);
    const loi = await chanDoiShopIdKhiCoDuLieu([[KEY_SHOP_ID.kho, "888888888"]]);
    expect(loi).toMatch(/1 dòng/);
    expect(loi).toContain(SHOP_KHO);
  });

  it("key không phải shop ID (API key, token…) đi qua tự do", async () => {
    await landRaw("orders", SHOP_KHO, `{"success":true,"data":[${DON}]}`);
    expect(await chanDoiShopIdKhiCoDuLieu([["pancakeApiKeyKho", "key-moi-bat-ky"]])).toBeNull();
  });

  it("shop MỚI CHỈ có dữ liệu VÍ (chưa có đơn) đổi id vẫn bị chặn — danh sách bảng từ registry", async () => {
    // Review 21/08: bản liệt kê bảng tay đầu tiên chỉ soi RawPancakeOrder — shop chỉ có ví Shopee
    // đổi id là toàn bộ Bronze ví mồ côi, "Tiền đã về" tụt 0 âm thầm. Registry phải phủ ca này.
    const { SHOP_SHOPEE } = await import("../helpers/shop-ids-fixture");
    await prisma.rawShopeeWalletTxn.create({
      data: {
        shopId: SHOP_SHOPEE,
        externalId: "t|REVENUE|X|1",
        payloadHash: "h-vi",
        payload: { txnTime: "t", type: "REVENUE", orderCode: "X", amount: 1, status: "ok", runningBalance: 1 },
      },
    });
    const loi = await chanDoiShopIdKhiCoDuLieu([[KEY_SHOP_ID.shopee, "888888888"]]);
    expect(loi).toMatch(/1 dòng/);
  });

  it("cùng một id cho 2 vai → từ chối (3 shop Pancake phải khác nhau)", async () => {
    const loi = await chanDoiShopIdKhiCoDuLieu([[KEY_SHOP_ID.shopee, SHOP_KHO]]);
    expect(loi).toMatch(/2 vai|cả "kho" lẫn|khác nhau/);
  });

  it("warehouse id không phải uuid → từ chối kèm hướng dẫn", async () => {
    expect(await chanDoiShopIdKhiCoDuLieu([["pancakeWarehouseIdKhoTong", "khong-phai-uuid"]])).toMatch(/uuid/);
  });
});
