import { differenceInCalendarDays, startOfDay } from "date-fns";

import { duNoTai, laiTheoNgay, type KhoanVayLich, type TraGoc } from "@/lib/so-quy/lich-tra-no";

/**
 * Đề xuất TẤT TOÁN thấu chi. THUẦN, không Prisma — tách khỏi `lich-tra-no.ts`
 * vì đây là một luồng riêng (đóng khoản), không phải lịch kỳ; phụ thuộc MỘT CHIỀU vào lịch kỳ nên
 * không có vòng import.
 *
 * `laiTheoNgay` phải nằm lại `lich-tra-no.ts`: chính `deXuatKy` gọi nó cho kỳ lãi thấu chi, đưa
 * sang đây là hai file gọi ngược nhau.
 */
export type DeXuatTatToan = {
  /** Mốc bắt đầu tính lãi = ngày rút, hoặc con dấu kỳ lãi đã thu nếu muộn hơn. */
  tuNgay: Date;
  soNgay: number;
  /** Toàn bộ dư nợ gốc còn lại tại ngày tất toán — KHOÁ, không phải đề xuất. */
  goc: number;
  /** Lãi từ `tuNgay` tới ngày tất toán — chỉ ĐỀ XUẤT, chủ shop sửa theo giấy báo ngân hàng. */
  lai: number;
};

/**
 * Tất toán = một kỳ cuối gộp: lãi phần chưa thu + TOÀN BỘ gốc còn lại.
 *
 * Mốc `tuNgay` kẹp theo con dấu `lastDueHandled` cùng lý do với `deXuatKy`: kỳ lãi đã duyệt thì
 * ngân hàng đã thu tới đó, tính lại từ ngày rút là thu lãi hai lần cùng những ngày ấy.
 */
export function deXuatTatToan(
  l: KhoanVayLich,
  traGoc: TraGoc[],
  lastDueHandled: Date | null,
  ngayTatToan: Date
): DeXuatTatToan {
  const den = startOfDay(ngayTatToan);
  const ngayRut = startOfDay(l.startDate);
  const conDau = lastDueHandled === null ? null : startOfDay(lastDueHandled);
  const tuNgay = conDau !== null && conDau > ngayRut ? conDau : ngayRut;
  return {
    tuNgay,
    soNgay: Math.max(0, differenceInCalendarDays(den, tuNgay)),
    // Kẹp ≥ 0: dư nợ âm (sổ ghi trả thừa) không được biến thành một dòng LOAN_REPAY âm.
    goc: Math.max(0, duNoTai(l, traGoc, den)),
    lai: laiTheoNgay(l, traGoc, tuNgay, den),
  };
}
