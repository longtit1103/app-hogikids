import type { Prisma } from "@prisma/client";

import { KENH_BAN_TRUC_TIEP } from "@/lib/channels/kenh-ban-truc-tiep";
import { prisma } from "@/lib/prisma";

/**
 * Tiền khách ĐÃ TRẢ tại shop cho đơn bán trực tiếp — nguồn DUY NHẤT trong thư mục Sổ quỹ được đọc bảng
 * đơn hàng, và CHỈ được đọc đúng cột `paidAtShop` của kênh bán trực tiếp.
 *
 * Vì sao được phép: đơn sàn chỉ cho số tiền DỰ KIẾN (tiền thật về sau qua TikTok về bank / rút ví
 * Shopee), còn đơn bán tại shop thì khách trả NGAY — cột này là số Pancake ghi nhận khách đã chuyển
 * khoản/trả tiền mặt, không phải doanh thu. Lưới `tests/unit/so-quy/khong-dung-tien-du-kien.test.ts`
 * khoá đúng hình dạng này: nới thêm cột/kênh nào là đỏ.
 *
 * Chỉ đơn COMPLETED (chủ shop chốt 23/09), neo `orderedAt` — bán tại quầy thì trả tiền lúc lên đơn.
 * Đơn hoàn/hủy rời quỹ theo trạng thái (tiền đã trả lại khách).
 */

type KhoangNgay = { gte?: Date; lte: Date };

/**
 * Bộ lọc DÙNG CHUNG cho cả lượt cộng tổng (thẻ Quỹ) lẫn lượt liệt kê (dòng chạy). Hai lượt đọc hai
 * bộ lọc viết riêng là sớm muộn trôi nhau — thẻ và bảng lệch đúng phần đơn một bên đếm, bên kia bỏ.
 */
function dieuKienDonBanTrucTiep(khoang: KhoangNgay) {
  return {
    channelId: KENH_BAN_TRUC_TIEP,
    status: "COMPLETED",
    orderedAt: khoang,
  } satisfies Prisma.OrderWhereInput;
}

export async function tongTienBanTrucTiep(khoang: KhoangNgay): Promise<number> {
  const r = await prisma.order.aggregate({
    where: dieuKienDonBanTrucTiep(khoang),
    _sum: { paidAtShop: true },
  });
  return r._sum.paidAtShop ?? 0;
}

export type DonBanTrucTiepDaTra = { id: string; code: string; orderedAt: Date; paidAtShop: number };

/**
 * Từng đơn của đúng tập mà `tongTienBanTrucTiep` cộng — cho Sổ quỹ dạng dòng chạy. Chỉ lấy mã đơn
 * hiển thị + mốc + số tiền khách đã trả; không cột tiền nào khác của đơn được rời khỏi file này.
 */
export async function lietKeTienBanTrucTiep(khoang: KhoangNgay): Promise<DonBanTrucTiepDaTra[]> {
  return prisma.order.findMany({
    where: dieuKienDonBanTrucTiep(khoang),
    select: { id: true, code: true, orderedAt: true, paidAtShop: true },
  });
}
