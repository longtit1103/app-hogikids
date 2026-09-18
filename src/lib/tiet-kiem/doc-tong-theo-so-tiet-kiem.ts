import { prisma } from "@/lib/prisma";

/**
 * Ba phép GOM TỔNG theo sổ tiết kiệm — tách khỏi `so-tiet-kiem-queries.ts` để mỗi file giữ một việc
 * (file kia dựng dòng bảng; file này chỉ đọc và cộng). Tất cả đều gom 1 LƯỢT ĐỌC cho MỌI sổ: gọi vị
 * từ trong vòng lặp là N+1 truy vấn.
 */

const KIND_GOC_VAY = ["LOAN_IN", "LOAN_REPAY"] as const;

export type DongSo = { tongDong: number; soGui: number; dangGui: number };


/**
 * Gom dòng tiền theo sổ. Lọc `savingsId: { not: null }` là đủ để lấy trọn `SAVINGS_*`: CHECK
 * `CashMovement_savings_dung_cho` dưới DB đã cấm mọi loại khác mang `savingsId`.
 */
export async function docDongTheoSo(): Promise<Map<string, DongSo>> {
  const nhom = await prisma.cashMovement.groupBy({
    by: ["savingsId", "kind"],
    where: { savingsId: { not: null } },
    _sum: { amount: true },
    _count: { _all: true },
  });
  const theoSo = new Map<string, DongSo>();
  for (const n of nhom) {
    if (n.savingsId === null) continue;
    const cu = theoSo.get(n.savingsId) ?? { tongDong: 0, soGui: 0, dangGui: 0 };
    const tien = n._sum.amount ?? 0;
    cu.tongDong += n._count._all;
    if (n.kind === "SAVINGS_OUT") {
      cu.soGui += n._count._all;
      cu.dangGui += tien;
    } else {
      cu.dangGui -= tien;
    }
    theoSo.set(n.savingsId, cu);
  }
  return theoSo;
}

/** Σ `ThuNhap.amount` theo sổ — lãi ĐÃ THỰC NHẬN, đường duy nhất lãi vào P&L. */
export async function docThuNhapTheoSo(): Promise<Map<string, number>> {
  const nhom = await prisma.thuNhap.groupBy({
    by: ["savingsId"],
    where: { savingsId: { not: null } },
    _sum: { amount: true },
  });
  const theoSo = new Map<string, number>();
  for (const n of nhom) {
    if (n.savingsId === null) continue;
    theoSo.set(n.savingsId, n._sum.amount ?? 0);
  }
  return theoSo;
}

/**
 * Dư nợ GỐC của các khoản vay được gắn làm nguồn = `duNoMoSo + Σ LOAN_IN − Σ LOAN_REPAY`, đúng công
 * thức của `khoan-vay-queries.ts`. Cần cho phép quy đổi lãi cố định ra %/năm (spec §6.3) — lấy
 * `duNoMoSo` không thôi là sai với khoản giải ngân qua dòng `LOAN_IN`.
 */
export async function docDuNoGoc(loanIds: string[]): Promise<Map<string, number>> {
  if (loanIds.length === 0) return new Map();
  const [loans, nhom] = await Promise.all([
    prisma.loan.findMany({ where: { id: { in: loanIds } }, select: { id: true, duNoMoSo: true } }),
    prisma.cashMovement.groupBy({
      by: ["loanId", "kind"],
      where: { loanId: { in: loanIds }, kind: { in: [...KIND_GOC_VAY] } },
      _sum: { amount: true },
    }),
  ]);
  const theoKhoan = new Map(loans.map((l) => [l.id, l.duNoMoSo]));
  for (const n of nhom) {
    if (n.loanId === null) continue;
    const dau = n.kind === "LOAN_IN" ? 1 : -1;
    theoKhoan.set(n.loanId, (theoKhoan.get(n.loanId) ?? 0) + dau * (n._sum.amount ?? 0));
  }
  return theoKhoan;
}
