import { addMonths, format, startOfMonth, subDays } from "date-fns";

import { hanTraGoiY } from "@/lib/no-phai-tra/doc-khoi-no-phai-tra";
import { ngayChotGanNhat, type TheKemTrangThai } from "@/lib/no-phai-tra/the-tin-dung-queries";
import { NHAN_NEN_TANG_VI, type HoSoViAds } from "@/lib/no-phai-tra/vi-ads-queries";
import { prisma } from "@/lib/prisma";
import { khoaNgayVn } from "@/lib/so-quy/dong-chay-so-quy";

/**
 * Dữ liệu dẫn xuất cho trang `/tai-chinh/no-phai-tra` (chuẩn bị / xác nhận bật). Thuần đọc; ngày trả về
 * dạng chuỗi đã format ở server (client không format theo múi giờ trình duyệt).
 */

const DINH_DANG = /^\d{4}-\d{2}-\d{2}$/;

/** Ngày bật dự kiến từ `?m=`: hợp lệ thì dùng, không thì mặc định ngày đầu tháng sau (giờ VN). */
export function chuanHoaNgayM(raw: string | undefined, homNay: Date = new Date()): string {
  if (raw !== undefined && DINH_DANG.test(raw)) {
    const d = new Date(`${raw}T00:00:00+07:00`);
    if (!Number.isNaN(d.getTime()) && khoaNgayVn(d) === raw && d.getFullYear() >= 2000) return raw;
  }
  return format(startOfMonth(addMonths(homNay, 1)), "yyyy-MM-dd");
}

export type TheChoBatServer = { id: string; ten: string; saoKeNgayChot: string; saoKeHanTra: string };

/** Thẻ ĐANG MỞ kèm gợi ý kỳ sao kê gần nhất trước ngày bật (ngày chốt của thẻ ≤ M − 1, hạn trả kế tiếp). */
export function theChoBat(the: readonly TheKemTrangThai[], mocM: Date): TheChoBatServer[] {
  return the
    .filter((t) => t.closedAt === null)
    .map((t) => {
      const ngayChot = ngayChotGanNhat(mocM, t.ngayChotSaoKe);
      return { id: t.id, ten: t.ten, saoKeNgayChot: ngayChot, saoKeHanTra: hanTraGoiY(ngayChot, t.ngayHanTra) };
    });
}

export function viChoBat(vis: readonly HoSoViAds[]): { id: string; nhan: string }[] {
  return vis.map((v) => ({ id: v.id, nhan: `Ví ${NHAN_NEN_TANG_VI[v.nenTang] ?? v.nenTang}` }));
}

export const nhanNgay = (iso: string) => format(new Date(`${iso}T00:00:00+07:00`), "dd/MM/yyyy");
export const ngayTruoc = (iso: string) => format(subDays(new Date(`${iso}T00:00:00+07:00`), 1), "yyyy-MM-dd");

/** Các dòng điều chỉnh quỹ của bước bật (đã ghi), cũ trước. */
export async function docDieuChinhDaGhi(): Promise<
  { id: string; vao: boolean; soTien: number; moTa: string; ngayNhan: string }[]
> {
  const rows = await prisma.cashMovement.findMany({
    where: { kind: { in: ["CUTOVER_ADJ_IN", "CUTOVER_ADJ_OUT"] } },
    orderBy: [{ date: "asc" }, { createdAt: "asc" }],
    select: { id: true, kind: true, amount: true, description: true, date: true },
  });
  return rows.map((r) => ({
    id: r.id,
    vao: r.kind === "CUTOVER_ADJ_IN",
    soTien: r.amount,
    moTa: r.description,
    ngayNhan: format(r.date, "dd/MM/yyyy"),
  }));
}
