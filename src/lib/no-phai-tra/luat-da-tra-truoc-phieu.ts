import { format, startOfDay } from "date-fns";
import { z } from "zod";

import type { Prisma } from "@/generated/prisma/client";

import { formatVnd } from "@/lib/format";
import { ngayMoSo } from "@/lib/so-quy/so-quy-queries";

/**
 * Luật "đã trả trước" của một phiếu nợ (`PhieuNhapNo.daTraTruoc`) — spec §5.3 + §5.4 (phương án X/Y).
 * DÙNG CHUNG cho "Ghi nhận vào sổ nợ" và "Cập nhật đã trả trước" (`src/lib/actions/phieu-nhap-no.ts`);
 * hậu kiểm (`hauKiemPhieu`) dùng cùng `laPhieuTruocMoSo` để luật đọc và luật ghi không lệch nhau.
 *
 * Tách khỏi file action vì file `"use server"` chỉ được export hàm async.
 */

/** Lỗi nghiệp vụ hồ sơ phiếu nợ (câu đã tiếng Việt) — ném trong transaction để rollback trọn. */
export class LoiPhieu extends Error {
  constructor(
    message: string,
    readonly code?: string,
    readonly field?: string,
  ) {
    super(message);
    this.name = "LoiPhieu";
  }
}

/**
 * Phiếu TRƯỚC ngày mở sổ D0 ⇒ tiền đã trả nằm trong số dư mở sổ, app không có dòng nào để đọc ⇒ chủ
 * shop gõ tay được. Chưa mở sổ (D0 null) ⇒ KHÔNG coi là trước D0.
 */
export function laPhieuTruocMoSo(ngayPhieu: Date, d0: Date | null): boolean {
  return d0 !== null && startOfDay(ngayPhieu) < d0;
}

/**
 * Lý do lệch (phương án Y): trim, 3–300 ký tự. Rỗng / toàn khoảng trắng = không gửi (form để trống ô).
 */
export const lyDoLechSchema = z.preprocess(
  (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
  z
    .string({ error: "Lý do lệch không hợp lệ" })
    .trim()
    .min(3, "Lý do lệch tối thiểu 3 ký tự")
    .max(300, "Lý do lệch tối đa 300 ký tự")
    .optional(),
);

/** Nối lý do lệch vào ghi chú phiếu (không lặp lại khi gửi lại đúng lý do đang ở cuối). */
export function noiLyDoLech(noteCu: string, lyDo: string): string {
  if (noteCu === "") return lyDo;
  if (noteCu.endsWith(lyDo)) return noteCu;
  return `${noteCu}\n${lyDo}`;
}

/**
 * Kết quả luật: số `daTraTruoc` được ghi + (chỉ nhánh Y) lời giải thích lệch kèm số Sổ chi phí TẠI LÚC
 * giải thích — action ghi cả ba (`lechDaGiaiThich`, `lechDaGiaiThichSo`, `note`) trong CÙNG câu ghi.
 */
export type DaTraTruocChapNhan = {
  daTraTruoc: number;
  giaiThich: { soChiPhi: number; lyDo: string } | null;
};

/**
 * - Có dòng Sổ chi phí cùng `refId` (khoản "Nhập hàng" cũ đã trừ quỹ) ⇒ số nguồn = `amount` dòng đó.
 * - Không có dòng, phiếu TRƯỚC D0 ⇒ chủ shop gõ tự do (không có số nguồn để lệch).
 * - Không có dòng, phiếu từ D0 trở đi (hoặc chưa mở sổ) ⇒ số nguồn = 0: mọi đồng trả sau D0 phải có
 *   dòng tiền.
 * Gõ ĐÚNG số nguồn (hoặc không gõ) ⇒ nhận số nguồn (phương án X — ai có quyền ghi cũng được). Gõ KHÁC
 * số nguồn (phương án Y: giữ Expense T9 53,6, gõ 33,6 vì thực trả 33,6) ⇒ CHỈ chủ shop VÀ có lý do lệch;
 * thiếu một trong hai ⇒ từ chối, không âm thầm bỏ số người dùng gõ.
 */
export async function daTraTruocHopLe(
  db: Pick<Prisma.TransactionClient, "expense">,
  p: { refId: string; ngayPhieu: Date },
  daGo: number | undefined,
  y: { laChuShop: boolean; lyDoLech: string | undefined },
): Promise<DaTraTruocChapNhan> {
  const chiPhi = await db.expense.findUnique({ where: { refId: p.refId }, select: { amount: true } });
  let soNguon: number;
  let canhBao: string;
  if (chiPhi !== null) {
    soNguon = chiPhi.amount;
    canhBao = `Phiếu đã có dòng Sổ chi phí ${formatVnd(chiPhi.amount)} — đã trả trước phải đúng số đó`;
  } else {
    const d0 = await ngayMoSo();
    if (laPhieuTruocMoSo(p.ngayPhieu, d0)) return { daTraTruoc: daGo ?? 0, giaiThich: null };
    soNguon = 0;
    canhBao =
      d0 === null
        ? "Chưa mở sổ quỹ — phiếu không có dòng Sổ chi phí thì đã trả trước là 0"
        : `Chỉ phiếu trước ngày mở sổ (${format(d0, "dd/MM/yyyy")}) mới gõ được đã trả trước — khoản trả sau đó phải là dòng tiền`;
  }

  if (daGo === undefined || daGo === soNguon) return { daTraTruoc: soNguon, giaiThich: null };
  if (y.laChuShop && y.lyDoLech !== undefined) {
    return { daTraTruoc: daGo, giaiThich: { soChiPhi: soNguon, lyDo: y.lyDoLech } };
  }
  throw new LoiPhieu(`${canhBao}. Số khác chỉ chủ shop ghi được, kèm lý do lệch.`, undefined, "daTraTruoc");
}
