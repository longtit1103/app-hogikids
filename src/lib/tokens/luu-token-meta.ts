import { prisma } from "@/lib/prisma";

/**
 * Ghi token Meta Ads vào kho (bảng `Setting`) — hàm DUY NHẤT được ghi 4 key này.
 * Dùng chung bởi route `/api/ingest/meta-token` (script chạy tay POST vào) và server action
 * "Đổi & lưu token Meta" ở trang Cài đặt — hai đường nhập, MỘT cách ghi, không lệch nhau.
 *
 * Một transaction: không để token mới đứng cạnh hạn cũ (đọc ra sẽ tưởng token sắp chết / còn lâu).
 */

export const KEY_META_ACCESS_TOKEN = "metaAdsAccessToken";
export const KEY_META_EXPIRE_AT = "metaAdsTokenExpireAt"; // epoch GIÂY — token hết hạn
export const KEY_META_DATA_EXPIRE_AT = "metaAdsDataAccessExpireAt"; // epoch GIÂY — quyền đọc dữ liệu hết hạn
export const KEY_META_SAVED_AT = "metaAdsTokenSavedAt"; // epoch GIÂY

export type TokenMetaCanLuu = {
  accessToken: string;
  /** epoch GIÂY. 0 = không hết hạn (System User token của Business Manager). */
  expireAt: number;
  dataAccessExpireAt: number;
};

/** @returns `savedAt` (epoch giây) đã ghi kèm token. Ném lỗi Prisma nguyên trạng — CALLER phải
 *  nuốt message (có thể chứa giá trị token) và trả lỗi chung chung cho người dùng. */
export async function luuTokenMetaVaoKho({ accessToken, expireAt, dataAccessExpireAt }: TokenMetaCanLuu): Promise<number> {
  const savedAt = Math.floor(Date.now() / 1000);
  await prisma.$transaction(
    (
      [
        [KEY_META_ACCESS_TOKEN, accessToken],
        [KEY_META_EXPIRE_AT, String(expireAt)],
        [KEY_META_DATA_EXPIRE_AT, String(dataAccessExpireAt)],
        [KEY_META_SAVED_AT, String(savedAt)],
      ] as const
    ).map(([key, value]) => prisma.setting.upsert({ where: { key }, create: { key, value }, update: { value } }))
  );
  return savedAt;
}
