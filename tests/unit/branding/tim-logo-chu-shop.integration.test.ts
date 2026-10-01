// tests/unit/branding/tim-logo-chu-shop.integration.test.ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { timLogoPathChuShop } from "@/lib/branding/app-icon";
import { prisma } from "@/lib/prisma";

import { seedShopProfile } from "../../helpers/test-db";

describe("timLogoPathChuShop — logo lấy từ ShopProfile, không phụ thuộc User", () => {
  const EMAIL = "nguoi-dung-co-logo-cu@icon.test";

  beforeAll(async () => {
    await prisma.user.deleteMany({ where: { email: EMAIL } });
    // Cột cũ trên User có logo khác: code mới phải BỎ QUA nó.
    await prisma.user.create({
      data: {
        email: EMAIL,
        passwordHash: "scrypt$fake$hash",
        shopLogoPath: "/api/uploads/logo-cu-tren-user.png",
        createdAt: new Date("1990-01-01T00:00:00+07:00"),
      },
    });
  });
  afterAll(async () => {
    await prisma.user.deleteMany({ where: { email: EMAIL } });
    await seedShopProfile();
  });

  it("trả logo của ShopProfile", async () => {
    await seedShopProfile({ shopLogoPath: "/api/uploads/logo-shop.png" });
    expect(await timLogoPathChuShop()).toBe("/api/uploads/logo-shop.png");
  });

  it("ShopProfile chưa có logo ⇒ null dù User còn cột cũ", async () => {
    await seedShopProfile({ shopLogoPath: null });
    expect(await timLogoPathChuShop()).toBeNull();
  });
});
