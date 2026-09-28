import { endOfDay } from "date-fns";

import {
  CASH_MOVEMENT_KIND_META,
  type CashDirection,
  type CashMovementKind,
} from "@/lib/cash-movements/cash-movement-kinds";
import { type DateRange } from "@/lib/date-range";
import { prisma } from "@/lib/prisma";

import type { CashMovementKind as PrismaCashMovementKind } from "@prisma/client";

/**
 * Query "khoản tiền khác" ghi tay (bảng `CashMovement`) cho tab Dòng tiền. Biên phải của kỳ luôn
 * `endOfDay(range.to)` — nhất quán `getExpenseSummary`/`calcPnl`. Trục DÒNG TIỀN thuần: chỉ
 * `cash-flow.ts` và tab Dòng tiền được import module này (lưới
 * `tests/unit/cash-movements/khong-ro-ri-vao-pnl.test.ts`).
 */

// Đồng bộ HAI CHIỀU giữa tuple thuần (cash-movement-kinds.ts) và enum Prisma: thêm/bớt một giá trị ở
// một bên mà quên bên kia là `tsc --noEmit` đỏ NGAY TẠI ĐÂY, không đợi tới lúc chạy.
type KhopEnumPrisma = [CashMovementKind] extends [PrismaCashMovementKind]
  ? [PrismaCashMovementKind] extends [CashMovementKind]
    ? true
    : never
  : never;
const khopEnumPrisma: KhopEnumPrisma = true;
void khopEnumPrisma;

export type CashMovementKindTotal = {
  kind: CashMovementKind;
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
  const grouped = await prisma.cashMovement.groupBy({
    by: ["kind"],
    where: trongKy(range),
    _sum: { amount: true },
  });

  const byKind: CashMovementKindTotal[] = grouped
    .map((g) => ({
      kind: g.kind,
      label: CASH_MOVEMENT_KIND_META[g.kind].label,
      direction: CASH_MOVEMENT_KIND_META[g.kind].direction,
      amount: g._sum.amount ?? 0,
    }))
    .filter((b) => b.amount > 0)
    .sort((a, b) => {
      if (a.direction !== b.direction) return a.direction === "IN" ? -1 : 1;
      return b.amount - a.amount;
    });

  const tong = (dir: CashDirection) =>
    byKind.filter((b) => b.direction === dir).reduce((s, b) => s + b.amount, 0);

  return { inTotal: tong("IN"), outTotal: tong("OUT"), byKind };
}

export type CashMovementRow = {
  id: string;
  date: Date;
  kind: CashMovementKind;
  amount: number;
  description: string;
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
};

/**
 * Dòng trong kỳ, mới nhất trước. KHÔNG phân trang (một tháng vài dòng — spec §4.3); vượt ~200 dòng/tháng
 * thì phân trang theo mẫu `getExpensesPage`.
 */
export async function listCashMovements(range: DateRange): Promise<CashMovementRow[]> {
  const rows = await prisma.cashMovement.findMany({
    where: trongKy(range),
    orderBy: [{ date: "desc" }, { createdAt: "desc" }],
    select: {
      id: true,
      date: true,
      kind: true,
      amount: true,
      description: true,
      loanId: true,
      loan: { select: { name: true } },
      savingsId: true,
      soTietKiem: { select: { name: true } },
    },
  });
  return rows.map(({ loan, soTietKiem, ...r }) => ({
    ...r,
    loanName: loan?.name ?? null,
    savingsName: soTietKiem?.name ?? null,
  }));
}
