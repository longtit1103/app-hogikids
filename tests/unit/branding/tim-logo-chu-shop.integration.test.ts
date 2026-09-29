// tests/unit/branding/tim-logo-chu-shop.integration.test.ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { timLogoPathChuShop } from "@/lib/branding/app-icon";
import { prisma } from "@/lib/prisma";

// createdAt đặt về 1990 để chắc chắn sớm hơn mọi user seed/test khác trong DB test.
const EMAIL_SOM = "chu-shop-som@icon.test";
const EMAIL_MUON = "nguoi-sau@icon.test";

describe("timLogoPathChuShop — lấy logo của User tạo SỚM NHẤT", () => {
  beforeAll(async () => {
    await prisma.user.deleteMany({ where: { email: { in: [EMAIL_SOM, EMAIL_MUON] } } });
    await prisma.user.create({
      data: {
        email: EMAIL_MUON,
        passwordHash: "scrypt$fake$hash",
        shopLogoPath: "/api/uploads/logo-2.png",
        createdAt: new Date("1990-06-01T00:00:00+07:00"),
      },
    });
    await prisma.user.create({
      data: {
        email: EMAIL_SOM,
        passwordHash: "scrypt$fake$hash",
        shopLogoPath: "/api/uploads/logo-1.png",
        createdAt: new Date("1990-01-01T00:00:00+07:00"),
      },
    });
  });
  afterAll(async () => {
    await prisma.user.deleteMany({ where: { email: { in: [EMAIL_SOM, EMAIL_MUON] } } });
  });

  it("chọn user tạo sớm nhất, bất kể thứ tự insert", async () => {
    expect(await timLogoPathChuShop()).toBe("/api/uploads/logo-1.png");
  });
});
