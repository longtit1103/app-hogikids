import type { OrderStatus } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { laDonHopLe } from "@/lib/reports/pnl";

import type { DeXuatGiaVon } from "./doi-chieu-gia-von";

/**
 * "Áp giá vốn Pancake thì lãi THÁNG NÀO đổi bao nhiêu?"
 *
 * VÌ SAO PHẢI CÓ: COGS dùng giá vốn HIỆN HÀNH, không chụp ảnh lúc bán (`pnl.ts` khối CHỐT) ⇒ sửa
 * giá vốn hôm nay là viết lại lãi/lỗ của MỌI kỳ đã đóng. Đo thật đợt 2026-09-07: 91,5% ΔCOGS rơi
 * vào hàng đã bán xong TRƯỚC khi lô mới về kho, và lãi ròng tháng 5 đổi 10,2% chỉ vì một phiếu nhập.
 *
 * Chủ shop chốt 2026-09-07: chấp nhận cách tính này, VỚI ĐIỀU KIỆN thấy trước khi bấm. Bảng do hàm
 * này sinh ra chính là "thấy trước" đó — thiếu nó thì nút duyệt chỉ là CLI đẹp hơn, vẫn bấm mù.
 *
 * THUẦN ĐỌC.
 */

export type AnhHuongThang = {
  /** `YYYY-MM` theo giờ VN (bất biến #3). */
  thang: string;
  /** Âm = COGS giảm = lãi tăng. */
  deltaCogs: number;
  soDonViDaBan: number;
};

export type AnhHuongCogs = {
  theoThang: AnhHuongThang[];
  /** ΔCOGS trên đơn HỢP LỆ — đây là con số thật sự vào P&L. */
  tongDonHopLe: number;
  /** ΔCOGS trên mọi đơn, kể cả hoàn/huỷ — để đối chiếu, KHÔNG phải số vào P&L. */
  tongMoiDon: number;
  /** Biến thể trong danh sách đề xuất chưa từng bán ⇒ áp giá không đụng kỳ nào. */
  soBienTheChuaBan: number;
};

/**
 * Cắt tháng theo `Asia/Ho_Chi_Minh` — ĐỘC LẬP TZ máy chạy (không dựa `process.env.TZ`).
 * `en-CA` cho khuôn `YYYY-MM-DD` nên cắt 7 ký tự đầu là `YYYY-MM`. Cùng khuôn với `land-raw.ts`.
 */
const VN_MONTH_FORMATTER = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Ho_Chi_Minh",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

export function thangVn(d: Date): string {
  return VN_MONTH_FORMATTER.format(d).slice(0, 7);
}

/** Dòng hàng đã bán của các biến thể đang được đề xuất sửa giá. */
type DongDaBan = {
  variantId: string;
  status: OrderStatus;
  orderedAt: Date;
  quantity: number;
};

/**
 * Tính ảnh hưởng. `docLichSuBan` tách ra làm tham số để test chạy được không cần DB.
 */
export async function tinhAnhHuongCogs(
  deXuat: DeXuatGiaVon[],
  docLichSuBan: (variantIds: string[]) => Promise<DongDaBan[]> = docLichSuBanTuDb,
): Promise<AnhHuongCogs> {
  if (deXuat.length === 0) {
    return { theoThang: [], tongDonHopLe: 0, tongMoiDon: 0, soBienTheChuaBan: 0 };
  }

  const chenhTheoVariant = new Map(deXuat.map((d) => [d.variantId, d.giaDeXuat - d.giaHienTai]));
  const dong = await docLichSuBan([...chenhTheoVariant.keys()]);

  const theoThang = new Map<string, AnhHuongThang>();
  const daBan = new Set<string>();
  let tongDonHopLe = 0;
  let tongMoiDon = 0;

  for (const d of dong) {
    const chenh = chenhTheoVariant.get(d.variantId);
    if (chenh === undefined) continue; // dòng của biến thể không nằm trong đề xuất — bỏ
    daBan.add(d.variantId);

    const delta = chenh * d.quantity;
    tongMoiDon += delta;
    // Đơn hoàn/huỷ KHÔNG vào P&L (bất biến #1) ⇒ không được vào bảng tháng, nếu không chủ shop
    // duyệt theo một con số lớn hơn thực tế.
    if (!laDonHopLe(d.status)) continue;

    tongDonHopLe += delta;
    const thang = thangVn(d.orderedAt);
    const cu = theoThang.get(thang) ?? { thang, deltaCogs: 0, soDonViDaBan: 0 };
    cu.deltaCogs += delta;
    cu.soDonViDaBan += d.quantity;
    theoThang.set(thang, cu);
  }

  return {
    // Tháng gần nhất lên đầu — chủ shop quan tâm kỳ đang mở trước.
    theoThang: [...theoThang.values()].sort((a, b) => b.thang.localeCompare(a.thang)),
    tongDonHopLe,
    tongMoiDon,
    soBienTheChuaBan: deXuat.length - daBan.size,
  };
}

async function docLichSuBanTuDb(variantIds: string[]): Promise<DongDaBan[]> {
  const rows = await prisma.orderItem.findMany({
    where: { variantId: { in: variantIds } },
    select: {
      variantId: true,
      quantity: true,
      order: { select: { status: true, orderedAt: true } },
    },
  });
  return rows
    .filter((r): r is typeof r & { variantId: string } => r.variantId !== null)
    .map((r) => ({
      variantId: r.variantId,
      quantity: r.quantity,
      status: r.order.status,
      orderedAt: r.order.orderedAt,
    }));
}
