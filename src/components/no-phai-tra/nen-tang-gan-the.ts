/**
 * Nền tảng ads chọn được khi gắn vào thẻ — danh sách CỐ ĐỊNH, KHÔNG text tự do. SHOPEE_ADS cố ý vắng:
 * ví Shopee Ads nạp trước rồi chạy, tiền rời quỹ theo NGUỒN NẠP chứ không theo thẻ gánh ads.
 * Khớp `NEN_TANG_GAN_THE` ở server (`the-tin-dung-queries.ts`, không import được vào client vì kéo Prisma)
 * — test `nen-tang-chon-khop-may-chu` khoá hai danh sách bằng nhau.
 */
export const NEN_TANG_CHON = [
  { value: "META", label: "Meta" },
  { value: "TIKTOK_ADS", label: "TikTok Ads" },
] as const;

export function nhanNenTang(value: string): string {
  return NEN_TANG_CHON.find((n) => n.value === value)?.label ?? value;
}
