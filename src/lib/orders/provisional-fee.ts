import type { OrderStatus } from "@prisma/client";

import { usesRealPlatformFee } from "@/lib/channels/real-fee-channels";

/**
 * Ngưỡng nhận diện "phí sàn tạm tính": đơn marketplace có phí sàn dưới 10%
 * doanh thu thì nghi là sàn CHƯA đối soát xong. Căn cứ dữ liệu thật (2026-07):
 * đơn Shopee/TikTok đã đối soát có phí ~27-36%, đơn chưa đối soát ~5%. Khoảng
 * trống giữa hai cụm rộng nên 10% tách sạch, không cần xét tuổi đơn.
 */
export const PROVISIONAL_FEE_MAX_RATIO = 0.1;

/** Giải thích nhãn "tạm tính" — dùng CHUNG cho tooltip ở bảng đơn + drawer để 2 nơi không lệch chữ. */
export const PROVISIONAL_FEE_TITLE =
  "Sàn chưa đối soát xong — phí thật thường cao hơn (~27-36%), lãi thật sẽ thấp hơn số đang hiện. Tự cập nhật khi đơn được đồng bộ lại.";

/**
 * Đơn marketplace (Shopee/TikTok) có phí sàn NGHI là tạm tính — `fee_marketplace`
 * Pancake trả về đang thấp bất thường vì sàn chưa chốt phí. Lãi hiển thị đang
 * CAO hơn thực tế cho tới khi sàn đối soát (phí thật ~27-36% sẽ tự cập nhật khi
 * đơn được re-sync, xem `pancake-mapping.ts` + workflow nightly).
 *
 * Chỉ xét:
 * - Kênh có phí THẬT (Shopee/TikTok). FB/Website dùng phí ước tính % nên khái
 *   niệm "tạm/đối soát" không áp dụng — luôn trả false.
 * - Đơn HỢP LỆ (không hoàn/hủy). Đơn hoàn/hủy không tính vào lãi nên phí tạm
 *   hay thật đều không gây hiểu nhầm lãi.
 * - `itemsTotal > 0` để tránh chia cho 0.
 */
export function isProvisionalPlatformFee(o: {
  channelId: string;
  status: OrderStatus;
  itemsTotal: number;
  platformFeeEst: number;
}): boolean {
  if (!usesRealPlatformFee(o.channelId)) return false;
  if (o.status === "RETURNED" || o.status === "CANCELLED") return false;
  if (o.itemsTotal <= 0) return false;
  return o.platformFeeEst / o.itemsTotal < PROVISIONAL_FEE_MAX_RATIO;
}

/** Nhãn phí đơn hoàn/hủy đã vào P&L. */
export const RETURNED_FEE_TITLE =
  "Phí sàn THỰC sàn giữ trên đơn hoàn/hủy (đã tính vào lãi ròng P&L). Khi sàn chưa đối soát xong, tạm coi 0 và có thể nhảy lên khi đồng bộ lại.";

/**
 * Cửa sổ (ngày) coi đơn hoàn/hủy CÒN đang chờ sàn đối soát → phí thực
 * (`returnedFee`) có thể chưa về. Quá cửa sổ này coi như sàn ĐÃ chốt (đơn
 * hoàn/hủy thường chốt về 0đ) → bỏ nhãn "tạm tính". Sàn thường đối soát ~2 tuần;
 * 30 = 2 tuần + đệm (chốt với chủ shop 2026-07-21, sau khi đơn April cũ vẫn dính
 * nhãn tạm). Số P&L tự đúng khi re-sync bất kể nhãn — đây chỉ là chỉ báo hiển thị.
 */
export const PROVISIONAL_SETTLEMENT_WINDOW_DAYS = 30;

/**
 * Hiển thị phí sàn đơn HOÀN/HỦY ở màn Đơn hàng — SỐ THỰC (`returnedFee`, đã vào
 * P&L), theo convention provisional→settled giống phí sàn thường:
 * - `returnedFee > 0`: đã đối soát → số thực, bỏ nhãn tạm.
 * - `returnedFee = 0` nhưng `platformFeeEst > 0` VÀ đơn còn trong cửa sổ đối soát
 *   (≤`PROVISIONAL_SETTLEMENT_WINDOW_DAYS` ngày): hiện 0 + nhãn "tạm tính".
 * - `returnedFee = 0` nhưng đơn ĐÃ QUÁ cửa sổ: coi như sàn chốt (thường 0đ) →
 *   hiện 0, BỎ nhãn tạm (không cảnh báo sai cho đơn đã đối soát lâu).
 * - cả hai = 0: không có phí → không hiện.
 * Chỉ kênh có phí THẬT (Shopee/TikTok) + status RETURNED/CANCELLED. `now` truyền
 * vào (không gọi Date trong hàm) để test tất định.
 */
export function returnedOrderFeeDisplay(
  o: {
    channelId: string;
    status: OrderStatus;
    returnedFee: number;
    platformFeeEst: number;
    orderedAt: Date;
  },
  now: Date,
): { show: boolean; fee: number; provisional: boolean } {
  if (!usesRealPlatformFee(o.channelId)) return { show: false, fee: 0, provisional: false };
  if (o.status !== "RETURNED" && o.status !== "CANCELLED") return { show: false, fee: 0, provisional: false };
  if (o.returnedFee <= 0 && o.platformFeeEst <= 0) return { show: false, fee: 0, provisional: false };
  const ageDays = (now.getTime() - o.orderedAt.getTime()) / 86_400_000;
  const provisional = o.returnedFee <= 0 && ageDays <= PROVISIONAL_SETTLEMENT_WINDOW_DAYS;
  return { show: true, fee: o.returnedFee, provisional };
}

/**
 * Tỉ lệ phí sàn trên doanh thu, dạng "16,3%" (dấu phẩy thập phân VN, tối đa 1 số
 * lẻ — cùng quy ước với `pnl-tab.tsx`). Trả `null` khi KHÔNG có tỉ lệ đáng hiện:
 * `itemsTotal ≤ 0` (tránh chia 0) hoặc phí = 0 (đơn không phí thì "0%" chỉ gây
 * rối). Dùng chung cho bảng đơn + drawer + dải tổng để 3 nơi không lệch cách hiện.
 */
export function formatPlatformFeeRatio(platformFeeEst: number, itemsTotal: number): string | null {
  if (itemsTotal <= 0 || platformFeeEst === 0) return null;
  const pct = (platformFeeEst / itemsTotal) * 100;
  return `${pct.toLocaleString("vi-VN", { maximumFractionDigits: 1, minimumFractionDigits: 0 })}%`;
}
