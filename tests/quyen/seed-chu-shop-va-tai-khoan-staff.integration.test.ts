import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { verifyPassword } from "@/lib/password";
import { prisma } from "@/lib/prisma";

import { seedChuShop } from "../../prisma/seed-lib";
import { taoTaiKhoanStaff } from "../e2e/tao-tai-khoan-staff";

/**
 * Integration (`hogikids_test`): seed chủ shop (OWNER + ShopProfile) và helper tài khoản STAFF.
 * Xoá mọi OWNER trước mỗi test — DB chỉ cho MỘT OWNER (partial unique `User_owner_duy_nhat`).
 */
const EMAIL_CHU = "chu@seed.test";
const EMAIL_KHAC = "chu-khac@seed.test";
const EMAIL_STAFF = "staff@seed.test";
const MAT_KHAU = "Mat-khau-seed-1!";

let hoSoGoc: { shopName: string; shopPhone: string | null; shopLogoPath: string | null } | null = null;

async function donUser(): Promise<void> {
  await prisma.user.deleteMany({
    where: { OR: [{ role: "OWNER" }, { email: { in: [EMAIL_CHU, EMAIL_KHAC, EMAIL_STAFF] } }] },
  });
}

beforeAll(async () => {
  hoSoGoc = await prisma.shopProfile.findUnique({
    where: { id: 1 },
    select: { shopName: true, shopPhone: true, shopLogoPath: true },
  });
});

beforeEach(async () => {
  await donUser();
  await prisma.shopProfile.deleteMany({});
});

afterAll(async () => {
  await donUser();
  await prisma.shopProfile.deleteMany({});
  if (hoSoGoc) await prisma.shopProfile.create({ data: { id: 1, ...hoSoGoc } });
  await prisma.$disconnect();
});

describe("seedChuShop", () => {
  it("DB chưa có ai ⇒ 1 OWNER email chuẩn hoá, mật khẩu đăng nhập được, ShopProfile id=1", async () => {
    await seedChuShop(prisma, { email: "  Chu@Seed.TEST ", password: MAT_KHAU });

    const user = await prisma.user.findUniqueOrThrow({ where: { email: EMAIL_CHU } });
    expect(user.role).toBe("OWNER");
    expect(user.sessionEpoch).toBe("0");
    expect(await verifyPassword(MAT_KHAU, user.passwordHash)).toBe(true);
    expect(await prisma.shopProfile.findMany()).toEqual([
      { id: 1, shopName: "HogiKids", shopPhone: null, shopLogoPath: null },
    ]);
  });

  it("chạy lại ⇒ KHÔNG ghi đè hash, không nhân dòng, không ghi đè ShopProfile đã sửa", async () => {
    await seedChuShop(prisma, { email: EMAIL_CHU, password: MAT_KHAU });
    await prisma.shopProfile.update({ where: { id: 1 }, data: { shopName: "Shop đã sửa tay" } });
    const truoc = await prisma.user.findUniqueOrThrow({ where: { email: EMAIL_CHU } });

    await seedChuShop(prisma, { email: EMAIL_CHU.toUpperCase(), password: "Mat-khau-khac-2!" });

    const sau = await prisma.user.findUniqueOrThrow({ where: { email: EMAIL_CHU } });
    expect(sau.passwordHash).toBe(truoc.passwordHash);
    expect(await prisma.user.count({ where: { role: "OWNER" } })).toBe(1);
    expect((await prisma.shopProfile.findUniqueOrThrow({ where: { id: 1 } })).shopName).toBe("Shop đã sửa tay");
  });

  it("đã có OWNER khác email ⇒ ném, không tạo OWNER thứ hai", async () => {
    await seedChuShop(prisma, { email: EMAIL_CHU, password: MAT_KHAU });
    await expect(seedChuShop(prisma, { email: EMAIL_KHAC, password: MAT_KHAU })).rejects.toThrow();
    expect(await prisma.user.count({ where: { role: "OWNER" } })).toBe(1);
    expect(await prisma.user.count({ where: { email: EMAIL_KHAC } })).toBe(0);
  });

  it("mật khẩu vượt trần màn đăng nhập ⇒ ném TRƯỚC khi ghi", async () => {
    await expect(seedChuShop(prisma, { email: EMAIL_CHU, password: "x".repeat(201) })).rejects.toThrow(/vượt trần/);
    expect(await prisma.user.count({ where: { email: EMAIL_CHU } })).toBe(0);
    expect(await prisma.shopProfile.count()).toBe(0);
  });

  it("email trống ⇒ ném", async () => {
    await expect(seedChuShop(prisma, { email: "   ", password: MAT_KHAU })).rejects.toThrow(/trống/);
  });
});

describe("taoTaiKhoanStaff", () => {
  it("tạo STAFF: email chuẩn hoá, quyền đã chuẩn hoá (sua kéo theo xem), mustChangePassword", async () => {
    const tk = await taoTaiKhoanStaff(prisma, {
      email: " Staff@Seed.test",
      matKhau: MAT_KHAU,
      quyen: ["chi-phi:sua", "don-hang:xem"],
      mustChangePassword: true,
    });
    expect(tk.email).toBe(EMAIL_STAFF);

    const user = await prisma.user.findUniqueOrThrow({ where: { id: tk.id } });
    expect(user.role).toBe("STAFF");
    expect(user.quyen).toEqual(["don-hang:xem", "chi-phi:xem", "chi-phi:sua"]);
    expect(user.mustChangePassword).toBe(true);
    expect(await verifyPassword(MAT_KHAU, user.passwordHash)).toBe(true);
  });

  it("tạo lại cùng email ⇒ vẫn đúng 1 dòng, quyền mới", async () => {
    await taoTaiKhoanStaff(prisma, { email: EMAIL_STAFF, matKhau: MAT_KHAU, quyen: ["ton-kho:xem"] });
    await taoTaiKhoanStaff(prisma, { email: EMAIL_STAFF, matKhau: MAT_KHAU, quyen: ["kenh:xem"] });
    const dong = await prisma.user.findMany({ where: { email: EMAIL_STAFF } });
    expect(dong).toHaveLength(1);
    expect(dong[0]?.quyen).toEqual(["kenh:xem"]);
  });

  it("tổ hợp app không tạo được (Lãi/Lỗ thiếu giá vốn) ⇒ ném, không ghi", async () => {
    await expect(
      taoTaiKhoanStaff(prisma, { email: EMAIL_STAFF, matKhau: MAT_KHAU, quyen: ["tai-chinh-loi-lo:xem"] }),
    ).rejects.toThrow(/giá vốn/);
    expect(await prisma.user.count({ where: { email: EMAIL_STAFF } })).toBe(0);
  });
});
