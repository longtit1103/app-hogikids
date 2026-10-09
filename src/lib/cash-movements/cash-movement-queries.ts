import { endOfDay } from "date-fns";

import {
  CASH_MOVEMENT_KIND_META,
  chieuTien,
  type CashDirection,
  type CashMovementKindTatCa,
} from "@/lib/cash-movements/cash-movement-kinds";
import { type DateRange } from "@/lib/date-range";
import { prisma } from "@/lib/prisma";

import type { CashMovementKind as PrismaCashMovementKind } from "@/generated/prisma/client";

/**
 * Query "khoản tiền khác" ghi tay (bảng `CashMovement`) cho tab Dòng tiền. Biên phải của kỳ luôn
 * `endOfDay(range.to)` — nhất quán `getExpenseSummary`/`calcPnl`. Trục DÒNG TIỀN thuần: chỉ
 * `cash-flow.ts` và tab Dòng tiền được import module này (lưới
 * `tests/unit/cash-movements/khong-ro-ri-vao-pnl.test.ts`).
 */

// Đồng bộ HAI CHIỀU giữa tuple thuần ĐỦ 16 kind (cash-movement-kinds.ts) và enum Prisma: thêm/bớt một
// giá trị ở một bên mà quên bên kia là `tsc --noEmit` đỏ NGAY TẠI ĐÂY, không đợi tới lúc chạy.
// (Tuple 10 kind của form/action CỐ Ý nhỏ hơn enum — không so ở đây.)
type KhopEnumPrisma = [CashMovementKindTatCa] extends [PrismaCashMovementKind]
  ? [PrismaCashMovementKind] extends [CashMovementKindTatCa]
    ? true
    : never
  : never;
const khopEnumPrisma: KhopEnumPrisma = true;
void khopEnumPrisma;

export type CashMovementKindTotal = {
  kind: CashMovementKindTatCa;
  label: string;
  direction: CashDirection;
  amount: number;
};

export type CashMovementSummary = {
  /** Σ amount các loại chiều VÀO trong kỳ. */
  inTotal: number;
  /** Σ amount các loại chiều RA trong kỳ (số DƯƠNG — caller tự trừ). */
  outTotal: number;
  /** Chỉ loại có phát sinh; VÀO trước RA, trong mỗi chiều giảm dần theo tiền. */
  byKind: CashMovementKindTotal[];
};

function trongKy(range: DateRange) {
  return { date: { gte: range.from, lte: endOfDay(range.to) } };
}

export async function getCashMovementSummary(range: DateRange): Promise<CashMovementSummary> {
  // Nhóm theo CẢ `cardId`: chiều của `ADS_TOPUP` phụ thuộc dòng (nạp bằng thẻ ⇒ không chạm quỹ, bỏ
  // khỏi tổng vào/ra). Kind khác gộp lại về một mục theo kind như cũ.
  const grouped = await prisma.cashMovement.groupBy({
    by: ["kind", "cardId"],
    where: trongKy(range),
    _sum: { amount: true },
  });

  const theoKind = new Map<CashMovementKindTatCa, { direction: CashDirection; amount: number }>();
  for (const g of grouped) {
    const chieu = chieuTien(g.kind, { coCard: g.cardId !== null });
    if (chieu === "KHONG_QUY") continue;
    const cu = theoKind.get(g.kind);
    theoKind.set(g.kind, { direction: chieu, amount: (cu?.amount ?? 0) + (g._sum.amount ?? 0) });
  }

  const byKind: CashMovementKindTotal[] = [...theoKind]
    .map(([kind, v]) => ({ kind, label: CASH_MOVEMENT_KIND_META[kind].label, direction: v.direction, amount: v.amount }))
    .filter((b) => b.amount > 0)
    .sort((a, b) => {
      if (a.direction !== b.direction) return a.direction === "IN" ? -1 : 1;
      return b.amount - a.amount;
    });

  const tong = (dir: CashDirection) =>
    byKind.filter((b) => b.direction === dir).reduce((s, b) => s + b.amount, 0);

  return { inTotal: tong("IN"), outTotal: tong("OUT"), byKind };
}

/**
 * Dòng ghi tay KHÔNG mang liên kết khoản vay / sổ tiết kiệm — bản trả cho người thiếu
 * `tai-chinh-so-quy:xem` (khoản vay, sổ tiết kiệm thuộc khối Sổ quỹ). Loại dòng (`kind`) vẫn có: bảng
 * dòng tiền phải cộng được vào/ra, và "Trả nợ gốc" tự nó không nói nợ của ai, còn bao nhiêu.
 */
export type CashMovementRowCoBan = {
  id: string;
  date: Date;
  /** Đủ 16 kind — dòng nợ phải trả cũng hiện ở bảng, nhưng form/action thường KHÔNG sửa/xoá được nó. */
  kind: CashMovementKindTatCa;
  amount: number;
  description: string;
};

export type CashMovementRow = CashMovementRowCoBan & {
  /** Khoản vay dòng này thuộc về (chỉ `LOAN_IN`/`LOAN_REPAY`/`DEPOSIT_*` mới có). */
  loanId: string | null;
  /** Tên khoản vay để bảng hiện thẳng, khỏi bắt người đọc tra id. */
  loanName: string | null;
  /**
   * Sổ tiết kiệm sinh lãi dòng này thuộc về (chỉ `SAVINGS_OUT`/`SAVINGS_IN` mới có). Form SỬA đọc
   * đúng field này để prefill ô chọn sổ — thiếu nó thì mỗi lượt sửa là một lượt mất liên kết sổ.
   * KHÔNG BAO GIỜ khác null cùng lúc với `loanId` (CHECK `CashMovement_loan_savings_loai_tru`).
   */
  savingsId: string | null;
  /** Tên sổ để bảng hiện thẳng, cùng lý do với `loanName`. */
  savingsName: string | null;
  /**
   * Hồ sơ nợ phải trả (thẻ / phiếu nhập / ví ads) — form SỬA prefill đúng ô chọn từ đây, cùng lý do với
   * `savingsId`. Chỉ người có quyền Sổ quỹ mới nhận (id hồ sơ là chìa gọi thẳng action ghi nợ).
   */
  cardId: string | null;
  phieuNhapId: string | null;
  viAdsId: string | null;
  /** Tên hồ sơ nợ để bảng hiện dưới badge: tên thẻ · mã phiếu · nền tảng ví (null = không gắn). */
  tenHoSoNo: string | null;
};

/**
 * Dòng trong kỳ, mới nhất trước. KHÔNG phân trang (một tháng vài dòng — spec §4.3); vượt ~200 dòng/tháng
 * thì phân trang theo mẫu `getExpensesPage`.
 *
 * `coQuyenSoQuy = false` ⇒ KHÔNG select `loanId`/`savingsId` lẫn tên khoản vay/sổ (pick theo quyền,
 * không phải tải rồi ẩn): id khoản vay trong payload là chìa để gọi thẳng action ghi gốc vay.
 */
export async function listCashMovements(
  range: DateRange,
  quyen: { coQuyenSoQuy: true }
): Promise<CashMovementRow[]>;
export async function listCashMovements(
  range: DateRange,
  quyen: { coQuyenSoQuy: boolean }
): Promise<CashMovementRow[] | CashMovementRowCoBan[]>;
export async function listCashMovements(
  range: DateRange,
  quyen: { coQuyenSoQuy: boolean }
): Promise<CashMovementRow[] | CashMovementRowCoBan[]> {
  const coBan = { id: true, date: true, kind: true, amount: true, description: true } as const;
  const orderBy = [{ date: "desc" as const }, { createdAt: "desc" as const }];
  if (!quyen.coQuyenSoQuy) {
    return prisma.cashMovement.findMany({ where: trongKy(range), orderBy, select: coBan });
  }
  const rows = await prisma.cashMovement.findMany({
    where: trongKy(range),
    orderBy,
    select: {
      ...coBan,
      loanId: true,
      loan: { select: { name: true } },
      savingsId: true,
      soTietKiem: { select: { name: true } },
      cardId: true,
      theTinDung: { select: { ten: true } },
      phieuNhapId: true,
      phieuNhap: { select: { maPhieu: true } },
      viAdsId: true,
      viAds: { select: { nenTang: true } },
    },
  });
  return rows.map(({ loan, soTietKiem, theTinDung, phieuNhap, viAds, ...r }) => ({
    ...r,
    loanName: loan?.name ?? null,
    savingsName: soTietKiem?.name ?? null,
    // `ADS_TOPUP` nạp bằng thẻ mang cả ví lẫn thẻ — nối hai tên để bảng nói đủ "ví nào, thẻ nào".
    tenHoSoNo:
      [viAds?.nenTang, theTinDung?.ten, phieuNhap ? `phiếu ${phieuNhap.maPhieu}` : undefined]
        .filter((x): x is string => Boolean(x))
        .join(" · ") || null,
  }));
}
