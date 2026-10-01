/**
 * Thông tin shop (tên, SĐT, logo) — bảng singleton `ShopProfile` (id = 1, DB CHECK chặn dòng thứ hai).
 *
 * Trước đây 3 trường này nằm trên `User`; khi có nhiều tài khoản thì "tên shop" không thể thuộc về một
 * người, nên tách ra đây. 3 cột cũ trên `User` còn trong schema cho binary cũ đọc — code mới KHÔNG đọc/ghi.
 */
import { cache } from "react";

import { prisma } from "@/lib/prisma";
import type { ClientPhien } from "@/lib/session";

export type ShopProfileDto = {
  shopName: string;
  shopPhone: string | null;
  shopLogoPath: string | null;
};

export const SHOP_PROFILE_ID = 1;

/** DB trắng chưa seed: trả mặc định, KHÔNG tự tạo dòng (đọc không được có tác dụng phụ). */
const MAC_DINH: ShopProfileDto = { shopName: "HogiKids", shopPhone: null, shopLogoPath: null };

/** Đọc không cache — cho route ngoài RSC (icon) và cho đường ghi cần số mới nhất. */
export async function docShopProfileKhongCache(db: ClientPhien = prisma): Promise<ShopProfileDto> {
  const row = await db.shopProfile.findUnique({
    where: { id: SHOP_PROFILE_ID },
    select: { shopName: true, shopPhone: true, shopLogoPath: true },
  });
  return row ?? { ...MAC_DINH };
}

/** Đọc trong RSC: cache theo request để layout + trang cùng gọi chỉ tốn một câu truy vấn. */
export const docShopProfile: () => Promise<ShopProfileDto> = cache(() => docShopProfileKhongCache());

/**
 * Upsert dòng id=1. Chỉ trường CÓ mặt trong `data` mới bị đổi (`undefined` = giữ nguyên;
 * `null` = xoá về rỗng cho SĐT/logo).
 */
export async function ghiShopProfile(db: ClientPhien, data: Partial<ShopProfileDto>): Promise<void> {
  const patch: Partial<ShopProfileDto> = {};
  if (data.shopName !== undefined) patch.shopName = data.shopName;
  if (data.shopPhone !== undefined) patch.shopPhone = data.shopPhone;
  if (data.shopLogoPath !== undefined) patch.shopLogoPath = data.shopLogoPath;
  await db.shopProfile.upsert({
    where: { id: SHOP_PROFILE_ID },
    create: { id: SHOP_PROFILE_ID, ...patch },
    update: patch,
  });
}
