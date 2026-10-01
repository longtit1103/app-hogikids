import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { prisma } from "@/lib/prisma";
import { docShopProfileKhongCache, ghiShopProfile } from "@/lib/shop-profile/doc-shop-profile";

// Trả lại đúng dòng id=1 như seed để suite khác (đọc tên shop) không bị lệch.
async function datLaiMacDinh(): Promise<void> {
  await prisma.shopProfile.upsert({
    where: { id: 1 },
    create: { id: 1 },
    update: { shopName: "HogiKids", shopPhone: null, shopLogoPath: null },
  });
}

describe("ShopProfile singleton — đọc/ghi", () => {
  beforeEach(async () => {
    await prisma.shopProfile.deleteMany();
  });
  afterAll(datLaiMacDinh);

  it("DB chưa có dòng ⇒ trả mặc định và KHÔNG tự tạo", async () => {
    expect(await docShopProfileKhongCache()).toEqual({ shopName: "HogiKids", shopPhone: null, shopLogoPath: null });
    expect(await prisma.shopProfile.count()).toBe(0);
  });

  it("ghi lần đầu tạo dòng id=1, đọc lại thấy giá trị", async () => {
    await ghiShopProfile(prisma, { shopName: "X" });
    expect((await docShopProfileKhongCache()).shopName).toBe("X");
    expect(await prisma.shopProfile.count()).toBe(1);
  });

  it("ghi lần hai chỉ đổi trường có mặt, giữ các trường còn lại", async () => {
    await ghiShopProfile(prisma, { shopName: "X", shopLogoPath: "/api/uploads/a.png" });
    await ghiShopProfile(prisma, { shopPhone: "0200000000" });
    expect(await docShopProfileKhongCache()).toEqual({
      shopName: "X",
      shopPhone: "0200000000",
      shopLogoPath: "/api/uploads/a.png",
    });
  });

  it("null xoá SĐT về rỗng, undefined thì giữ", async () => {
    await ghiShopProfile(prisma, { shopName: "X", shopPhone: "0200000000" });
    await ghiShopProfile(prisma, { shopName: "Y", shopPhone: undefined });
    expect((await docShopProfileKhongCache()).shopPhone).toBe("0200000000");
    await ghiShopProfile(prisma, { shopPhone: null });
    expect((await docShopProfileKhongCache()).shopPhone).toBeNull();
  });

  it("đọc/ghi được trong transaction", async () => {
    await prisma.$transaction(async (tx) => {
      await ghiShopProfile(tx, { shopName: "Trong tx" });
      expect((await docShopProfileKhongCache(tx)).shopName).toBe("Trong tx");
    });
  });

  it("INSERT id=2 bằng SQL thô bị CHECK chặn", async () => {
    await expect(prisma.$executeRawUnsafe(`INSERT INTO "ShopProfile" ("id") VALUES (2)`)).rejects.toThrow();
  });
});
