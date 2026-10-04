import type { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/prisma";

/**
 * Ghi token Meta Ads vào kho (bảng `Setting`) — hàm DUY NHẤT được ghi 4 key này.
 * Dùng chung bởi route `/api/ingest/meta-token` (script chạy tay POST vào) và server action
 * "Đổi & lưu token Meta" ở trang Cài đặt — hai đường nhập, MỘT cách ghi, không lệch nhau.
 *
 * Một transaction: không để token mới đứng cạnh hạn cũ (đọc ra sẽ tưởng token sắp chết / còn lâu).
 * Caller cần ghi thêm việc phụ (vd nhật ký thao tác) truyền `ghiThemTrongTx` — chạy CÙNG transaction,
 * ném ⇒ 4 key rollback, không có token mới mà thiếu dấu vết (hoặc ngược lại).
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
 *  nuốt message (có thể chứa giá trị token) và trả lỗi chung chung cho người dùng.
 *  `ghiThemTrongTx` chạy SAU 4 upsert, trong cùng transaction; nó ném ⇒ cả transaction rollback. */
export async function luuTokenMetaVaoKho(
  { accessToken, expireAt, dataAccessExpireAt }: TokenMetaCanLuu,
  ghiThemTrongTx?: (tx: Prisma.TransactionClient) => Promise<void>,
): Promise<number> {
  const savedAt = Math.floor(Date.now() / 1000);
  const cacCap = [
    [KEY_META_ACCESS_TOKEN, accessToken],
    [KEY_META_EXPIRE_AT, String(expireAt)],
    [KEY_META_DATA_EXPIRE_AT, String(dataAccessExpireAt)],
    [KEY_META_SAVED_AT, String(savedAt)],
  ] as const;
  await prisma.$transaction(async (tx) => {
    for (const [key, value] of cacCap) {
      await tx.setting.upsert({ where: { key }, create: { key, value }, update: { value } });
    }
    await ghiThemTrongTx?.(tx);
  });
  return savedAt;
}
