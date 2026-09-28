import { beforeEach, describe, expect, it } from "vitest";

import { landRaw } from "@/lib/bronze/land-raw";
import {
  KEY_SHOP_ID,
  layCauHinhShop,
  shopIdsChoVai,
  xoaCacheCauHinhShop,
} from "@/lib/ket-noi/cau-hinh-shop";
import { prisma } from "@/lib/prisma";

import { SHOP_KHO, SHOP_SHOPEE, SHOP_TIKTOK, SHOP_TIKTOK_SHOP } from "../helpers/shop-ids-fixture";

/**
 * Cấu hình shop id từ bảng `Setting` — nguồn duy nhất thay cho hằng trong code (clone-and-go).
 * Khoá 3 hành vi sống còn: thiếu key phải KÊU TO (không fallback id cũ), cache phải xoá được
 * ngay khi lưu, và landRaw phải từ chối có-tên-key khi cấu hình trống.
 */

async function ghiKey(key: string, value: string): Promise<void> {
  await prisma.setting.upsert({ where: { key }, create: { key, value }, update: { value } });
}

async function resetVeFixture(): Promise<void> {
  await ghiKey(KEY_SHOP_ID.kho, SHOP_KHO);
  await ghiKey(KEY_SHOP_ID.shopee, SHOP_SHOPEE);
  await ghiKey(KEY_SHOP_ID.tiktok, SHOP_TIKTOK);
  await ghiKey(KEY_SHOP_ID.tiktokShop, SHOP_TIKTOK_SHOP);
  xoaCacheCauHinhShop();
}

beforeEach(resetVeFixture);

describe("layCauHinhShop", () => {
  it("đọc đủ 4 vai từ Setting", async () => {
    const ch = await layCauHinhShop();
    expect(ch).toEqual({ kho: SHOP_KHO, shopee: SHOP_SHOPEE, tiktok: SHOP_TIKTOK, tiktokShop: SHOP_TIKTOK_SHOP });
  });

  it("thiếu key Pancake → throw kèm TÊN key thiếu, không fallback id cũ", async () => {
    await prisma.setting.delete({ where: { key: KEY_SHOP_ID.kho } });
    xoaCacheCauHinhShop();
    await expect(layCauHinhShop()).rejects.toThrow(/Chưa cấu hình shop ID Pancake.*pancakeShopIdKho/);
  });

  it("giá trị không phải chuỗi số (dán nhầm) → coi như thiếu, throw", async () => {
    await ghiKey(KEY_SHOP_ID.shopee, "id-cua-toi");
    xoaCacheCauHinhShop();
    await expect(layCauHinhShop()).rejects.toThrow(/pancakeShopIdShopee/);
  });

  it("thừa khoảng trắng → trim (thừa khoảng trắng từng làm cả stream bị từ chối)", async () => {
    await ghiKey(KEY_SHOP_ID.tiktok, `  ${SHOP_TIKTOK}  `);
    xoaCacheCauHinhShop();
    expect((await layCauHinhShop()).tiktok).toBe(SHOP_TIKTOK);
  });

  it("cache: đổi thẳng DB chưa thấy ngay, xoaCacheCauHinhShop() thấy liền", async () => {
    await layCauHinhShop(); // mồi cache
    await ghiKey(KEY_SHOP_ID.kho, "111111111");
    expect((await layCauHinhShop()).kho).toBe(SHOP_KHO); // vẫn bản cache
    xoaCacheCauHinhShop();
    expect((await layCauHinhShop()).kho).toBe("111111111");
  });

  it("tiktokShopShopId là TUỲ CHỌN: thiếu → null, đường Pancake vẫn chạy", async () => {
    await prisma.setting.delete({ where: { key: KEY_SHOP_ID.tiktokShop } });
    xoaCacheCauHinhShop();
    const ch = await layCauHinhShop();
    expect(ch.tiktokShop).toBeNull();
    expect(ch.kho).toBe(SHOP_KHO);
  });
});

describe("shopIdsChoVai", () => {
  it("resolve vai → id thật", async () => {
    expect(await shopIdsChoVai(["kho", "shopee", "tiktok"])).toEqual([SHOP_KHO, SHOP_SHOPEE, SHOP_TIKTOK]);
  });

  it("vai tiktokShop khi chưa cấu hình → lỗi nêu đúng key cần điền", async () => {
    await prisma.setting.delete({ where: { key: KEY_SHOP_ID.tiktokShop } });
    xoaCacheCauHinhShop();
    await expect(shopIdsChoVai(["tiktokShop"])).rejects.toThrow(/tiktokShopShopId/);
  });
});

describe("landRaw khi cấu hình trống", () => {
  it("từ chối với thông báo 'Chưa cấu hình shop ID' — không 500 mù", async () => {
    await prisma.setting.deleteMany({
      where: { key: { in: [KEY_SHOP_ID.kho, KEY_SHOP_ID.shopee, KEY_SHOP_ID.tiktok] } },
    });
    xoaCacheCauHinhShop();
    await expect(
      landRaw("orders", SHOP_SHOPEE, `{"success":true,"data":[]}`)
    ).rejects.toThrow(/Chưa cấu hình shop ID Pancake/);
  });
});
